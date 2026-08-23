import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { acquireSingleInstanceLock } from './runtime/single-instance-lock.ts';
import { CodexAgent, createCodexAppServer } from './services/codex-agent.ts';
import { ConversationProcessor } from './services/conversation-processor.ts';
import { DeliveryService } from './services/delivery-service.ts';
import { cleanupStagedImageOrphans } from './services/image-stager.ts';
import { WecomMediaGateway } from './services/media-gateway.ts';
import { OutboundPreparer } from './services/outbound-preparer.ts';
import { WecomApiClient } from './services/wecom-api.ts';
import { WecomSync } from './services/wecom-sync.ts';
import {
  SqliteStore,
  assertLegacyMigrationReady,
} from './state/sqlite-store.ts';
import type { AppConfig } from './config.ts';
import type { Logger } from './types.ts';

interface RuntimeLifecycle {
  stopAccepting(): void;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface DisabledRuntime extends RuntimeLifecycle {
  readonly enabled: false;
  readonly messageProcessor: null;
}

export interface ActiveRuntime extends RuntimeLifecycle {
  readonly enabled: true;
  readonly messageProcessor: WecomSync;
}

export type Runtime = DisabledRuntime | ActiveRuntime;

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : '';
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
      errorCode(error) === 'ERR_SQLITE_ERROR' &&
      /busy|locked/iu.test(error instanceof Error ? error.message : '')
    );
  } finally {
    database?.close();
  }
}

function disabledRuntime(logger: Logger): Runtime {
  logger.info('[wecom] message processing is disabled');
  return {
    enabled: false,
    messageProcessor: null,
    stopAccepting() {},
    async close() {},
    async abort() {},
  };
}

export function createRuntime({
  config,
  logger = console,
}: {
  config: AppConfig;
  logger?: Logger;
}): Runtime {
  if (!config.wecom.api?.enabled || !config.codex?.enabled) {
    return disabledRuntime(logger);
  }

  const allowsEveryCustomer = config.wecom.allowedUserIds.includes('*');
  if (allowsEveryCustomer && config.codex.sandboxMode !== 'read-only') {
    throw new Error('WECOM_ALLOWED_USER_IDS=* requires a read-only Codex sandbox');
  }
  if (
    allowsEveryCustomer &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0
  ) {
    throw new Error('Refusing WECOM_ALLOWED_USER_IDS=* while running as root');
  }

  const instanceLock = acquireSingleInstanceLock({
    filePath: config.state.lockFile,
    hasActiveDatabaseOwner: () =>
      databaseHasActiveWriter(config.state.databaseFile),
  });
  let store: SqliteStore | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;

  try {
    assertLegacyMigrationReady({
      databaseFile: config.state.databaseFile,
      legacyStateFile: config.state.legacyStateFile,
    });

    store = new SqliteStore({ filePath: config.state.databaseFile });
    const activeStore = store;
    store.cleanup();
    cleanupStagedImageOrphans(config.codex.imageTempDirectory);
    cleanupTimer = setInterval(() => {
      try {
        activeStore.cleanup();
      } catch (error) {
        logger.error(
          `[cleanup] SQLite retention failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, 60 * 60 * 1000);
    cleanupTimer.unref();
    const recovery = store.recoverStartup();
    const apiClient = new WecomApiClient({
      corpId: config.wecom.api.corpId,
      kfSecret: config.wecom.api.kfSecret,
      timeoutMs: config.wecom.api.timeoutMs,
    });
    const mediaGateway = new WecomMediaGateway({ apiClient });
    const delivery = new DeliveryService({ apiClient, store, logger });
    const codex = createCodexAppServer(config.codex, { logger });
    const codexAgent = new CodexAgent({
      codex,
      store,
      config: config.codex,
    });
    const outboundPreparer = new OutboundPreparer({
      mediaGateway,
      spoolDirectory: config.state.spoolDirectory,
    });
    const processor = new ConversationProcessor({
      store,
      codexAgent,
      mediaGateway,
      outboundPreparer,
      delivery,
      allowedUserIds: config.wecom.allowedUserIds,
      authorization: config.wecom.authorization,
      logger,
    });
    const sync = new WecomSync({
      apiClient,
      store,
      processor,
      logger,
    });
    const activeSpoolKeys = new Set(
      recovery.inbound
        .filter((message) => message.status === 'preparing')
        .map((message) => message.messageKey),
    );
    void outboundPreparer
      .cleanupOrphans(activeSpoolKeys)
      .catch((error) => logger.warn?.(`[spool] cleanup failed: ${error.message}`));
    void processor.recover(recovery.inbound);
    void delivery.kick();

    let closing: Promise<void> | undefined;
    const runtime = {
      enabled: true as const,
      messageProcessor: sync,
      stopAccepting() {
        sync.stopAccepting();
        processor.stopAccepting();
      },
      close(): Promise<void> {
        if (closing) return closing;
        runtime.stopAccepting();
        closing = (async () => {
          await sync.close();
          await processor.close();
          await delivery.close();
          if (cleanupTimer) clearInterval(cleanupTimer);
          activeStore.cleanup();
          activeStore.checkpoint('TRUNCATE');
          activeStore.close();
          instanceLock.release();
        })();
        return closing;
      },
      async abort(): Promise<void> {
        runtime.stopAccepting();
        await processor.abort();
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
