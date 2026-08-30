import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { acquireSingleInstanceLock } from './runtime/single-instance-lock.ts';
import { ensurePrivateDirectory } from './lib/private-directory.ts';
import { CodexAgent, createCodexAppServer } from './services/codex-agent.ts';
import { ConversationProcessor } from './services/conversation-processor.ts';
import { cleanupStagedImageOrphans } from './services/image-stager.ts';
import { WecomMediaGateway } from './services/media-gateway.ts';
import { WecomApiClient } from './services/wecom-api.ts';
import { WecomSync } from './services/wecom-sync.ts';
import { WechatKfToolExecutor } from './mcp/wechat-kf-executor.ts';
import { handleWechatKfMcpRequest } from './mcp/wechat-kf-server.ts';
import { handleIlinkMcpRequest } from './mcp/ilink-server.ts';
import { IlinkSendExecutor } from './ilink/executor.ts';
import { IlinkListenerManager } from './ilink/listener.ts';
import { IlinkLoginManager } from './ilink/login-manager.ts';
import { IlinkLoginStore } from './ilink/login-store.ts';
import { IlinkMediaGateway } from './ilink/media-gateway.ts';
import { DEFAULT_ILINK_MEDIA_TIMEOUT_MS } from './ilink/media.ts';
import { DEFAULT_ILINK_IMAGE_TIMEOUT_MS } from './ilink/inbound-image.ts';
import { IlinkClient } from './ilink/protocol/client.ts';
import { IlinkSecretBox } from './ilink/secret-box.ts';
import { IlinkSqliteStore } from './ilink/sqlite-store.ts';
import {
  ConversationMemoryExecutor,
  handleConversationMemoryMcpRequest,
} from './mcp/conversation-memory-server.ts';
import {
  SqliteStore,
} from './state/sqlite-store.ts';
import type { AppConfig } from './config.ts';
import type { ChatChannel, Logger } from './types.ts';

interface Runtime {
  readonly messageProcessor: WecomSync | null;
  start(): Promise<void>;
  handleMcp(request: Request): Promise<Response>;
  handleMemoryMcp(request: Request): Promise<Response>;
  handleIlinkMcp(request: Request): Promise<Response>;
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

function databaseHasActiveWriter(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath);
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN IMMEDIATE');
    database.exec('ROLLBACK');
    return false;
  } catch (error: unknown) {
    return (
      error instanceof Error &&
      'code' in error &&
      String(error.code) === 'ERR_SQLITE_ERROR' &&
      /busy|locked/iu.test(error.message)
    );
  } finally {
    database?.close();
  }
}

export function createRuntime({
  config,
  logger = console,
}: {
  config: AppConfig;
  logger?: Logger;
}): Runtime {
  if ((!config.wecom.api.enabled && !config.ilink.enabled) || !config.codex.enabled) {
    logger.info('[runtime] message processing is disabled');
    return {
      messageProcessor: null,
      async start() {},
      async handleMcp() {
        return Response.json({ error: 'service unavailable' }, { status: 503 });
      },
      async handleMemoryMcp() {
        return Response.json({ error: 'service unavailable' }, { status: 503 });
      },
      async handleIlinkMcp() {
        return Response.json({ error: 'service unavailable' }, { status: 503 });
      },
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
      databaseHasActiveWriter(config.state.databaseFile),
  });
  let store: SqliteStore | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let ilinkOffers: IlinkLoginStore | undefined;

  try {
    store = new SqliteStore({ filePath: config.state.databaseFile });
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
    store.recoverStartup();
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
    const wechatTools = apiClient && mediaGateway
      ? new WechatKfToolExecutor({
          store,
          apiClient,
          mediaGateway,
          observeMs: config.wecom.api.observeMs,
          logger,
          ...(config.ilink.enabled ? {
            ilinkOffers: {
              offer(sessionToken: string) {
                if (!ilinkLogin) throw new Error('iLink login manager is unavailable');
                return ilinkLogin.offer(sessionToken);
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
      ? new IlinkSqliteStore({ store })
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
      ilinkOffers = new IlinkLoginStore({ store, secretBox: ilinkSecretBox });
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
    const codex = createCodexAppServer(config.codex, {
      logger,
      ...(wechatTools ? { mcpUrl: config.wecom.mcp.url } : {}),
      memoryMcpUrl: config.wecom.mcp.memoryUrl,
      mcpBearerToken: config.wecom.mcp.bearerToken,
      ...(config.ilink.enabled ? { ilinkMcpUrl: config.ilink.mcpUrl } : {}),
      mcpToolTimeoutSec: Math.ceil((
        config.wecom.api.timeoutMs * 4 +
        config.wecom.api.observeMs +
        5_000
      ) / 1_000),
      ilinkMcpToolTimeoutSec: Math.ceil((
        DEFAULT_ILINK_IMAGE_TIMEOUT_MS +
        DEFAULT_ILINK_MEDIA_TIMEOUT_MS +
        config.ilink.apiTimeoutMs +
        5_000
      ) / 1_000),
    });
    const codexAgent = new CodexAgent({
      codex,
      config: config.codex,
    });
    const conversationMemory = new ConversationMemoryExecutor({
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
      channel: channelDispatcher,
      allowedUserIds: config.wecom.allowedUserIds,
      authorization: config.wecom.authorization,
      logger,
    });
    const sync = apiClient
      ? new WecomSync({
          apiClient,
          store,
          processor,
          logger,
          startPaused: true,
        })
      : undefined;
    let requestDeferredDrain = (): void => {};
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
                messages: input.candidates.map((candidate) => {
                  const secretGeneration = ilinkSecretGeneration(
                    candidate.providerMessageId,
                  );
                  return {
                    candidate,
                    secretGeneration,
                    sealedContextToken: ilinkSecretBox.seal(
                      candidate.contextToken,
                      {
                        secretKind: 'context_token',
                        accountId: candidate.accountKey,
                        peerId: candidate.peerId,
                        generation: secretGeneration,
                      },
                    ),
                    sealedImages: candidate.images.map((image) => {
                      const imageGeneration = ilinkSecretGeneration(
                        `${candidate.providerMessageId}:image:${image.position}`,
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
                            accountId: candidate.accountKey,
                            peerId: candidate.peerId,
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
    let closing: Promise<void> | undefined;
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
        starting ||= (async () => {
          await sync?.catchUp();
          await sync?.waitForIdle();
          const recovery = processor.recover(
            activeStore.recoverStartup().inbound.filter((record) =>
              enabledChannels.includes(record.channel)),
          );
          sync?.startConsuming();
          await recovery;
          await channelDispatcher.kick();
          await ilinkListener?.start();
          await ilinkLogin?.start();
          if (!ilinkListener) requestDeferredDrain();
        })();
        return starting;
      },
      handleMcp(request: Request): Promise<Response> {
        if (closing || !wechatTools) {
          return Promise.resolve(
            Response.json({ error: 'service unavailable' }, { status: 503 }),
          );
        }
        return handleWechatKfMcpRequest({
          request,
          executor: wechatTools,
          bearerToken: config.wecom.mcp.bearerToken,
        });
      },
      handleMemoryMcp(request: Request): Promise<Response> {
        if (closing) {
          return Promise.resolve(
            Response.json({ error: 'service unavailable' }, { status: 503 }),
          );
        }
        return handleConversationMemoryMcpRequest({
          request,
          executor: conversationMemory,
          bearerToken: config.wecom.mcp.bearerToken,
        });
      },
      handleIlinkMcp(request: Request): Promise<Response> {
        if (closing || !ilinkTools) {
          return Promise.resolve(
            Response.json({ error: 'service unavailable' }, { status: 503 }),
          );
        }
        return handleIlinkMcpRequest({
          request,
          executor: ilinkTools,
          bearerToken: config.wecom.mcp.bearerToken,
        });
      },
      stopAccepting() {
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
          await starting?.catch(() => undefined);
          await deferredDrain?.catch(() => undefined);
          await sync?.close();
          await ilinkClosing;
          await processor.close();
          await ilinkTools?.waitForIdle();
          await wechatTools?.close();
          if (cleanupTimer) clearInterval(cleanupTimer);
          activeStore.cleanup();
          ilinkOffers?.cleanup();
          activeStore.checkpoint('TRUNCATE');
          activeStore.close();
          instanceLock.release();
        })();
        return closing;
      },
      async abort(): Promise<void> {
        runtime.stopAccepting();
        await processor.abort();
        await ilinkClosing;
      },
    };
    return runtime;
  } catch (error: unknown) {
    if (cleanupTimer) clearInterval(cleanupTimer);
    store?.close();
    instanceLock.release();
    throw error;
  }
}
