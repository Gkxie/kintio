import path from 'node:path';

import { CodexResponder, createCodexClient } from './services/codex-responder.js';
import { MapLocationResolver } from './services/map-location-resolver.js';
import { WecomMediaGateway } from './services/media-gateway.js';
import { WecomApiClient } from './services/wecom-api.js';
import { WecomMessageProcessor } from './services/wecom-message-processor.js';
import { JsonStateStore } from './state/json-state-store.js';

export function createRuntime({ config, logger = console }) {
  if (!config.wecom.api?.enabled || !config.codex?.enabled) {
    logger.info('[wecom] message processing is disabled');
    return { messageProcessor: null };
  }

  const allowsEveryCustomer = config.wecom.allowedUserIds.includes('*');

  if (allowsEveryCustomer && config.codex.sandboxMode !== 'read-only') {
    throw new Error(
      'WECOM_ALLOWED_USER_IDS=* requires CODEX_SANDBOX_MODE=read-only',
    );
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    if (allowsEveryCustomer) {
      throw new Error(
        'Refusing to expose Codex to every WeCom customer while running as root',
      );
    }

    logger.warn?.(
      '[security] Node and Codex are running as root; only allowlist fully trusted customer IDs',
    );
  }

  if (config.wecom.allowedUserIds.length === 0) {
    if (config.wecom.authorization.trigger) {
      logger.warn?.(
        `[wecom] static allowlist is empty; self-authorization is enabled after ${config.wecom.authorization.requiredConsecutive} consecutive exact trigger messages`,
      );
    } else {
      logger.warn?.(
        '[wecom] WECOM_ALLOWED_USER_IDS is empty; callbacks will sync but no customer can invoke Codex',
      );
    }
  }

  const store = new JsonStateStore({ filePath: config.state.filePath });
  const apiClient = new WecomApiClient({
    corpId: config.wecom.api.corpId,
    kfSecret: config.wecom.api.kfSecret,
    timeoutMs: config.wecom.api.timeoutMs,
  });
  const replyResolver = new MapLocationResolver({
    historyStore: store,
    logger,
  });
  const toolJournalFile = path.join(
    path.dirname(config.state.filePath),
    'wecom-tool-journal.sqlite',
  );
  const responder = new CodexResponder({
    codexFactory: (toolContext) =>
      createCodexClient(config.codex, {
        corpId: config.wecom.api.corpId,
        kfSecret: config.wecom.api.kfSecret,
        timeoutMs: config.wecom.api.timeoutMs,
        ...toolContext,
        journalFile: toolJournalFile,
      }),
    store,
    config: config.codex,
    replyResolver,
    logger,
  });
  const mediaGateway = new WecomMediaGateway({ apiClient });
  const messageProcessor = new WecomMessageProcessor({
    apiClient,
    mediaGateway,
    responder,
    store,
    allowedUserIds: config.wecom.allowedUserIds,
    authorization: config.wecom.authorization,
    toolJournalFile,
    pauseFile: config.state.pauseFile,
    logger,
  });
  void messageProcessor.recoverPending();

  return {
    apiClient,
    mediaGateway,
    messageProcessor,
    replyResolver,
    responder,
    store,
  };
}
