import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAdaptorServer, type ServerType } from '@hono/node-server';

import { createApp } from './app.ts';
import { installManagedSkill } from './runtime/managed-skill.ts';
import { samePath } from './lib/path-identity.ts';
import { ensurePrivateDirectory } from './lib/private-directory.ts';
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
import { KINTIO_PACKAGE_ROOT, loadConfig, type AppConfig, type SharedRuntimeConfig } from './config.ts';
import type { ChatChannel, Logger } from './types.ts';
import { KINTIO_VERSION } from './version.ts';

export interface Runtime {
  start(): Promise<void>;
  stopAcceptingIfIdle(): boolean;
  stopAccepting(): void;
  close(): Promise<void>;
  abort(): Promise<void>;
  wecomControl(action: 'start' | 'stop' | 'restart' | 'status', configFile?: string): Promise<{ running: boolean }>;
}

function ilinkSecretGeneration(providerMessageId: string): number {
  return Number.parseInt(
    createHash('sha256').update(providerMessageId).digest('hex').slice(0, 12),
    16,
  );
}

export async function createRuntime({
  config,
  logger = console,
  onStopRequested,
}: {
  config: SharedRuntimeConfig;
  logger?: Logger;
  onStopRequested?: () => void;
}): Promise<Runtime> {
  let wecom: AppConfig['wecom'] | undefined;
  let wecomConfig: AppConfig | undefined;
  const ilink = config.ilink;

  const enabledChannels = (): readonly ChatChannel[] => [
    ...(wecom?.api.enabled && wecomConfig?.codex.enabled ? ['wechat_kf' as const] : []),
    ...(config.codex.enabled ? ['weixin_ilink' as const] : []),
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
    ensurePrivateDirectory(config.codex.workingDirectory);
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
    const startupInbound = store.recoverStartup().inbound;
    let apiClient: WecomApiClient | undefined;
    let mediaGateway: WecomMediaGateway | undefined;
    let wecomServer: ServerType | undefined;
    let wecomChange: Promise<{ running: boolean }> | undefined;
    let wecomRecovery: Promise<void> | undefined;
    let ilinkListener: IlinkListenerManager | undefined;
    let ilinkRuntimeStarted = false;
    let toolsUnavailable = false;
    const ensureIlinkEnrollment = () => {
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
    const activeIlinkEnrollment = ensureIlinkEnrollment();
    const ilinkSecretBox = activeIlinkEnrollment.secretBox;
    const ilinkStore = activeIlinkEnrollment.accounts;
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
    const scheduleRuntimeStop = (
      enrollment: ReturnType<typeof ensureIlinkEnrollment>,
      runningCount: number,
    ): void => {
      if (runningCount !== 0 || wecomServer || wecomChange || terminalLoginActive() || !onStopRequested) return;
      const expectedEpoch = accountMutationEpoch;
      setImmediate(() => {
        if (
          toolsUnavailable ||
          wecomServer || wecomChange || terminalLoginActive() || activeAccountMutations > 0 ||
          expectedEpoch !== accountMutationEpoch ||
          enrollment.accounts.listRuntimeAccountsWithSecrets().length !== 0
        ) return;
        toolsUnavailable = true;
        onStopRequested();
      });
    };
    const terminalLoginActive = (): boolean =>
      terminalLoginBegins > 0 ||
      Boolean(ilinkEnrollment?.manager.hasActiveLocalOperatorLogin());
    let wechatTools: WechatKfToolExecutor | undefined;
    const recoveredIlinkReservations = ilinkStore.recoverPendingAttempts();
    if (recoveredIlinkReservations) {
      logger.info?.(
        `[recovery] released pending iLink sends=${recoveredIlinkReservations}`,
      );
    }
    const ilinkMedia = new IlinkMediaGateway({ store: ilinkStore, secretBox: ilinkSecretBox });
    const ilinkTools = new IlinkSendExecutor({
      store,
      ilinkStore,
      secretBox: ilinkSecretBox,
      createClient: ({ token, baseUrl }) => new IlinkClient({
        token, baseUrl, timeoutMs: ilink.apiTimeoutMs,
      }),
      mediaGateway: ilinkMedia,
    });
    const runtimeFile = fileURLToPath(import.meta.url);
    const relayFile = path.resolve(
      path.dirname(runtimeFile),
      '..',
      `mcp-relay${path.extname(runtimeFile)}`,
    );
    const activeOperatorHost = new McpIpcHost({
      instanceKey: operatorMcpInstanceKey(config.state.lockFile),
      stateDirectory: path.dirname(config.state.lockFile),
      relayFile,
      memory: () => new McpServer({
        name: 'kintio-operator-isolation',
        version: KINTIO_VERSION,
      }),
      operator: () => createIlinkLoginMcpServer({
        ...(config.codex.enabled ? { restartAccounts: () => runAccountMutation(async () => { await ilinkListener?.restart(); }) } : {}),
        wecomControl: (action, configFile) => changeWecom(action, configFile),
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
            if (!enabled) scheduleRuntimeStop(enrollment, runningCount);
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
            scheduleRuntimeStop(enrollment, runningCount);
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
    const channelDispatcher = {
      async kick(channel?: 'wechat_kf' | 'weixin_ilink'): Promise<void> {
        if (channel === 'wechat_kf') return wechatTools?.kick();
        if (channel === 'weixin_ilink') return;
        await wechatTools?.kick();
      },
      async notifyQueued(record: { readonly channel: string; readonly messageKey: string }) {
        if (record.channel === 'weixin_ilink') {
          await ilinkTools.notifyQueued(record.messageKey);
        }
      },
    };
    let conversationMemory: ConversationMemoryExecutor | undefined;
    const activeMcpHost = new McpIpcHost({
      instanceKey: config.state.lockFile,
      stateDirectory: path.dirname(config.state.lockFile),
      relayFile,
      wechatKf: () => createWechatKfMcpServer({
        execute(name, input) {
          if (toolsUnavailable || !wechatTools) throw new Error('WeCom is stopped');
          return wechatTools.execute(name, input);
        },
      }),
      memory: () => createConversationMemoryMcpServer({
        read(session) {
          if (toolsUnavailable || !conversationMemory) {
            throw new Error('service unavailable');
          }
          return conversationMemory.read(session);
        },
      }),
      ilink: () => createIlinkMcpServer({
        execute(name, input) {
          if (toolsUnavailable) throw new Error('service unavailable');
          return ilinkTools.execute(name, input);
        },
      }),
      logger,
    });
    mcpHost = activeMcpHost;
    const mcpLaunches = await activeMcpHost.start();
    // A singleton can be enabled later with the maximum supported API/observe timeouts.
    const mcpToolTimeoutSec = 505;
    const ilinkMcpToolTimeoutSec = Math.ceil((
      DEFAULT_ILINK_IMAGE_TIMEOUT_MS +
      DEFAULT_ILINK_MEDIA_TIMEOUT_MS +
      ilink.apiTimeoutMs +
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
      channelConfig: (channel) => channel === 'wechat_kf' && wecomConfig ? wecomConfig.codex : config.codex,
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
          if (message.conversation.channel === 'weixin_ilink') {
            return ilinkMedia.resolveForCodex(message);
          }
          return mediaGateway?.resolveForCodex(message) || Promise.resolve([]);
        },
      },
      agentAccess(identity) {
        if (identity.channel !== 'weixin_ilink') return 'restricted';
        try {
          assertIlinkAccountKey(identity.accountKey);
          return ilinkStore.getAccount(identity.accountKey)?.agentAccess === 'host'
            ? 'host'
            : 'restricted';
        } catch {
          return 'restricted';
        }
      },
      channel: channelDispatcher,
      allowedUserIds: [],
      logger,
    });
    let requestDeferredDrain = (): void => {};
    let sync: WecomSync | undefined;
    processor.setChannelEnabled('wechat_kf', false);

    async function closeWecom(): Promise<void> {
      const server = wecomServer;
      wecomServer = undefined;
      processor.setChannelEnabled('wechat_kf', false);
      wecom = undefined;
      sync?.stopAccepting();
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          (server as ServerType & { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      }
      await sync?.close();
      await wecomRecovery;
      await processor.waitForChannelIdle('wechat_kf');
      await wechatTools?.close();
      sync = undefined;
      wechatTools = undefined;
      mediaGateway = undefined;
      apiClient = undefined;
    }

    function changeWecom(action: 'start' | 'stop' | 'restart' | 'status', configFile?: string): Promise<{ running: boolean }> {
      if (action === 'status') return Promise.resolve({ running: Boolean(wecomServer?.listening) });
      const operation = (wecomChange?.catch(() => undefined) || Promise.resolve()).then(async () => {
        if (toolsUnavailable) throw new Error('Kintio runtime is stopping');
        const stored = store.getWecomRuntime();
        const file = configFile || stored.configFile || path.join(config.home, 'wecom/.env');
        if (action === 'stop' || action === 'restart') {
          store.setWecomRuntime(false, stored.configFile || file);
          await closeWecom();
        }
        if (action === 'stop') return { running: false };
        if (wecomServer?.listening) {
          if (configFile && !samePath(file, stored.configFile)) throw new Error('WeCom is already running with another config; stop it first');
          return { running: true };
        }
        if (!fs.existsSync(file)) throw new Error('WeCom config is missing; run "kintio wecom setup" first');
        const settings = loadConfig({ root: config.home, envFile: file, environment: { ...process.env, KINTIO_DB_FILE: config.state.databaseFile } });
        installManagedSkill({ packageRoot: KINTIO_PACKAGE_ROOT, workingDirectory: settings.codex.workingDirectory });
        if (!samePath(settings.codex.imageTempDirectory, config.codex.imageTempDirectory)) {
          cleanupStagedImageOrphans(settings.codex.imageTempDirectory);
        }
        wecomConfig = settings;
        wecom = settings.wecom;
        processor.configureWecom(wecom.allowedUserIds, wecom.authorization);
        if (wecom.api.enabled && settings.codex.enabled) {
          apiClient = new WecomApiClient({ corpId: wecom.api.corpId, kfSecret: wecom.api.kfSecret, baseUrl: wecom.api.baseUrl, timeoutMs: wecom.api.timeoutMs });
          mediaGateway = new WecomMediaGateway({ apiClient });
          wechatTools = new WechatKfToolExecutor({ store, apiClient, mediaGateway, observeMs: wecom.api.observeMs, logger });
          sync = new WecomSync({ apiClient, store, processor, logger, startPaused: true, onDeferredReady: () => queueMicrotask(requestDeferredDrain) });
        }
        const app = createApp({ config: settings, logger, messageProcessor: sync || null, acceptIngress: () => Boolean(wecomServer?.listening) && !toolsUnavailable });
        const server = createAdaptorServer({ fetch: app.fetch });
        wecomServer = server;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(settings.port, '0.0.0.0', () => { server.off('error', reject); resolve(); });
          });
          server.on('error', (error) => {
            logger.error(`[wecom] listener failed: ${error.message}`);
            void changeWecom('stop').catch(() => logger.error('[wecom] listener cleanup failed'));
          });
          store.setWecomRuntime(true, file);
          processor.setChannelEnabled('wechat_kf', Boolean(sync));
          const catchUp = sync?.catchUp();
          sync?.startConsuming();
          wecomRecovery = Promise.all([catchUp, ...(sync ? [processor.recover(store.listRecoverableInbound('wechat_kf'), { priority: 'low' })] : [])])
            .then(() => { requestDeferredDrain(); })
            .catch((error: unknown) => logger.error(`[wecom] recovery failed: ${String(error)}`))
            .finally(() => { wecomRecovery = undefined; });
          logger.info(`Hono server is listening on port ${settings.port}`);
          return { running: true };
        } catch (error) {
          await closeWecom();
          throw error;
        }
      });
      const tracked = operation.finally(() => {
        if (wecomChange === tracked) wecomChange = undefined;
        if (ilinkEnrollment) scheduleRuntimeStop(ilinkEnrollment, ilinkEnrollment.accounts.listRuntimeAccountsWithSecrets().length);
      });
      wecomChange = tracked;
      return tracked;
    }
    ilinkListener = config.codex.enabled
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
        const records = activeStore.activateNextDeferredConversation(enabledChannels());
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
      wecomControl: changeWecom,
      start(): Promise<void> {
        if (!accepting) return Promise.reject(new Error('Kintio runtime is stopping'));
        starting ||= (async () => {
          const recovery = processor.recover(
            startupInbound.filter((record) => enabledChannels().includes(record.channel)),
            { priority: 'low' },
          );
          await ilinkListener?.start();
          ilinkRuntimeStarted = true;
          await startIlinkEnrollment();
          if (store.getWecomRuntime().enabled) {
            await changeWecom('start').catch(() => {
              logger.error('[wecom] listener could not be restored; run "kintio wecom start" to inspect its configuration or callback port');
            });
          }
          startupRecoveryActive = true;
          startupRecovery = recovery
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
          activeAccountMutations > 0 || wecomChange || wecomRecovery ||
          !ilinkTools.isIdle() ||
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
            await wecomChange?.catch(() => undefined);
            await closeWecom();
            await ilinkClosing;
            await processor.close();
          } finally {
            toolsUnavailable = true;
            await Promise.allSettled([
              ilinkTools.waitForIdle(),
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
        if (wecomServer) {
          const server = wecomServer;
          wecomServer = undefined;
          server.close();
          (server as ServerType & { closeAllConnections?: () => void }).closeAllConnections?.();
        }
        await Promise.all([
          processor.abort(),
          ilinkClosing,
          activeMcpHost.close(true),
          operatorMcpHost?.close(true),
        ]);
      },
    };
    // Publish operator control only after all channel lifecycle state exists.
    await operatorMcpHost?.start();
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
