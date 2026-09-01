import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { acquireSingleInstanceLock } from './runtime/single-instance-lock.ts';
import { ensurePrivateDirectory } from './lib/private-directory.ts';
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
import { IlinkListenerManager } from './ilink/listener.ts';
import { IlinkLoginManager } from './ilink/login-manager.ts';
import type { IlinkLoginStore } from './ilink/login-store.ts';
import { IlinkMediaGateway } from './ilink/media-gateway.ts';
import { renderIlinkQrPng } from './ilink/qr.ts';
import { DEFAULT_ILINK_MEDIA_TIMEOUT_MS } from './ilink/media.ts';
import { DEFAULT_ILINK_IMAGE_TIMEOUT_MS } from './ilink/inbound-image.ts';
import { IlinkClient } from './ilink/protocol/client.ts';
import { IlinkSecretBox } from './ilink/secret-box.ts';
import { assertIlinkAccountKey } from './ilink/store-types.ts';
import {
  ConversationMemoryExecutor,
  createConversationMemoryMcpServer,
} from './mcp/conversation-memory-server.ts';
import {
  StatePersistence,
  StatePersistenceUnclosedError,
} from './state/persistence.ts';
import type { AppConfig } from './config.ts';
import type { ChatChannel, Logger } from './types.ts';
import { KINTIO_VERSION } from './version.ts';

export interface Runtime {
  readonly messageProcessor: WecomSync | null;
  start(): Promise<void>;
  stopAccepting(): void;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function ilinkSecretGeneration(providerMessageId: string): number {
  return Number.parseInt(
    createHash('sha256').update(providerMessageId).digest('hex').slice(0, 12),
    16,
  );
}

function readOrCreatePrivateKey(filePath: string, label: string): string {
  const target = path.resolve(filePath);
  ensurePrivateDirectory(path.dirname(target));
  try {
    const existing = fs.readFileSync(target, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(existing)) {
      throw new Error(`${label} file is invalid`);
    }
    fs.chmodSync(target, 0o600);
    return existing;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const token = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(target, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return token;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return readOrCreatePrivateKey(target, label);
    }
    throw error;
  }
}

export async function createRuntime({
  config,
  logger = console,
}: {
  config: AppConfig;
  logger?: Logger;
}): Promise<Runtime> {
  if (
    (!config.wecom.api.enabled && !config.ilink.enabled) ||
    (!config.codex.enabled && !config.ilink.enabled)
  ) {
    logger.info('[runtime] message processing is disabled');
    return {
      messageProcessor: null,
      async start() {},
      stopAccepting() {},
      async close() {},
      async abort() {},
    };
  }

  const enabledChannels: readonly ChatChannel[] = [
    ...(config.wecom.api.enabled ? ['wechat_kf' as const] : []),
    ...(config.ilink.enabled ? ['weixin_ilink' as const] : []),
  ];

  const instanceLock = acquireSingleInstanceLock({
    filePath: config.state.lockFile,
    hasActiveDatabaseOwner: () =>
      StatePersistence.hasActiveWriter(config.state.databaseFile),
  });
  let persistence: StatePersistence | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let ilinkOffers: IlinkLoginStore | undefined;
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
        ilinkOffers?.cleanup();
      } catch (error) {
        logger.error(
          `[cleanup] SQLite retention failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, 60 * 60 * 1000);
    cleanupTimer.unref();
    const startupInbound = store.recoverStartup().inbound.filter((record) =>
      enabledChannels.includes(record.channel));
    const apiClient = config.wecom.api.enabled
      ? new WecomApiClient({
          corpId: config.wecom.api.corpId,
          kfSecret: config.wecom.api.kfSecret,
          baseUrl: config.wecom.api.baseUrl,
          timeoutMs: config.wecom.api.timeoutMs,
        })
      : undefined;
    const mediaGateway = apiClient ? new WecomMediaGateway({ apiClient }) : undefined;
    let ilinkLogin: IlinkLoginManager | undefined;
    let ilinkListener: IlinkListenerManager | undefined;
    let toolsUnavailable = false;
    const wechatTools = apiClient && mediaGateway
      ? new WechatKfToolExecutor({
          store,
          apiClient,
          mediaGateway,
          observeMs: config.wecom.api.observeMs,
          logger,
          ...(config.ilink.enabled ? {
            ilinkOffers: {
              async offer(sessionToken: string) {
                if (!ilinkLogin) throw new Error('iLink login manager is unavailable');
                const offered = await ilinkLogin.offer({
                  kind: 'wechat_kf',
                  sessionToken,
                });
                try {
                  return {
                    offerId: offered.offerId,
                    png: await renderIlinkQrPng(offered.qrContent),
                  };
                } catch (error) {
                  ilinkLogin.cancel(offered.offerId);
                  throw error;
                }
              },
              cancel(offerId: string) {
                ilinkLogin?.cancel(offerId);
              },
            },
          } : {}),
        })
      : undefined;
    const ilinkSecretBox = config.ilink.enabled
      ? new IlinkSecretBox(
          config.ilink.storageKey || readOrCreatePrivateKey(
            config.ilink.storageKeyFile,
            'iLink storage key',
          ),
        )
      : undefined;
    const ilinkStore = config.ilink.enabled
      ? activePersistence.createIlinkStore()
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
    const ilinkTools = ilinkStore && ilinkSecretBox
      ? new IlinkSendExecutor({
          store,
          ilinkStore,
          secretBox: ilinkSecretBox,
          createClient: ({ token, baseUrl }) => new IlinkClient({
            token, baseUrl, timeoutMs: config.ilink.apiTimeoutMs,
          }),
          ...(ilinkMedia ? { mediaGateway: ilinkMedia } : {}),
        })
      : undefined;
    if (ilinkStore && ilinkSecretBox) {
      ilinkOffers = activePersistence.createIlinkLoginStore({
        secretBox: ilinkSecretBox,
      });
      ilinkOffers.cleanup();
      ilinkLogin = new IlinkLoginManager({
        offers: ilinkOffers,
        accounts: ilinkStore,
        secretBox: ilinkSecretBox,
        maxAccounts: config.ilink.maxAccounts,
        logger,
        client: new IlinkClient({
          baseUrl: config.ilink.baseUrl,
          timeoutMs: config.ilink.apiTimeoutMs,
          longPollTimeoutMs: config.ilink.longPollTimeoutMs,
        }),
        onAccountsChanged: () => ilinkListener?.refresh(),
      });
    }
    const runtimeFile = fileURLToPath(import.meta.url);
    const relayFile = path.resolve(
      path.dirname(runtimeFile),
      '..',
      `mcp-relay${path.extname(runtimeFile)}`,
    );
    if (ilinkLogin) {
      const activeOperatorHost = new McpIpcHost({
        instanceKey: operatorMcpInstanceKey(config.state.lockFile),
        stateDirectory: path.dirname(config.state.lockFile),
        relayFile,
        memory: () => new McpServer({
          name: 'kintio-operator-isolation',
          version: KINTIO_VERSION,
        }),
        operator: () => createIlinkLoginMcpServer({
          begin: () => {
            if (toolsUnavailable) throw new Error('service unavailable');
            return ilinkLogin.offer({ kind: 'terminal' });
          },
          status: (offerId) => {
            if (toolsUnavailable) throw new Error('service unavailable');
            return ilinkLogin.status(offerId);
          },
          cancel: (offerId) => ilinkLogin.cancel(offerId),
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
            ilinkLogin?.close(),
            operatorMcpHost?.close(force),
          ]);
          if (cleanupTimer) clearInterval(cleanupTimer);
          try {
            activeStore.cleanup();
            ilinkOffers?.cleanup();
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
          started ||= ilinkLogin?.start() || Promise.resolve();
          return started;
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
      config.wecom.api.timeoutMs * 4 +
      config.wecom.api.observeMs +
      5_000
    ) / 1_000);
    const ilinkMcpToolTimeoutSec = Math.ceil((
      DEFAULT_ILINK_IMAGE_TIMEOUT_MS +
      DEFAULT_ILINK_MEDIA_TIMEOUT_MS +
      config.ilink.apiTimeoutMs +
      5_000
    ) / 1_000);
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
      allowedUserIds: config.wecom.allowedUserIds,
      authorization: config.wecom.authorization,
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
    ilinkListener = ilinkStore && ilinkSecretBox
      ? new IlinkListenerManager({
          logger,
          host: {
            listActiveRuntimeAccounts() {
              const accounts = ilinkStore.listActiveAccountsWithSecrets();
              if (accounts.length > config.ilink.maxAccounts) {
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
            timeoutMs: config.ilink.apiTimeoutMs,
            longPollTimeoutMs: config.ilink.longPollTimeoutMs,
          }),
        })
      : undefined;
    let starting: Promise<void> | undefined;
    let startupRecovery: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let accepting = true;
    let ilinkClosing: Promise<void> | undefined;
    let deferredDrain: Promise<void> | undefined;
    let deferredDrainRequested = false;
    const drainDeferred = async () => {
      while (!closing) {
        await sync?.waitForIdle();
        await processor.waitForIdle();
        const records = activeStore.activateNextDeferredConversation(enabledChannels);
        if (!records.length) return;
        await processor.recover(records, { priority: 'low' });
        await processor.waitForIdle();
      }
    };
    requestDeferredDrain = () => {
      if (closing) return;
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
        if (deferredDrainRequested && !closing) queueMicrotask(requestDeferredDrain);
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
          await ilinkLogin?.start();
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
            });
        })();
        return starting;
      },
      stopAccepting() {
        if (!accepting) return;
        accepting = false;
        sync?.stopAccepting();
        processor.stopAccepting();
        ilinkClosing ||= Promise.all([
          ilinkLogin?.close(),
          ilinkListener?.close(),
        ]).then(() => undefined);
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
                ilinkOffers?.cleanup();
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
