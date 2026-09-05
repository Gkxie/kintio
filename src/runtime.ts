import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { acquireSingleInstanceLock } from './runtime/single-instance-lock.ts';
import { CodexAgent, createCodexAppServer } from './services/codex-agent.ts';
import { ConversationProcessor } from './services/conversation-processor.ts';
import { cleanupStagedImageOrphans } from './services/image-stager.ts';
import { WecomMediaGateway } from './services/media-gateway.ts';
import { WecomApiClient } from './services/wecom-api.ts';
import { WecomSync } from './services/wecom-sync.ts';
import { WechatKfToolExecutor } from './mcp/wechat-kf-executor.ts';
import { createWechatKfMcpServer } from './mcp/wechat-kf-server.ts';
import { createIlinkMcpServer } from './mcp/ilink-server.ts';
import { createIlinkLoginMcpServer } from './mcp/ilink-login-server.ts';
import { McpIpcHost } from './mcp/ipc-host.ts';
import { operatorMcpInstanceKey } from './mcp/ipc-protocol.ts';
import { IlinkSendExecutor } from './ilink/executor.ts';
import { createIlinkEnrollmentService } from './ilink/enrollment.ts';
import { IlinkListenerManager } from './ilink/listener.ts';
import { IlinkMediaGateway } from './ilink/media-gateway.ts';
import type { IlinkAccountWithSecret } from './ilink/sqlite-store.ts';
import { DEFAULT_ILINK_MEDIA_TIMEOUT_MS } from './ilink/media.ts';
import { DEFAULT_ILINK_IMAGE_TIMEOUT_MS } from './ilink/inbound-image.ts';
import { IlinkClient } from './ilink/protocol/client.ts';
import {
  assertIlinkAccountKey,
  assertIlinkAccountRevision,
  createIlinkAccountIncarnation,
} from './ilink/store-types.ts';
import {
  ConversationMemoryExecutor,
  createConversationMemoryMcpServer,
} from './mcp/conversation-memory-server.ts';
import {
  StatePersistence,
  StatePersistenceUnclosedError,
} from './state/persistence.ts';
import type { AppConfig, IlinkRuntimeConfig } from './config.ts';
import type { ChatChannel, Logger } from './types.ts';
import { KINTIO_VERSION } from './version.ts';

export interface Runtime {
  readonly messageProcessor: WecomSync | null;
  start(): Promise<void>;
  stopAcceptingIfIdle(): boolean;
  stopAccepting(): void;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type RuntimeConfig = AppConfig | IlinkRuntimeConfig;

function ilinkSecretGeneration(providerMessageId: string): number {
  return Number.parseInt(
    createHash('sha256').update(providerMessageId).digest('hex').slice(0, 12),
    16,
  );
}

export async function createRuntime({
  config,
  logger = console,
  onIlinkStopRequested,
}: {
  config: RuntimeConfig;
  logger?: Logger;
  onIlinkStopRequested?: () => void;
}): Promise<Runtime> {
  const wecom = 'wecom' in config ? config.wecom : undefined;
  const ilink = 'ilink' in config ? config.ilink : undefined;
  if (wecom && ilink) throw new Error('Each runtime must own exactly one channel');
  if (
    (!wecom?.api.enabled && !ilink) ||
    (!config.codex.enabled && !ilink)
  ) {
    logger.info('[runtime] message processing is disabled');
    let accepting = true;
    return {
      messageProcessor: null,
      async start() {
        if (!accepting) throw new Error('Kintio runtime is stopping');
      },
      stopAcceptingIfIdle() {
        if (!accepting) return false;
        accepting = false;
        return true;
      },
      stopAccepting() { accepting = false; },
      async close() {},
      async abort() {},
    };
  }

  const enabledChannels: readonly ChatChannel[] = [
    ...(wecom?.api.enabled ? ['wechat_kf' as const] : []),
    ...(ilink ? ['weixin_ilink' as const] : []),
  ];

  const instanceLock = acquireSingleInstanceLock({
    filePath: config.state.lockFile,
    hasActiveDatabaseOwner: () =>
      StatePersistence.hasActiveWriter(config.state.databaseFile),
  });
  let persistence: StatePersistence | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let ilinkEnrollment: ReturnType<typeof createIlinkEnrollmentService> | undefined;
  let ilinkEnrollmentStart: Promise<void> | undefined;
  let mcpHost: McpIpcHost | undefined;
  let operatorMcpHost: McpIpcHost | undefined;

  try {
    persistence = new StatePersistence({ filePath: config.state.databaseFile });
    const activePersistence = persistence;
    const store = activePersistence.core;
    const activeStore = store;
    store.cleanup();
    cleanupStagedImageOrphans(config.codex.imageTempDirectory);
    cleanupTimer = setInterval(() => {
      try {
        activeStore.cleanup();
        ilinkEnrollment?.offers.cleanup();
      } catch (error) {
        logger.error(
          `[cleanup] SQLite retention failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, 60 * 60 * 1000);
    cleanupTimer.unref();
    const startupInbound = store.recoverStartup().inbound.filter((record) =>
      enabledChannels.includes(record.channel));
    const apiClient = wecom?.api.enabled
      ? new WecomApiClient({
          corpId: wecom.api.corpId,
          kfSecret: wecom.api.kfSecret,
          baseUrl: wecom.api.baseUrl,
          timeoutMs: wecom.api.timeoutMs,
        })
      : undefined;
    const mediaGateway = apiClient ? new WecomMediaGateway({ apiClient }) : undefined;
    let ilinkListener: IlinkListenerManager | undefined;
    let ilinkRuntimeStarted = false;
    let toolsUnavailable = false;
    const ensureIlinkEnrollment = () => {
      if (!ilink) throw new Error('iLink is not part of the WeCom runtime');
      ilinkEnrollment ||= createIlinkEnrollmentService({
        persistence: activePersistence,
        config: ilink,
        logger,
        onAccountsChanged: () => ilinkListener?.refresh(),
      });
      return ilinkEnrollment;
    };
    const startIlinkEnrollment = async () => {
      const enrollment = ensureIlinkEnrollment();
      ilinkEnrollmentStart ||= enrollment.manager.start();
      await ilinkEnrollmentStart;
      return enrollment;
    };
    const activeIlinkEnrollment = ilink ? ensureIlinkEnrollment() : undefined;
    const ilinkSecretBox = activeIlinkEnrollment?.secretBox;
    const ilinkStore = activeIlinkEnrollment?.accounts;
    let terminalLoginBegins = 0;
    let accountMutationEpoch = 0;
    let activeAccountMutations = 0;
    const runAccountMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (toolsUnavailable) throw new Error('service unavailable');
      activeAccountMutations += 1;
      try {
        return await operation();
      } finally {
        activeAccountMutations -= 1;
      }
    };
    const operatorAccount = ({ account, secret }: IlinkAccountWithSecret) => ({
      accountKey: account.accountKey,
      generation: account.generation,
      incarnation: createIlinkAccountIncarnation(account, secret),
      providerAccountId: account.providerAccountId,
      runtimeEnabled: account.runtimeEnabled,
    });
    const scheduleIlinkStop = (
      enrollment: ReturnType<typeof ensureIlinkEnrollment>,
      runningCount: number,
    ): void => {
      if (runningCount !== 0 || !onIlinkStopRequested) return;
      const expectedEpoch = accountMutationEpoch;
      setImmediate(() => {
        if (
          toolsUnavailable ||
          expectedEpoch !== accountMutationEpoch ||
          enrollment.accounts.listRuntimeAccountsWithSecrets().length !== 0
        ) return;
        toolsUnavailable = true;
        onIlinkStopRequested();
      });
    };
    const terminalLoginActive = (): boolean =>
      terminalLoginBegins > 0 ||
      Boolean(ilinkEnrollment?.manager.hasActiveLocalOperatorLogin());
    const wechatTools = apiClient && mediaGateway
      ? new WechatKfToolExecutor({
          store,
          apiClient,
          mediaGateway,
          observeMs: wecom?.api.observeMs || 5_000,
          logger,
        })
      : undefined;
    const recoveredIlinkReservations = ilinkStore?.recoverPendingAttempts() || 0;
    if (recoveredIlinkReservations) {
      logger.info?.(
        `[recovery] released pending iLink sends=${recoveredIlinkReservations}`,
      );
    }
    const ilinkMedia = ilinkStore && ilinkSecretBox
      ? new IlinkMediaGateway({ store: ilinkStore, secretBox: ilinkSecretBox })
      : undefined;
    const ilinkTools = ilink && ilinkStore && ilinkSecretBox
      ? new IlinkSendExecutor({
          store,
          ilinkStore,
          secretBox: ilinkSecretBox,
          createClient: ({ token, baseUrl }) => new IlinkClient({
            token, baseUrl, timeoutMs: ilink.apiTimeoutMs,
          }),
          ...(ilinkMedia ? { mediaGateway: ilinkMedia } : {}),
        })
      : undefined;
    const runtimeFile = fileURLToPath(import.meta.url);
    const relayFile = path.resolve(
      path.dirname(runtimeFile),
      '..',
      `mcp-relay${path.extname(runtimeFile)}`,
    );
    if (ilink) {
      const activeOperatorHost = new McpIpcHost({
        instanceKey: operatorMcpInstanceKey(config.state.lockFile),
        stateDirectory: path.dirname(config.state.lockFile),
        relayFile,
        memory: () => new McpServer({
          name: 'kintio-operator-isolation',
          version: KINTIO_VERSION,
        }),
        operator: () => createIlinkLoginMcpServer({
          async begin(signal) {
            if (toolsUnavailable) throw new Error('service unavailable');
            terminalLoginBegins += 1;
            try {
              const offer = await (await startIlinkEnrollment()).manager.offer(
                { kind: 'terminal' },
                signal ? { signal } : {},
              );
              return offer;
            } finally {
              terminalLoginBegins -= 1;
            }
          },
          status(offerId) {
            if (toolsUnavailable) throw new Error('service unavailable');
            const result = ensureIlinkEnrollment().manager.status(offerId);
            return result;
          },
          cancel(offerId) {
            return ilinkEnrollment?.manager.cancel(offerId) || false;
          },
          listAccounts: () => ensureIlinkEnrollment().accounts
            .listActiveAccountsWithSecrets()
            .map(operatorAccount),
          setAccountRuntime(accountKey, enabled, expected) {
            return runAccountMutation(async () => {
              const enrollment = ensureIlinkEnrollment();
              assertIlinkAccountKey(accountKey);
              const stored = enrollment.accounts.getAccountWithSecret(accountKey);
              assertIlinkAccountRevision(stored ? operatorAccount(stored) : undefined, expected);
              const account = enrollment.accounts.setRuntimeEnabled(accountKey, enabled);
              if (ilinkRuntimeStarted) await ilinkListener?.refresh();
              const runningCount = enrollment.accounts
                .listRuntimeAccountsWithSecrets().length;
              accountMutationEpoch += 1;
              if (!enabled) scheduleIlinkStop(enrollment, runningCount);
              return {
                account: operatorAccount({ account, secret: stored!.secret }),
                runningCount,
              };
            });
          },
          deleteAccount(accountKey, expected) {
            return runAccountMutation(async () => {
              const enrollment = ensureIlinkEnrollment();
              assertIlinkAccountKey(accountKey);
              const stored = enrollment.accounts.getAccountWithSecret(accountKey);
              assertIlinkAccountRevision(stored ? operatorAccount(stored) : undefined, expected);
              const account = enrollment.accounts.deleteAccountCompletely(accountKey);
              if (ilinkRuntimeStarted) await ilinkListener?.refresh();
              const runningCount = enrollment.accounts
                .listRuntimeAccountsWithSecrets().length;
              accountMutationEpoch += 1;
              scheduleIlinkStop(enrollment, runningCount);
              return {
                account: operatorAccount({ account, secret: stored!.secret }),
                runningCount,
              };
            });
          },
        }),
        logger,
      });
      operatorMcpHost = activeOperatorHost;
      await activeOperatorHost.start();
    }
    if (!config.codex.enabled) {
      logger.info('[runtime] Agent processing is disabled; iLink enrollment remains available');
      let started: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      let accepting = true;
      const close = (force = false): Promise<void> => {
        closing ||= (async () => {
          accepting = false;
          toolsUnavailable = true;
          await Promise.allSettled([
            ilinkEnrollment?.manager.close(),
            operatorMcpHost?.close(force),
          ]);
          if (cleanupTimer) clearInterval(cleanupTimer);
          try {
            activeStore.cleanup();
            ilinkEnrollment?.offers.cleanup();
            activeStore.checkpoint('TRUNCATE');
          } finally {
            try {
              activePersistence.close();
            } finally {
              if (activePersistence.closed) instanceLock.release();
            }
          }
        })();
        return closing;
      };
      return {
        messageProcessor: null,
        start() {
          if (!accepting) return Promise.reject(new Error('Kintio runtime is stopping'));
          started ||= startIlinkEnrollment().then(() => undefined);
          return started;
        },
        stopAcceptingIfIdle() {
          if (!accepting || terminalLoginActive() || activeAccountMutations > 0) return false;
          accepting = false;
          toolsUnavailable = true;
          return true;
        },
        stopAccepting() {
          accepting = false;
          toolsUnavailable = true;
        },
        close: () => close(),
        abort: () => close(true),
      };
    }
    const channelDispatcher = {
      async kick(channel?: 'wechat_kf' | 'weixin_ilink'): Promise<void> {
        if (channel === 'wechat_kf') return wechatTools?.kick();
        if (channel === 'weixin_ilink') return;
        await wechatTools?.kick();
      },
      async notifyQueued(record: { readonly channel: string; readonly messageKey: string }) {
        if (record.channel === 'weixin_ilink' && ilinkTools) {
          await ilinkTools.notifyQueued(record.messageKey);
        }
      },
    };
    let conversationMemory: ConversationMemoryExecutor | undefined;
    const activeMcpHost = new McpIpcHost({
      instanceKey: config.state.lockFile,
      stateDirectory: path.dirname(config.state.lockFile),
      relayFile,
      ...(wechatTools ? {
        wechatKf: () => createWechatKfMcpServer({
          execute(name, input) {
            if (toolsUnavailable) throw new Error('service unavailable');
            return wechatTools.execute(name, input);
          },
        }),
      } : {}),
      memory: () => createConversationMemoryMcpServer({
        read(session) {
          if (toolsUnavailable || !conversationMemory) {
            throw new Error('service unavailable');
          }
          return conversationMemory.read(session);
        },
      }),
      ...(ilinkTools ? {
        ilink: () => createIlinkMcpServer({
          execute(name, input) {
            if (toolsUnavailable) throw new Error('service unavailable');
            return ilinkTools.execute(name, input);
          },
        }),
      } : {}),
      logger,
    });
    mcpHost = activeMcpHost;
    const mcpLaunches = await activeMcpHost.start();
    const mcpToolTimeoutSec = Math.ceil((
      (wecom?.api.timeoutMs || 10_000) * 4 +
      (wecom?.api.observeMs || 5_000) +
      5_000
    ) / 1_000);
    const ilinkMcpToolTimeoutSec = ilink ? Math.ceil((
      DEFAULT_ILINK_IMAGE_TIMEOUT_MS +
      DEFAULT_ILINK_MEDIA_TIMEOUT_MS +
      ilink.apiTimeoutMs +
      5_000
    ) / 1_000) : 0;
    const codex = createCodexAppServer({
      logger,
      mcpLaunches,
      mcpToolTimeoutSec,
      ilinkMcpToolTimeoutSec,
    });
    const trustedCodex = createCodexAppServer({
      logger,
      mcpLaunches,
      mcpToolTimeoutSec,
      ilinkMcpToolTimeoutSec,
      agentAccess: 'host',
    });
    const codexAgent = new CodexAgent({
      codex,
      trustedCodex,
      config: config.codex,
    });
    conversationMemory = new ConversationMemoryExecutor({
      store,
      threads: codex,
    });
    const processor = new ConversationProcessor({
      store,
      agent: codexAgent,
      mediaGateway: {
        resolveForCodex(message) {
          if (message.conversation.channel === 'weixin_ilink' && ilinkMedia) {
            return ilinkMedia.resolveForCodex(message);
          }
          return mediaGateway?.resolveForCodex(message) || Promise.resolve([]);
        },
      },
      agentAccess(identity) {
        if (identity.channel !== 'weixin_ilink') return 'restricted';
        try {
          assertIlinkAccountKey(identity.accountKey);
          return ilinkStore?.getAccount(identity.accountKey)?.agentAccess === 'host'
            ? 'host'
            : 'restricted';
        } catch {
          return 'restricted';
        }
      },
      channel: channelDispatcher,
      allowedUserIds: wecom?.allowedUserIds || [],
      ...(wecom ? { authorization: wecom.authorization } : {}),
      logger,
    });
    let requestDeferredDrain = (): void => {};
    const sync = apiClient
      ? new WecomSync({
          apiClient,
          store,
          processor,
          logger,
          startPaused: true,
          onDeferredReady() {
            queueMicrotask(requestDeferredDrain);
          },
        })
      : undefined;
    ilinkListener = ilink && ilinkStore && ilinkSecretBox
      ? new IlinkListenerManager({
          logger,
          host: {
            listActiveRuntimeAccounts() {
              const accounts = ilinkStore.listRuntimeAccountsWithSecrets();
              if (accounts.length > ilink.maxAccounts) {
                throw new Error('Active iLink account count exceeds configured limit');
              }
              return accounts.map(({ account, secret }) => ({
                accountKey: account.accountKey,
                providerAccountId: account.providerAccountId,
                ownerPeerId: account.ownerPeerId,
                generation: account.generation,
                cursor: ilinkStore.getCursor(account.accountKey)?.cursor || '',
                botToken: ilinkSecretBox.open(secret.sealedBotToken, {
                  secretKind: 'bot_token',
                  accountId: account.accountKey,
                  peerId: account.ownerPeerId,
                  generation: account.generation,
                }),
                baseUrl: account.baseUrl,
              }));
            },
            commitPage(input) {
              const committed = ilinkStore.commitPollPage({
                accountKey: input.accountKey,
                expectedGeneration: input.expectedGeneration,
                expectedCursor: input.expectedCursor,
                nextCursor: input.nextCursor,
                deferredBefore: input.deferredBefore,
                messages: input.messages.map(({ message, facts }) => {
                  const { accountKey, peerId } = message.conversation;
                  const secretGeneration = ilinkSecretGeneration(
                    message.providerMessageId,
                  );
                  return {
                    message,
                    ...(facts.providerSeq === undefined
                      ? {}
                      : { providerSeq: facts.providerSeq }),
                    secretGeneration,
                    sealedContextToken: ilinkSecretBox.seal(
                      facts.contextToken,
                      {
                        secretKind: 'context_token',
                        accountId: accountKey,
                        peerId,
                        generation: secretGeneration,
                      },
                    ),
                    sealedImages: facts.images.map((image) => {
                      const imageGeneration = ilinkSecretGeneration(
                        `${message.providerMessageId}:image:${image.position}`,
                      );
                      return {
                        position: image.position,
                        secretGeneration: imageGeneration,
                        sealedLocator: ilinkSecretBox.seal(
                          JSON.stringify({
                            downloadUrl: image.downloadUrl,
                            aesKey: image.aesKey,
                          }),
                          {
                            secretKind: 'media_locator',
                            accountId: accountKey,
                            peerId,
                            generation: imageGeneration,
                          },
                        ),
                      };
                    }),
                  };
                }),
              });
              return committed;
            },
            backlogReady() {
              queueMicrotask(requestDeferredDrain);
            },
            enqueue(messageKeys) {
              for (const key of messageKeys) void processor.enqueue(key);
            },
          },
          createClient: (account) => new IlinkClient({
            token: account.botToken,
            baseUrl: account.baseUrl,
            timeoutMs: ilink.apiTimeoutMs,
            longPollTimeoutMs: ilink.longPollTimeoutMs,
          }),
        })
      : undefined;
    let starting: Promise<void> | undefined;
    let startupRecovery: Promise<void> | undefined;
    let startupRecoveryActive = false;
    let closing: Promise<void> | undefined;
    let accepting = true;
    let ilinkClosing: Promise<void> | undefined;
    let deferredDrain: Promise<void> | undefined;
    let deferredDrainRequested = false;
    const drainDeferred = async () => {
      while (!closing && accepting) {
        await sync?.waitForIdle();
        await processor.waitForIdle();
        const records = activeStore.activateNextDeferredConversation(enabledChannels);
        if (!records.length) return;
        await processor.recover(records, { priority: 'low' });
        await processor.waitForIdle();
      }
    };
    requestDeferredDrain = () => {
      if (closing || !accepting) return;
      deferredDrainRequested = true;
      if (deferredDrain) return;
      deferredDrain = (async () => {
        do {
          deferredDrainRequested = false;
          await drainDeferred();
        } while (deferredDrainRequested && !closing);
      })().catch((error: unknown) => {
        logger.error(
          `[recovery] deferred backlog failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }).finally(() => {
        deferredDrain = undefined;
        if (deferredDrainRequested && !closing && accepting) {
          queueMicrotask(requestDeferredDrain);
        }
      });
    };
    const runtime = {
      messageProcessor: sync || null,
      start(): Promise<void> {
        if (!accepting) return Promise.reject(new Error('Kintio runtime is stopping'));
        starting ||= (async () => {
          const catchUp = sync?.catchUp() || Promise.resolve();
          const recovery = processor.recover(
            startupInbound,
            { priority: 'low' },
          );
          sync?.startConsuming();
          await ilinkListener?.start();
          ilinkRuntimeStarted = true;
          if (ilink) await startIlinkEnrollment();
          startupRecoveryActive = true;
          startupRecovery = Promise.all([catchUp, recovery])
            .then(async () => {
              await channelDispatcher.kick();
              if (!ilinkListener) requestDeferredDrain();
            })
            .catch((error: unknown) => {
              logger.error(
                `[recovery] startup backlog failed: ${
                  error instanceof Error ? error.message : String(error)
                  }`,
              );
            }).finally(() => {
              startupRecoveryActive = false;
            });
        })();
        return starting;
      },
      stopAcceptingIfIdle() {
        if (
          !accepting || startupRecoveryActive || deferredDrainRequested ||
          deferredDrain !== undefined || !processor.isIdle() ||
          terminalLoginActive() ||
          activeAccountMutations > 0 ||
          Boolean(ilinkTools && !ilinkTools.isIdle()) ||
          Boolean(wechatTools && !wechatTools.isIdle())
        ) return false;
        runtime.stopAccepting();
        return true;
      },
      stopAccepting() {
        if (!accepting) return;
        accepting = false;
        toolsUnavailable = true;
        sync?.stopAccepting();
        processor.stopAccepting();
        ilinkClosing ||= Promise.all([
          ilinkEnrollment?.manager.close(),
          ilinkListener?.close(),
        ]).then(() => undefined);
        ilinkRuntimeStarted = false;
      },
      close(): Promise<void> {
        if (closing) return closing;
        runtime.stopAccepting();
        closing = (async () => {
          try {
            await starting?.catch(() => undefined);
            await startupRecovery?.catch(() => undefined);
            await deferredDrain?.catch(() => undefined);
            await sync?.close();
            await ilinkClosing;
            await processor.close();
          } finally {
            toolsUnavailable = true;
            await Promise.allSettled([
              ilinkTools?.waitForIdle(),
              wechatTools?.close(),
            ]);
            try {
              await Promise.all([
                activeMcpHost.close(),
                operatorMcpHost?.close(),
              ]);
            } finally {
              if (cleanupTimer) clearInterval(cleanupTimer);
              try {
                activeStore.cleanup();
                ilinkEnrollment?.offers.cleanup();
                activeStore.checkpoint('TRUNCATE');
              } finally {
                try {
                  activePersistence.close();
                } finally {
                  if (activePersistence.closed) instanceLock.release();
                }
              }
            }
          }
        })();
        return closing;
      },
      async abort(): Promise<void> {
        runtime.stopAccepting();
        toolsUnavailable = true;
        wechatTools?.abort();
        await Promise.all([
          processor.abort(),
          ilinkClosing,
          activeMcpHost.close(true),
          operatorMcpHost?.close(true),
        ]);
      },
    };
    return runtime;
  } catch (error: unknown) {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await Promise.allSettled([
      mcpHost?.close(true),
      operatorMcpHost?.close(true),
    ]);
    let persistenceClosed = persistence === undefined &&
      !(error instanceof StatePersistenceUnclosedError);
    try {
      persistence?.close();
      persistenceClosed = true;
    } catch (cleanupError: unknown) {
      logger.error(
        `[runtime] startup cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    } finally {
      if (persistence?.closed || persistenceClosed) instanceLock.release();
    }
    throw error;
  }
}
