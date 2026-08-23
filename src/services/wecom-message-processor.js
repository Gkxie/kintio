import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { projectWecomMessage } from '../adapters/wecom-message-adapter.js';
import {
  ATTACHMENT_KINDS,
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
} from '../domain/message.js';
import {
  MEDIA_REPLY_TYPES,
  REPLY_TYPES,
  replyToOutboundMessages,
} from '../domain/reply.js';
import { truncateUtf8 } from '../lib/text.js';
import { SqliteToolJournal } from '../state/sqlite-tool-journal.js';
import { WecomSendTools } from '../tools/wecom-send-tools.js';

const MAX_SYNC_PAGES_PER_CALLBACK = 100;
const HUMAN_SESSION_CHANGE_TYPES = new Set([1, 2, 4]);
const SUPPORTED_CUSTOMER_MESSAGE_TYPES = new Set([
  MESSAGE_TYPES.TEXT,
  MESSAGE_TYPES.IMAGE,
  MESSAGE_TYPES.VOICE,
  MESSAGE_TYPES.VIDEO,
  MESSAGE_TYPES.FILE,
  MESSAGE_TYPES.LOCATION,
  MESSAGE_TYPES.LINK,
  MESSAGE_TYPES.BUSINESS_CARD,
  MESSAGE_TYPES.MINIPROGRAM,
  MESSAGE_TYPES.MSGMENU,
  MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT,
  MESSAGE_TYPES.CHANNELS_SHOP_ORDER,
  MESSAGE_TYPES.MERGED_MESSAGE,
  MESSAGE_TYPES.CHANNELS,
  MESSAGE_TYPES.NOTE,
]);

function sessionKey(openKfId, externalUserId) {
  return `${openKfId}:${externalUserId}`;
}

function authorizationConfirmationMessageId(inboundMessageId) {
  const hash = createHash('sha256')
    .update(`authorization:${inboundMessageId}`)
    .digest('hex');
  return `wa_${hash.slice(0, 29)}`;
}

function nativeTextFallback(outboundMessage) {
  let lines;

  if (outboundMessage.type === REPLY_TYPES.LOCATION) {
    const location = outboundMessage.location || {};
    lines = [
      location.name,
      location.address,
      Number.isFinite(Number(location.latitude)) &&
      Number.isFinite(Number(location.longitude))
        ? `坐标：${location.latitude}, ${location.longitude}`
        : '',
    ];
  } else if (outboundMessage.type === REPLY_TYPES.MINIPROGRAM) {
    const miniprogram = outboundMessage.miniprogram || {};
    lines = [miniprogram.title, miniprogram.sourceUrl];
  } else if (outboundMessage.type === REPLY_TYPES.LINK) {
    const link = outboundMessage.link || {};
    lines = [link.title, link.description, link.url];
  } else if (MEDIA_REPLY_TYPES.includes(outboundMessage.type)) {
    lines = [
      outboundMessage.fallbackText ||
        '暂时无法发送该媒体，请重新发送后再试。',
    ];
  } else {
    return '';
  }

  return truncateUtf8(lines.filter(Boolean).join('\n'), 2048);
}

export class WecomMessageProcessor {
  constructor({
    apiClient,
    mediaGateway = { resolveForCodex: async () => [] },
    responder,
    store,
    allowedUserIds = [],
    authorization = {},
    toolJournalFile = '',
    pauseFile = '',
    logger = console,
  }) {
    this.apiClient = apiClient;
    this.mediaGateway = mediaGateway;
    this.responder = responder;
    this.store = store;
    this.allowedUserIds = new Set(allowedUserIds);
    this.authorization = Object.freeze({
      trigger: String(authorization.trigger || ''),
      requiredConsecutive: Math.max(
        1,
        Number(authorization.requiredConsecutive) || 3,
      ),
      confirmationText: String(
        authorization.confirmationText || '暗号确认，请继续对话',
      ),
    });
    this.toolJournalFile = toolJournalFile;
    this.pauseFile = pauseFile;
    this.logger = logger;
    this.queues = new Map();
    this.backgroundTasks = new Set();
    this.recoveryPromise = Promise.resolve();
  }

  #isStaticallyAllowed(externalUserId) {
    return (
      this.allowedUserIds.has('*') || this.allowedUserIds.has(externalUserId)
    );
  }

  async #sendAuthorizationConfirmation(message) {
    const { externalUserId, openKfId } = message.conversation;
    const record = await this.store.getMessage(message.id);

    if (Number(record?.sentChunks || 0) >= 1) {
      await this.store.markMessageSent(message.id);
      return;
    }

    const result = await this.apiClient.sendTextMessage({
      toUser: externalUserId,
      openKfId,
      content: this.authorization.confirmationText,
      messageId: authorizationConfirmationMessageId(message.id),
    });
    await this.store.markChunkSent(message.id, 1, {
      wecomMsgId: result?.msgid || '',
      sentType: REPLY_TYPES.TEXT,
    });
    await this.store.markMessageSent(message.id);
    this.logger.info(
      `[wecom] customer authorized and confirmed msgid=${message.id} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }

  #isPaused() {
    return Boolean(this.pauseFile && fs.existsSync(this.pauseFile));
  }

  async #mediaCatalog(message) {
    const { openKfId, externalUserId } = message.conversation;
    const imageAttachments = (message.attachments || []).filter(
      (attachment) => attachment.kind === ATTACHMENT_KINDS.IMAGE,
    );
    let entries = imageAttachments.map((attachment, index) => ({
      id: `${message.id}:${index}`,
      messageId: message.id,
      kind: attachment.kind,
      mediaId: attachment.mediaId,
      filename: attachment.filename || '',
      sentAt: message.sentAt,
      rememberedAt: Date.now(),
    }));

    if (
      entries.length &&
      typeof this.store.rememberInboundAttachments === 'function'
    ) {
      await this.store.rememberInboundAttachments({
        openKfId,
        externalUserId,
        messageId: message.id,
        sentAt: message.sentAt,
        attachments: imageAttachments,
      });
    }

    if (typeof this.store.getRecentInboundAttachments === 'function') {
      entries = await this.store.getRecentInboundAttachments({
        openKfId,
        externalUserId,
        limit: 10,
      });
    }

    return entries
      .filter((entry) => entry.kind === ATTACHMENT_KINDS.IMAGE)
      .map((entry, index) => ({
        ...entry,
        ref: `media:${index}`,
      }));
  }

  enqueue({ callbackToken, openKfId }) {
    const previous = this.queues.get(openKfId) || this.recoveryPromise;
    const run = previous.then(
      () => this.#drain({ callbackToken, openKfId }),
      () => this.#drain({ callbackToken, openKfId }),
    );
    const guarded = run.catch((error) => {
      this.logger.error(
        `[wecom] message synchronization failed open_kfid=${openKfId}: ${error.message}`,
      );
    });

    this.queues.set(openKfId, guarded);
    void guarded.finally(() => {
      if (this.queues.get(openKfId) === guarded) {
        this.queues.delete(openKfId);
      }
    });

    return guarded;
  }

  recoverPending() {
    this.recoveryPromise = this.#recoverPending().catch((error) => {
      this.logger.error(
        `[wecom] pending Codex turn recovery failed: ${error.message}`,
      );
    });
    return this.recoveryPromise;
  }

  async #recoverPending() {
    if (typeof this.store.getPendingCodexMessages !== 'function') return;
    const pending = await this.store.getPendingCodexMessages();
    const groups = new Map();

    for (const record of pending) {
      const primaryMessageId = record.primaryMessageId || record.messageId;
      const group = groups.get(primaryMessageId) || [];
      group.push(record);
      groups.set(primaryMessageId, group);
    }

    for (const [primaryMessageId, records] of groups) {
      const ordered = records.sort(
        (left, right) =>
          Number(left.inboundMessage?.sentAt || left.updatedAt || 0) -
          Number(right.inboundMessage?.sentAt || right.updatedAt || 0),
      );
      const primaryIndex = ordered.findIndex(
        (record) => record.messageId === primaryMessageId,
      );
      if (primaryIndex > 0) {
        ordered.unshift(...ordered.splice(primaryIndex, 1));
      }
      const primary = ordered[0];
      if (!primary?.inboundMessage || primary.messageId !== primaryMessageId) {
        continue;
      }

      try {
        for (const record of ordered) {
          await this.#submitCustomerMessage(record.inboundMessage);
        }
        this.logger.info(
          `[wecom] recovered pending steerable Codex turn primary_msgid=${primaryMessageId} messages=${ordered.length}`,
        );
      } catch (error) {
        await this.store.markProcessingFailed(primaryMessageId, error);
        this.logger.error(
          `[wecom] failed to recover pending Codex turn primary_msgid=${primaryMessageId}: ${error.message}`,
        );
      }
    }
  }

  #trackBackground(task) {
    const guarded = Promise.resolve(task).catch((error) => {
      this.logger.error(
        `[wecom] asynchronous Codex completion failed: ${error.message}`,
      );
    });
    this.backgroundTasks.add(guarded);
    void guarded.finally(() => this.backgroundTasks.delete(guarded));
  }

  async waitForIdle() {
    while (this.queues.size || this.backgroundTasks.size) {
      await Promise.allSettled([
        ...this.queues.values(),
        ...this.backgroundTasks.values(),
      ]);
    }
  }

  async close() {
    await this.responder.close?.();
    await this.waitForIdle();
  }

  async #drain({ callbackToken, openKfId }) {
    let cursor = await this.store.getCursor(openKfId);

    for (let page = 0; page < MAX_SYNC_PAGES_PER_CALLBACK; page += 1) {
      const result = await this.apiClient.syncMessages({
        cursor,
        callbackToken,
        openKfId,
      });

      for (const message of result.msg_list) {
        await this.#processMessage(message, openKfId);
      }

      const nextCursor = result.next_cursor || '';

      if (nextCursor && nextCursor !== cursor) {
        await this.store.setCursor(openKfId, nextCursor);
        cursor = nextCursor;
      } else if (result.has_more === 1) {
        throw new Error('sync_msg returned has_more=1 without a new cursor');
      }

      if (result.has_more !== 1) {
        return;
      }
    }

    throw new Error('sync_msg exceeded the per-callback page limit');
  }

  async #processMessage(rawMessage, fallbackOpenKfId) {
    const message = projectWecomMessage(rawMessage, fallbackOpenKfId);

    if (
      message.origin === MESSAGE_ORIGINS.SYSTEM &&
      message.type === MESSAGE_TYPES.EVENT
    ) {
      await this.#processSystemEvent(message);
      return;
    }

    if (message.origin === MESSAGE_ORIGINS.HUMAN) {
      await this.#processHumanMessage(message);
      return;
    }

    if (message.origin !== MESSAGE_ORIGINS.CUSTOMER || !message.id) {
      return;
    }

    const { externalUserId, openKfId } = message.conversation;

    if (!externalUserId || !openKfId) {
      this.logger.warn?.(
        `[wecom] ignored malformed customer message msgid=${message.id}`,
      );
      return;
    }

    const existing = await this.store.getMessage(message.id);

    if (existing?.status === 'authorization_pending') {
      await this.#sendAuthorizationConfirmation(message);
      return;
    }

    if (
      ['sent', 'ignored', 'absorbed', 'processing', 'steered'].includes(
        existing?.status,
      )
    ) {
      return;
    }

    if (!this.#isStaticallyAllowed(externalUserId)) {
      const trigger = this.authorization.trigger;
      const rawText = String(rawMessage?.text?.content || '');
      const authorization = await this.store.evaluateCustomerAuthorization({
        openKfId,
        externalUserId,
        messageId: message.id,
        isTrigger:
          Boolean(trigger) &&
          message.type === MESSAGE_TYPES.TEXT &&
          rawText === trigger,
        requiredConsecutive: this.authorization.requiredConsecutive,
      });

      if (authorization.newlyAuthorized) {
        await this.#sendAuthorizationConfirmation(message);
        return;
      }

      if (authorization.allowed) {
        // Continue with normal processing for a persistently authorized customer.
      } else {
        this.logger.info(
          `[wecom] silently ignored unauthorized customer trigger_match=${Boolean(trigger) && message.type === MESSAGE_TYPES.TEXT && rawText === trigger} consecutive=${authorization.consecutiveMatches} duplicate=${authorization.duplicate} external_userid=${externalUserId} open_kfid=${openKfId}`,
        );
        return;
      }
    }

    if (!SUPPORTED_CUSTOMER_MESSAGE_TYPES.has(message.type)) {
      this.logger.info(
        `[wecom] ignored unsupported customer msgtype=${message.type} external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    const session = await this.store.getSession(
      sessionKey(openKfId, externalUserId),
    );

    if (session?.mode === 'human') {
      this.logger.info(
        `[wecom] skipped Codex during human session external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    if (this.#isPaused()) {
      this.logger.info(
        `[wecom] bot is paused; skipped Codex external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    if (
      (!existing || existing.status === 'failed') &&
      typeof this.responder.submit === 'function'
    ) {
      await this.#submitCustomerMessage(message);
      return;
    }

    let record = existing;

    if (!record) {
      const mediaCatalog = await this.#mediaCatalog(message);
      const resolvedMedia = await this.mediaGateway.resolveForCodex(message);
      const reply = await this.responder.respond({
        message,
        resolvedMedia,
        mediaCatalog,
      });

      if (reply.type === 'tool_dispatch') {
        await this.store.setGeneratedMessage(message.id, {
          openKfId,
          externalUserId,
          outboundMessages: [],
          toolDispatches: structuredClone(reply.dispatches),
          sendReceipts: structuredClone(reply.receipts),
        });
        await this.store.markMessageSent(message.id);
        const toolNames = reply.dispatches
          .map((dispatch) => dispatch.tool)
          .join(',');
        this.logger.info(
          `[wecom] Codex tools replied msgid=${message.id} tools=${toolNames} tool_calls=${reply.dispatches.length} external_userid=${externalUserId} open_kfid=${openKfId}`,
        );
        return;
      }

      const outboundMessages = replyToOutboundMessages(reply, {
        mediaCatalog,
      });

      if (outboundMessages.length === 0) {
        throw new Error('Codex response contained no sendable text');
      }

      record = await this.store.setGeneratedMessage(message.id, {
        openKfId,
        externalUserId,
        outboundMessages,
      });
    }

    const outboundMessages =
      record.outboundMessages ||
      (record.responseChunks || []).map((content) => ({
        type: REPLY_TYPES.TEXT,
        content,
      }));

    for (
      let chunkIndex = Number(record.sentChunks || 0);
      chunkIndex < outboundMessages.length;
      chunkIndex += 1
    ) {
      const receipt = await this.#sendOutboundMessage({
        outboundMessage: outboundMessages[chunkIndex],
        externalUserId,
        openKfId,
      });
      await this.store.markChunkSent(message.id, chunkIndex + 1, receipt);
    }

    await this.store.markMessageSent(message.id);
    this.logger.info(
      `[wecom] replied msgid=${message.id} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }

  async #submitCustomerMessage(message) {
    const { openKfId, externalUserId } = message.conversation;
    const mediaCatalog = await this.#mediaCatalog(message);
    const resolvedMedia = await this.mediaGateway.resolveForCodex(message);
    const submission = await this.responder.submit({
      message,
      resolvedMedia,
      mediaCatalog,
    });

    if (submission.kind === 'steered') {
      await this.store.setSteeredMessage(message.id, {
        openKfId,
        externalUserId,
        primaryMessageId: submission.primaryMessageId,
        inboundMessage: message,
      });
      this.logger.info(
        `[wecom] steered active Codex turn msgid=${message.id} primary_msgid=${submission.primaryMessageId} external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    await this.store.setProcessingMessage(message.id, {
      openKfId,
      externalUserId,
      inboundMessage: message,
    });
    const completion = submission.completion
      .then((reply) =>
        this.#completeSubmittedMessage({ message, mediaCatalog, reply }),
      )
      .catch(async (error) => {
        await this.store.markProcessingFailed(message.id, error);
        throw error;
      });
    this.#trackBackground(completion);
    this.logger.info(
      `[wecom] started steerable Codex turn msgid=${message.id} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }

  async #completeSubmittedMessage({ message, mediaCatalog, reply }) {
    const { openKfId, externalUserId } = message.conversation;

    if (reply.type === 'generated_image') {
      const tools = this.#createBoundSendTools({ message, mediaCatalog: [] });
      let result;
      try {
        result = await tools.sendGeneratedImage(reply.media);
      } finally {
        tools.close();
      }
      await this.store.setGeneratedMessage(message.id, {
        openKfId,
        externalUserId,
        outboundMessages: [],
        toolDispatches: [
          {
            tool: 'send_generated_image',
            arguments: {
              filename: reply.media.filename,
              contentType: reply.media.contentType,
              byteLength: reply.media.bytes.length,
              generationId: reply.generationId,
              revisedPrompt: truncateUtf8(reply.revisedPrompt, 1024),
            },
          },
        ],
        sendReceipts: structuredClone(result.receipts),
      });
      await this.store.markMessageSent(message.id);
      await this.store.markSteeredMessagesAbsorbed(message.id);
      this.logger.info(
        `[wecom] Codex generated image replied msgid=${message.id} bytes=${reply.media.bytes.length} external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    if (reply.type === 'tool_dispatch') {
      const receipts = reply.deferred
        ? await this.#commitToolDispatches({
            message,
            mediaCatalog: reply.mediaCatalog || mediaCatalog,
            dispatches: reply.dispatches,
          })
        : reply.receipts;
      await this.store.setGeneratedMessage(message.id, {
        openKfId,
        externalUserId,
        outboundMessages: [],
        toolDispatches: structuredClone(reply.dispatches),
        sendReceipts: structuredClone(receipts),
      });
      await this.store.markMessageSent(message.id);
      await this.store.markSteeredMessagesAbsorbed(message.id);
      const toolNames = reply.dispatches
        .map((dispatch) => dispatch.tool)
        .join(',');
      this.logger.info(
        `[wecom] Codex tools replied msgid=${message.id} tools=${toolNames} tool_calls=${reply.dispatches.length} external_userid=${externalUserId} open_kfid=${openKfId}`,
      );
      return;
    }

    const outboundMessages = replyToOutboundMessages(reply, { mediaCatalog });
    if (outboundMessages.length === 0) {
      throw new Error('Codex response contained no sendable text');
    }
    const record = await this.store.setGeneratedMessage(message.id, {
      openKfId,
      externalUserId,
      outboundMessages,
    });

    for (
      let chunkIndex = Number(record.sentChunks || 0);
      chunkIndex < outboundMessages.length;
      chunkIndex += 1
    ) {
      const receipt = await this.#sendOutboundMessage({
        outboundMessage: outboundMessages[chunkIndex],
        externalUserId,
        openKfId,
      });
      await this.store.markChunkSent(message.id, chunkIndex + 1, receipt);
    }

    await this.store.markMessageSent(message.id);
    await this.store.markSteeredMessagesAbsorbed(message.id);
    this.logger.info(
      `[wecom] replied msgid=${message.id} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }

  #createBoundSendTools({ message, mediaCatalog }) {
    const { openKfId, externalUserId } = message.conversation;
    return new WecomSendTools({
      apiClient: this.apiClient,
      mediaGateway: this.mediaGateway,
      conversation: { openKfId, externalUserId },
      mediaCatalog,
      maxSends: 5,
      idempotencyJournal: this.toolJournalFile
        ? new SqliteToolJournal({ filePath: this.toolJournalFile })
        : undefined,
      turnId: [openKfId, externalUserId, message.id].join(':'),
    });
  }

  async #commitToolDispatches({ message, mediaCatalog, dispatches }) {
    const tools = this.#createBoundSendTools({ message, mediaCatalog });
    const receipts = [];

    try {
      for (const dispatch of dispatches) {
        let result;
        if (dispatch.tool === 'send_text') {
          result = await tools.sendText(dispatch.arguments);
        } else if (dispatch.tool === 'send_location') {
          result = await tools.sendLocation(dispatch.arguments);
        } else if (dispatch.tool === 'send_link') {
          result = await tools.sendLink(dispatch.arguments);
        } else if (dispatch.tool === 'send_miniprogram') {
          result = await tools.sendMiniProgram(dispatch.arguments);
        } else if (dispatch.tool === 'send_image') {
          result = await tools.sendImage(dispatch.arguments);
        } else {
          throw new Error(`Unsupported deferred WeChat tool: ${dispatch.tool}`);
        }
        receipts.push(...result.receipts);
      }
      return receipts;
    } finally {
      tools.close();
    }
  }

  async #sendOutboundMessage({ outboundMessage, externalUserId, openKfId }) {
    if (outboundMessage.type !== REPLY_TYPES.TEXT) {
      try {
        if (outboundMessage.type === REPLY_TYPES.LOCATION) {
          const result = await this.apiClient.sendLocationMessage({
            toUser: externalUserId,
            openKfId,
            location: outboundMessage.location,
          });
          return {
            wecomMsgId: result?.msgid || '',
            sentType: REPLY_TYPES.LOCATION,
          };
        }

        if (MEDIA_REPLY_TYPES.includes(outboundMessage.type)) {
          const mediaId = await this.mediaGateway.cloneForSend(
            outboundMessage.media,
          );
          const result = await this.apiClient.sendMediaMessage({
            toUser: externalUserId,
            openKfId,
            type: outboundMessage.type,
            mediaId,
          });
          return {
            wecomMsgId: result?.msgid || '',
            sentType: outboundMessage.type,
          };
        }

        if (outboundMessage.type === REPLY_TYPES.LINK) {
          const thumbnailMediaId =
            await this.mediaGateway.getCardThumbnailMediaId();
          const result = await this.apiClient.sendLinkMessage({
            toUser: externalUserId,
            openKfId,
            link: outboundMessage.link,
            thumbnailMediaId,
          });
          return {
            wecomMsgId: result?.msgid || '',
            sentType: REPLY_TYPES.LINK,
          };
        }

        if (outboundMessage.type === REPLY_TYPES.MINIPROGRAM) {
          const thumbnailMediaId =
            await this.mediaGateway.getCardThumbnailMediaId();
          const result = await this.apiClient.sendMiniProgramMessage({
            toUser: externalUserId,
            openKfId,
            miniprogram: outboundMessage.miniprogram,
            thumbnailMediaId,
          });
          return {
            wecomMsgId: result?.msgid || '',
            sentType: REPLY_TYPES.MINIPROGRAM,
          };
        }

      } catch (error) {
        const content = nativeTextFallback(outboundMessage);

        if (!content) throw error;

        this.logger.warn?.(
          `[wecom] native ${outboundMessage.type} send failed; using text fallback: ${error.message}`,
        );
        const result = await this.apiClient.sendTextMessage({
          toUser: externalUserId,
          openKfId,
          content,
        });
        return {
          wecomMsgId: result?.msgid || '',
          sentType: REPLY_TYPES.TEXT,
        };
      }
    }

    const result = await this.apiClient.sendTextMessage({
      toUser: externalUserId,
      openKfId,
      content: outboundMessage.content,
    });
    return {
      wecomMsgId: result?.msgid || '',
      sentType: REPLY_TYPES.TEXT,
    };
  }

  async #processHumanMessage(message) {
    const { externalUserId, openKfId } = message.conversation;

    if (!externalUserId || !openKfId) {
      this.logger.warn?.('[wecom] ignored malformed origin=5 message');
      return;
    }

    await this.store.setSession(sessionKey(openKfId, externalUserId), {
      mode: 'human',
      servicerUserId: message.actor.servicerUserId,
      source: 'origin_5',
    });

    const isApproval =
      message.type === MESSAGE_TYPES.TEXT && message.text.trim() === '批准';

    this.logger.info(
      `[wecom] observed human message origin=5 msgtype=${message.type} approval_keyword=${isApproval} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }

  async #processSystemEvent(message) {
    const event = message.attributes || {};

    if (event.event_type === 'msg_send_fail') {
      const matched =
        typeof this.store.markOutboundFailed === 'function'
          ? await this.store.markOutboundFailed({
              wecomMsgId: String(event.fail_msgid || ''),
              failType: Number(event.fail_type || 0),
            })
          : false;
      this.logger.warn?.(
        `[wecom] outbound delivery failed fail_type=${Number(event.fail_type || 0)} matched=${matched}`,
      );
      return;
    }

    if (event.event_type !== 'session_status_change') {
      return;
    }

    const { openKfId, externalUserId } = message.conversation;

    if (!openKfId || !externalUserId) {
      return;
    }

    const changeType = Number(event.change_type);
    let mode;

    if (HUMAN_SESSION_CHANGE_TYPES.has(changeType)) {
      mode = 'human';
    } else if (changeType === 3) {
      mode = 'ended';
    } else {
      return;
    }

    await this.store.setSession(sessionKey(openKfId, externalUserId), {
      mode,
      servicerUserId: event.new_servicer_userid || '',
      source: 'session_status_change',
      changeType,
    });
    this.logger.info(
      `[wecom] session status changed mode=${mode} change_type=${changeType} external_userid=${externalUserId} open_kfid=${openKfId}`,
    );
  }
}
