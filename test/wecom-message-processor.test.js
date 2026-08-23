import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLinkReply,
  createLocationReply,
  createMediaReply,
  createMiniProgramReply,
  createTextReply,
} from '../src/domain/reply.js';
import { projectWecomMessage } from '../src/adapters/wecom-message-adapter.js';
import { WecomMessageProcessor } from '../src/services/wecom-message-processor.js';

class MemoryStateStore {
  constructor() {
    this.cursors = new Map();
    this.messages = new Map();
    this.sessions = new Map();
    this.inboundMedia = new Map();
    this.customerAuthorizations = new Map();
  }

  async getCursor(openKfId) {
    return this.cursors.get(openKfId) || '';
  }

  async setCursor(openKfId, cursor) {
    this.cursors.set(openKfId, cursor);
  }

  async getMessage(messageId) {
    const record = this.messages.get(messageId);
    return record ? structuredClone(record) : undefined;
  }

  async getPendingCodexMessages() {
    return [...this.messages.entries()]
      .filter(
        ([, record]) =>
          ['processing', 'steered'].includes(record.status) &&
          record.inboundMessage,
      )
      .map(([messageId, record]) => ({
        messageId,
        ...structuredClone(record),
      }))
      .sort(
        (left, right) =>
          Number(left.inboundMessage?.sentAt || left.updatedAt || 0) -
          Number(right.inboundMessage?.sentAt || right.updatedAt || 0),
      );
  }

  async setProcessingMessage(messageId, record) {
    const existing = this.messages.get(messageId);
    const stored = {
      ...structuredClone(record),
      status: 'processing',
      sentChunks: existing?.sentChunks || 0,
      updatedAt: Date.now(),
    };
    this.messages.set(messageId, stored);
    return structuredClone(stored);
  }

  async setSteeredMessage(messageId, record) {
    const primary = this.messages.get(record.primaryMessageId);
    const stored = {
      ...structuredClone(record),
      status: primary?.status === 'sent' ? 'absorbed' : 'steered',
      updatedAt: Date.now(),
    };
    this.messages.set(messageId, stored);
    return structuredClone(stored);
  }

  async markSteeredMessagesAbsorbed(primaryMessageId) {
    for (const record of this.messages.values()) {
      if (
        record.status === 'steered' &&
        record.primaryMessageId === primaryMessageId
      ) {
        record.status = 'absorbed';
        record.updatedAt = Date.now();
      }
    }
  }

  async markProcessingFailed(messageId, error) {
    const record = this.messages.get(messageId);
    if (!record) return undefined;
    record.status = 'failed';
    record.errorMessage = String(error?.message || error);
    record.updatedAt = Date.now();
    for (const candidate of this.messages.values()) {
      if (
        candidate.status === 'steered' &&
        candidate.primaryMessageId === messageId
      ) {
        candidate.status = 'failed';
        candidate.errorMessage = record.errorMessage;
        candidate.updatedAt = record.updatedAt;
      }
    }
    return structuredClone(record);
  }

  async getSession(key) {
    const session = this.sessions.get(key);
    return session ? structuredClone(session) : undefined;
  }

  async setSession(key, session) {
    const stored = { ...structuredClone(session), updatedAt: Date.now() };
    this.sessions.set(key, stored);
    return structuredClone(stored);
  }

  async getCustomerAuthorization(externalUserId) {
    const authorization = this.customerAuthorizations.get(externalUserId);
    return authorization ? structuredClone(authorization) : undefined;
  }

  async evaluateCustomerAuthorization({
    openKfId,
    externalUserId,
    messageId,
    isTrigger,
    requiredConsecutive = 3,
  }) {
    const existingMessage = this.messages.get(messageId);
    const current = this.customerAuthorizations.get(externalUserId) || {};

    if (
      existingMessage?.status === 'ignored' &&
      existingMessage.ignoreReason === 'unauthorized'
    ) {
      return {
        allowed: false,
        duplicate: true,
        newlyAuthorized: false,
        consecutiveMatches: Number(current.consecutiveMatches || 0),
      };
    }

    if (current.authorized === true) {
      return {
        allowed: true,
        duplicate: false,
        newlyAuthorized: false,
        consecutiveMatches: Number(current.consecutiveMatches || 0),
      };
    }

    const sameCustomerService =
      !current.openKfId || current.openKfId === openKfId;
    const consecutiveMatches = isTrigger
      ? (sameCustomerService ? Number(current.consecutiveMatches || 0) : 0) +
        1
      : 0;
    const newlyAuthorized =
      consecutiveMatches >= Math.max(1, Number(requiredConsecutive) || 3);
    const stored = {
      authorized: newlyAuthorized,
      consecutiveMatches,
      openKfId,
      lastMessageId: messageId,
      authorizedAt: newlyAuthorized ? Date.now() : 0,
      updatedAt: Date.now(),
    };
    this.customerAuthorizations.set(externalUserId, stored);
    this.messages.set(messageId, {
      openKfId,
      externalUserId,
      status: newlyAuthorized ? 'authorization_pending' : 'ignored',
      ignoreReason: 'unauthorized',
      sentChunks: 0,
      updatedAt: Date.now(),
    });

    return {
      allowed: false,
      duplicate: false,
      newlyAuthorized,
      consecutiveMatches,
    };
  }

  async rememberInboundAttachments({
    openKfId,
    externalUserId,
    messageId,
    sentAt = 0,
    attachments,
  }) {
    const key = `${openKfId}:${externalUserId}`;
    const existing = this.inboundMedia.get(key) || [];
    const added = attachments.map((attachment, index) => ({
      id: `${messageId}:${index}`,
      messageId,
      kind: attachment.kind,
      mediaId: attachment.mediaId,
      filename: attachment.filename || '',
      sentAt,
      rememberedAt: Date.now(),
    }));
    this.inboundMedia.set(key, [
      ...added,
      ...existing.filter((entry) => entry.messageId !== messageId),
    ]);
    return structuredClone(added);
  }

  async getRecentInboundAttachments({ openKfId, externalUserId, limit = 10 }) {
    return structuredClone(
      (this.inboundMedia.get(`${openKfId}:${externalUserId}`) || []).slice(
        0,
        limit,
      ),
    );
  }

  async setGeneratedMessage(messageId, record) {
    const stored = {
      ...structuredClone(record),
      status: 'generated',
      sentChunks: 0,
      updatedAt: Date.now(),
    };
    this.messages.set(messageId, stored);
    return structuredClone(stored);
  }

  async markChunkSent(messageId, sentChunks, receipt = undefined) {
    const record = this.messages.get(messageId);
    record.sentChunks = sentChunks;
    if (receipt?.wecomMsgId) {
      record.sendReceipts ||= [];
      record.sendReceipts[sentChunks - 1] = {
        ...structuredClone(receipt),
        status: 'accepted',
      };
    }
    record.updatedAt = Date.now();
    return structuredClone(record);
  }

  async markMessageSent(messageId) {
    const record = this.messages.get(messageId);
    record.status = 'sent';
    record.deliveryStatus = 'accepted';
    record.updatedAt = Date.now();
    return structuredClone(record);
  }

  async markOutboundFailed({ wecomMsgId, failType }) {
    for (const record of this.messages.values()) {
      const receipt = (record.sendReceipts || []).find(
        (item) => item?.wecomMsgId === wecomMsgId,
      );
      if (!receipt) continue;
      receipt.status = 'failed';
      receipt.failType = failType;
      record.deliveryStatus = 'failed';
      return true;
    }
    return false;
  }
}

const silentLogger = {
  error() {},
  info() {},
  warn() {},
};

function customerTextMessage(overrides = {}) {
  return {
    msgid: 'message-one',
    open_kfid: 'wk-one',
    external_userid: 'wm-one',
    origin: 3,
    msgtype: 'text',
    text: { content: '你好' },
    ...overrides,
  };
}

test('processor follows has_more even when a page has no messages', async () => {
  const store = new MemoryStateStore();
  const syncCalls = [];
  const pages = [
    {
      next_cursor: 'cursor-one',
      has_more: 1,
      msg_list: [],
    },
    {
      next_cursor: 'cursor-two',
      has_more: 0,
      msg_list: [customerTextMessage()],
    },
  ];
  const sent = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages(request) {
        syncCalls.push(request);
        return pages.shift();
      },
      async sendTextMessage(message) {
        sent.push(message);
        return { errcode: 0 };
      },
    },
    responder: {
      async respond() {
        return createTextReply('你好，请问有什么可以帮你？');
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[0].cursor, '');
  assert.equal(syncCalls[1].cursor, 'cursor-one');
  assert.equal(syncCalls[1].callbackToken, 'callback-token');
  assert.equal(await store.getCursor('wk-one'), 'cursor-two');
  assert.deepEqual(sent, [
    {
      toUser: 'wm-one',
      openKfId: 'wk-one',
      content: '你好，请问有什么可以帮你？',
    },
  ]);
  assert.equal((await store.getMessage('message-one')).status, 'sent');
});

test('processor resumes a generated reply without calling Codex twice', async () => {
  const store = new MemoryStateStore();
  let responderCalls = 0;
  let sendCalls = 0;
  let syncCalls = 0;
  const apiClient = {
    async syncMessages() {
      syncCalls += 1;
      return {
        next_cursor: 'cursor-one',
        has_more: 0,
        msg_list: [customerTextMessage()],
      };
    },
    async sendTextMessage() {
      sendCalls += 1;

      if (sendCalls === 1) {
        throw new Error('temporary send failure');
      }

      return { errcode: 0 };
    },
  };
  const processor = new WecomMessageProcessor({
    apiClient,
    responder: {
      async respond() {
        responderCalls += 1;
        return createTextReply('已生成的回复');
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({ callbackToken: 'first', openKfId: 'wk-one' });
  assert.equal(await store.getCursor('wk-one'), '');
  assert.equal((await store.getMessage('message-one')).status, 'generated');

  await processor.enqueue({ callbackToken: 'second', openKfId: 'wk-one' });

  assert.equal(syncCalls, 2);
  assert.equal(responderCalls, 1);
  assert.equal(sendCalls, 2);
  assert.equal(await store.getCursor('wk-one'), 'cursor-one');
  assert.equal((await store.getMessage('message-one')).status, 'sent');
});

test('processor never invokes Codex for a customer outside the allowlist', async () => {
  const store = new MemoryStateStore();
  let responderCalls = 0;
  let mediaResolutionCalls = 0;
  let sendCalls = 0;
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-one',
          has_more: 0,
          msg_list: [customerTextMessage({ external_userid: 'wm-stranger' })],
        };
      },
      async sendTextMessage() {
        sendCalls += 1;
      },
    },
    responder: {
      async respond() {
        responderCalls += 1;
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        mediaResolutionCalls += 1;
        return [];
      },
    },
    store,
    allowedUserIds: ['wm-owner'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(responderCalls, 0);
  assert.equal(mediaResolutionCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(await store.getCursor('wk-one'), 'cursor-one');
  assert.equal((await store.getMessage('message-one')).status, 'ignored');
});

test('third consecutive exact trigger authorizes and confirms without Codex', async () => {
  const store = new MemoryStateStore();
  const responderInputs = [];
  const sent = [];
  const messages = [
    customerTextMessage({
      msgid: 'trigger-one',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'trigger-two',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'trigger-three',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'authorized-message',
      text: { content: '你好' },
    }),
  ];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-authorized',
          has_more: 0,
          msg_list: messages,
        };
      },
      async sendTextMessage(message) {
        sent.push(structuredClone(message));
        return { errcode: 0, msgid: `sent-${sent.length}` };
      },
    },
    responder: {
      async respond(input) {
        responderInputs.push(input);
        return createTextReply('授权后的 Codex 回复');
      },
    },
    store,
    allowedUserIds: [],
    authorization: {
      trigger: '发车',
      requiredConsecutive: 3,
      confirmationText: '暗号确认，请继续对话',
    },
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(responderInputs.length, 1);
  assert.equal(responderInputs[0].message.id, 'authorized-message');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    toUser: 'wm-one',
    openKfId: 'wk-one',
    content: '暗号确认，请继续对话',
    messageId: sent[0].messageId,
  });
  assert.match(sent[0].messageId, /^wa_[0-9a-f]{29}$/u);
  assert.equal(sent[1].content, '授权后的 Codex 回复');
  assert.equal((await store.getMessage('trigger-one')).status, 'ignored');
  assert.equal((await store.getMessage('trigger-two')).status, 'ignored');
  assert.equal((await store.getMessage('trigger-three')).status, 'sent');
  assert.equal(
    (await store.getCustomerAuthorization('wm-one')).authorized,
    true,
  );
});

test('authorization requires exact consecutive triggers and ignores duplicates', async () => {
  const store = new MemoryStateStore();
  let responderCalls = 0;
  let sendCalls = 0;
  const messages = [
    customerTextMessage({
      msgid: 'same-trigger',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'same-trigger',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'non-exact-trigger',
      text: { content: '发车 ' },
    }),
    customerTextMessage({
      msgid: 'after-reset-one',
      text: { content: '发车' },
    }),
    customerTextMessage({
      msgid: 'after-reset-two',
      text: { content: '发车' },
    }),
  ];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-not-authorized',
          has_more: 0,
          msg_list: messages,
        };
      },
      async sendTextMessage() {
        sendCalls += 1;
      },
    },
    responder: {
      async respond() {
        responderCalls += 1;
      },
    },
    store,
    allowedUserIds: [],
    authorization: {
      trigger: '发车',
      requiredConsecutive: 3,
      confirmationText: '暗号确认，请继续对话',
    },
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  const authorization = await store.getCustomerAuthorization('wm-one');
  assert.equal(authorization.authorized, false);
  assert.equal(authorization.consecutiveMatches, 2);
  assert.equal(responderCalls, 0);
  assert.equal(sendCalls, 0);
});

test('processor sends known non-image messages to Codex as context summaries', async () => {
  const store = new MemoryStateStore();
  const responderInputs = [];
  let sendCalls = 0;
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-unsupported',
          has_more: 0,
          msg_list: [
            {
              ...customerTextMessage(),
              msgid: 'voice-message',
              msgtype: 'voice',
              text: undefined,
              voice: { media_id: 'voice-media' },
            },
            {
              ...customerTextMessage(),
              msgid: 'location-message',
              msgtype: 'location',
              text: undefined,
              location: {
                name: '地点',
                address: '地址',
                latitude: 39.9,
                longitude: 116.4,
              },
            },
            {
              ...customerTextMessage(),
              msgid: 'unknown-message',
              msgtype: 'future_unknown_type',
              text: undefined,
            },
          ],
        };
      },
      async sendTextMessage() {
        sendCalls += 1;
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
    },
    responder: {
      async respond(input) {
        responderInputs.push(input);
        return createTextReply(`已记录${input.message.type}`);
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.deepEqual(
    responderInputs.map((input) => input.message.type),
    ['voice', 'location'],
  );
  assert.ok(
    responderInputs.every(
      (input) =>
        input.resolvedMedia.length === 0 && input.mediaCatalog.length === 0,
    ),
  );
  assert.equal(sendCalls, 2);
  assert.equal(await store.getCursor('wk-one'), 'cursor-unsupported');
});

test('processor steers rapid follow-ups and delivers only one final reply', async () => {
  const store = new MemoryStateStore();
  const submissions = [];
  const sent = [];
  let syncCalls = 0;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const responder = {
    async submit(input) {
      submissions.push(input.message);
      return submissions.length === 1
        ? {
            kind: 'started',
            primaryMessageId: 'rapid-one',
            completion,
          }
        : {
            kind: 'steered',
            primaryMessageId: 'rapid-one',
            completion,
          };
    },
  };
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        syncCalls += 1;
        return syncCalls === 1
          ? {
              next_cursor: 'cursor-rapid-one',
              has_more: 0,
              msg_list: [
                customerTextMessage({
                  msgid: 'rapid-one',
                  text: { content: '先介绍一下这家餐厅' },
                }),
              ],
            }
          : {
              next_cursor: 'cursor-rapid-two',
              has_more: 0,
              msg_list: [
                customerTextMessage({
                  msgid: 'rapid-two',
                  send_time: 124,
                  text: { content: '调整一下，我只想知道地址' },
                }),
              ],
            };
      },
      async sendTextMessage(message) {
        sent.push(structuredClone(message));
        return { errcode: 0, msgid: 'combined-reply' };
      },
    },
    responder,
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token-one',
    openKfId: 'wk-one',
  });
  await processor.enqueue({
    callbackToken: 'callback-token-two',
    openKfId: 'wk-one',
  });

  assert.equal(await store.getCursor('wk-one'), 'cursor-rapid-two');
  assert.equal(submissions.length, 2);
  assert.equal(sent.length, 0);
  assert.equal((await store.getMessage('rapid-one')).status, 'processing');
  const steeredRecord = await store.getMessage('rapid-two');
  assert.equal(steeredRecord.openKfId, 'wk-one');
  assert.equal(steeredRecord.externalUserId, 'wm-one');
  assert.equal(steeredRecord.primaryMessageId, 'rapid-one');
  assert.equal(steeredRecord.status, 'steered');
  assert.equal(steeredRecord.inboundMessage.id, 'rapid-two');

  resolveCompletion({
    type: 'tool_dispatch',
    dispatches: [
      {
        tool: 'send_text',
        arguments: { content: '餐厅地址：北京市海淀区甲路1号' },
      },
    ],
    receipts: [
      { wecomMsgId: 'staged-one', sentType: 'text', status: 'staged' },
    ],
    deferred: true,
    mediaCatalog: [],
  });
  await processor.waitForIdle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '餐厅地址：北京市海淀区甲路1号');
  assert.equal((await store.getMessage('rapid-one')).status, 'sent');
  assert.equal((await store.getMessage('rapid-two')).status, 'absorbed');
  assert.equal(
    (await store.getMessage('rapid-one')).sendReceipts[0].wecomMsgId,
    'combined-reply',
  );
});

test('processor records an asynchronous steerable turn failure', async () => {
  const store = new MemoryStateStore();
  let rejectCompletion;
  const completion = new Promise((_resolve, reject) => {
    rejectCompletion = reject;
  });
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-failed-turn',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'failed-primary' })],
        };
      },
      async sendTextMessage() {
        throw new Error('must not send after a failed Codex turn');
      },
    },
    responder: {
      async submit() {
        return {
          kind: 'started',
          primaryMessageId: 'failed-primary',
          completion,
        };
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });
  rejectCompletion(new Error('model unavailable'));
  await processor.waitForIdle();

  const record = await store.getMessage('failed-primary');
  assert.equal(record.status, 'failed');
  assert.equal(record.errorMessage, 'model unavailable');
  assert.equal(await store.getCursor('wk-one'), 'cursor-failed-turn');
});

test('processor uploads and sends a successful Codex-generated image', async () => {
  const store = new MemoryStateStore();
  const imageBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const uploads = [];
  const sent = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-generated-image',
          has_more: 0,
          msg_list: [
            customerTextMessage({
              msgid: 'generated-image-primary',
              text: { content: '换脸' },
            }),
          ],
        };
      },
      async sendMediaMessage(message) {
        sent.push(structuredClone(message));
        return { errcode: 0, msgid: 'generated-image-reply' };
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
      async upload(input) {
        uploads.push(input);
        return { media_id: 'uploaded-generated-image' };
      },
    },
    responder: {
      async submit() {
        return {
          kind: 'started',
          primaryMessageId: 'generated-image-primary',
          completion: Promise.resolve({
            type: 'generated_image',
            generationId: 'generation-one',
            revisedPrompt: '换脸',
            media: {
              bytes: imageBytes,
              filename: 'generated.png',
              contentType: 'image/png',
            },
          }),
        };
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });
  await processor.waitForIdle();

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bytes, imageBytes);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toUser, 'wm-one');
  assert.equal(sent[0].openKfId, 'wk-one');
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].mediaId, 'uploaded-generated-image');
  assert.match(sent[0].messageId, /^wb_[0-9a-f]{29}$/u);
  const record = await store.getMessage('generated-image-primary');
  assert.equal(record.status, 'sent');
  assert.equal(record.toolDispatches[0].tool, 'send_generated_image');
  assert.equal(record.sendReceipts[0].wecomMsgId, 'generated-image-reply');
});

test('processor recovers a persisted active turn and its follow-up', async () => {
  const store = new MemoryStateStore();
  const primaryMessage = projectWecomMessage(
    customerTextMessage({
      msgid: 'recover-primary',
      send_time: 123,
      text: { content: '第一条' },
    }),
  );
  const followUpMessage = projectWecomMessage(
    customerTextMessage({
      msgid: 'recover-follow-up',
      send_time: 124,
      text: { content: '调整方向' },
    }),
  );
  await store.setProcessingMessage('recover-primary', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    inboundMessage: primaryMessage,
  });
  await store.setSteeredMessage('recover-follow-up', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    primaryMessageId: 'recover-primary',
    inboundMessage: followUpMessage,
  });
  const submissions = [];
  const sent = [];
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const processor = new WecomMessageProcessor({
    apiClient: {
      async sendTextMessage(message) {
        sent.push(structuredClone(message));
        return { errcode: 0, msgid: 'recovered-reply' };
      },
    },
    responder: {
      async submit(input) {
        submissions.push(input.message.id);
        return submissions.length === 1
          ? {
              kind: 'started',
              primaryMessageId: 'recover-primary',
              completion,
            }
          : {
              kind: 'steered',
              primaryMessageId: 'recover-primary',
              completion,
            };
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.recoverPending();
  assert.deepEqual(submissions, ['recover-primary', 'recover-follow-up']);
  resolveCompletion(createTextReply('恢复后的合并回复'));
  await processor.waitForIdle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '恢复后的合并回复');
  assert.equal((await store.getMessage('recover-primary')).status, 'sent');
  assert.equal(
    (await store.getMessage('recover-follow-up')).status,
    'absorbed',
  );
});

test('origin=5 marks the conversation as human and suppresses Codex', async () => {
  const store = new MemoryStateStore();
  const logs = [];
  let responderCalls = 0;
  let sendCalls = 0;
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-human',
          has_more: 0,
          msg_list: [
            {
              msgid: 'human-one',
              open_kfid: 'wk-one',
              external_userid: 'wm-one',
              origin: 5,
              servicer_userid: 'admin-one',
              msgtype: 'text',
              text: { content: '批准' },
            },
            customerTextMessage({ msgid: 'customer-after-human' }),
          ],
        };
      },
      async sendTextMessage() {
        sendCalls += 1;
      },
    },
    responder: {
      async respond() {
        responderCalls += 1;
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: {
      error() {},
      warn() {},
      info(message) {
        logs.push(message);
      },
    },
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(responderCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal((await store.getSession('wk-one:wm-one')).mode, 'human');
  assert.ok(logs.some((message) => message.includes('approval_keyword=true')));
  assert.ok(logs.some((message) => message.includes('human session')));
});

test('session end event clears the human-session suppression', async () => {
  const store = new MemoryStateStore();
  await store.setSession('wk-one:wm-one', { mode: 'human' });
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-ended',
          has_more: 0,
          msg_list: [
            {
              msgid: 'event-one',
              origin: 4,
              msgtype: 'event',
              event: {
                event_type: 'session_status_change',
                open_kfid: 'wk-one',
                external_userid: 'wm-one',
                change_type: 3,
              },
            },
          ],
        };
      },
      async sendTextMessage() {},
    },
    responder: { async respond() {} },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal((await store.getSession('wk-one:wm-one')).mode, 'ended');
});

test('message-send-failure events update the matching outbound receipt', async () => {
  const store = new MemoryStateStore();
  await store.setGeneratedMessage('source-message', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    outboundMessages: [{ type: 'text', content: '测试回复' }],
  });
  await store.markChunkSent('source-message', 1, {
    wecomMsgId: 'failed-wecom-message',
    sentType: 'text',
  });
  await store.markMessageSent('source-message');
  const warnings = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-send-fail',
          has_more: 0,
          msg_list: [
            {
              msgid: 'send-failure-event',
              origin: 4,
              msgtype: 'event',
              event: {
                event_type: 'msg_send_fail',
                open_kfid: 'wk-one',
                external_userid: 'wm-one',
                fail_msgid: 'failed-wecom-message',
                fail_type: 10,
              },
            },
          ],
        };
      },
    },
    responder: { async respond() {} },
    store,
    allowedUserIds: ['wm-one'],
    logger: {
      ...silentLogger,
      warn(message) {
        warnings.push(message);
      },
    },
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  const record = await store.getMessage('source-message');
  assert.equal(record.deliveryStatus, 'failed');
  assert.equal(record.sendReceipts[0].failType, 10);
  assert.ok(warnings.some((message) => message.includes('matched=true')));
});

test('processor resolves customer images and passes them to Codex', async () => {
  const store = new MemoryStateStore();
  const sent = [];
  let resolvedMessage;
  let responderInput;
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-image',
          has_more: 0,
          msg_list: [
            {
              ...customerTextMessage(),
              msgid: 'image-message',
              msgtype: 'image',
              text: undefined,
              image: { media_id: 'image-media' },
            },
          ],
        };
      },
      async sendTextMessage(message) {
        sent.push(message);
      },
    },
    mediaGateway: {
      async resolveForCodex(message) {
        resolvedMessage = message;
        return [{ kind: 'image', bytes: png, contentType: 'image/png' }];
      },
    },
    responder: {
      async respond(input) {
        responderInput = input;
        return createTextReply('图片内容已识别');
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(resolvedMessage.type, 'image');
  assert.equal(resolvedMessage.attachments[0].mediaId, 'image-media');
  assert.equal(responderInput.message.type, 'image');
  assert.ok(responderInput.resolvedMedia[0].bytes.equals(png));
  assert.equal(sent[0].content, '图片内容已识别');
});

test('processor dispatches Codex location replies through the location API', async () => {
  const store = new MemoryStateStore();
  const locations = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-location',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'location-request' })],
        };
      },
      async sendTextMessage() {
        throw new Error('text sender should not be used');
      },
      async sendLocationMessage(message) {
        locations.push(message);
      },
    },
    responder: {
      async respond() {
        return createLocationReply({
          name: '天安门',
          address: '北京市东城区',
          latitude: 39.9087,
          longitude: 116.3975,
        });
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.deepEqual(locations, [
    {
      toUser: 'wm-one',
      openKfId: 'wk-one',
      location: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    },
  ]);
});

test('processor prefers native link messages over text fallback', async () => {
  const store = new MemoryStateStore();
  const links = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-link',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'link-request' })],
        };
      },
      async sendTextMessage() {
        throw new Error('text sender should not be used');
      },
      async sendLinkMessage(message) {
        links.push(message);
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
      async getCardThumbnailMediaId() {
        return 'thumbnail-media';
      },
    },
    responder: {
      async respond() {
        return createLinkReply({
          title: '地图',
          description: '门店地址',
          url: 'https://maps.apple.com/place?place-id=example',
        });
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.deepEqual(links, [
    {
      toUser: 'wm-one',
      openKfId: 'wk-one',
      link: {
        title: '地图',
        description: '门店地址',
        url: 'https://maps.apple.com/place?place-id=example',
      },
      thumbnailMediaId: 'thumbnail-media',
    },
  ]);
});

test('processor sends verified mini programs as native deep-link cards', async () => {
  const store = new MemoryStateStore();
  const miniPrograms = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-mini',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'mini-request' })],
        };
      },
      async sendTextMessage() {
        throw new Error('text sender should not be used');
      },
      async sendMiniProgramMessage(message) {
        miniPrograms.push(message);
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
      async getCardThumbnailMediaId() {
        return 'thumbnail-media';
      },
    },
    responder: {
      async respond() {
        return createMiniProgramReply({
          appId: 'wx1234567890abcdef',
          title: '门店小程序',
          pagePath: 'pages/store/detail?id=123',
          sourceUrl: 'https://example.com/mini-program',
        });
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.deepEqual(miniPrograms, [
    {
      toUser: 'wm-one',
      openKfId: 'wk-one',
      miniprogram: {
        appId: 'wx1234567890abcdef',
        title: '门店小程序',
        pagePath: 'pages/store/detail?id=123',
        sourceUrl: 'https://example.com/mini-program',
      },
      thumbnailMediaId: 'thumbnail-media',
    },
  ]);
});

test('processor uses text only after a native mini-program send fails', async () => {
  const store = new MemoryStateStore();
  const textMessages = [];
  const warnings = [];
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-mini-fallback',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'mini-fallback' })],
        };
      },
      async sendMiniProgramMessage() {
        throw new Error('native format unavailable');
      },
      async sendTextMessage(message) {
        textMessages.push(message);
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
      async getCardThumbnailMediaId() {
        return 'thumbnail-media';
      },
    },
    responder: {
      async respond() {
        return createMiniProgramReply({
          appId: 'wx1234567890abcdef',
          title: '门店小程序',
          pagePath: 'pages/store/index',
          sourceUrl: 'https://example.com/mini-program',
        });
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: {
      ...silentLogger,
      warn(message) {
        warnings.push(message);
      },
    },
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(textMessages.length, 1);
  assert.equal(
    textMessages[0].content,
    '门店小程序\nhttps://example.com/mini-program',
  );
  assert.ok(warnings.some((message) => message.includes('text fallback')));
});

test('processor safely re-uploads and sends a remembered customer image', async () => {
  const store = new MemoryStateStore();
  await store.rememberInboundAttachments({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'previous-image',
    attachments: [{ kind: 'image', mediaId: 'inbound-image' }],
  });
  const events = [];
  let responderCatalog;
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-media-reply',
          has_more: 0,
          msg_list: [
            customerTextMessage({
              msgid: 'image-resend-request',
              text: { content: '把刚才的原图重新发给我' },
            }),
          ],
        };
      },
      async sendTextMessage(message) {
        events.push({ type: 'text', message });
      },
      async sendMediaMessage(message) {
        events.push({ type: 'image', message });
      },
    },
    mediaGateway: {
      async resolveForCodex() {
        return [];
      },
      async cloneForSend(media) {
        assert.deepEqual(media, {
          kind: 'image',
          sourceMediaId: 'inbound-image',
          filename: '',
        });
        return 'outbound-image';
      },
    },
    responder: {
      async respond({ mediaCatalog }) {
        responderCatalog = mediaCatalog;
        return createMediaReply(
          'image',
          { reference: 'media:0', caption: '这是你刚才发送的原图：' },
          '暂时无法重新发送原图。',
        );
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  assert.equal(responderCatalog.length, 1);
  assert.equal(responderCatalog[0].ref, 'media:0');
  assert.equal(responderCatalog[0].kind, 'image');
  assert.equal(responderCatalog[0].messageId, 'previous-image');
  assert.equal(responderCatalog[0].mediaId, 'inbound-image');
  assert.deepEqual(events, [
    {
      type: 'text',
      message: {
        toUser: 'wm-one',
        openKfId: 'wk-one',
        content: '这是你刚才发送的原图：',
      },
    },
    {
      type: 'image',
      message: {
        toUser: 'wm-one',
        openKfId: 'wk-one',
        type: 'image',
        mediaId: 'outbound-image',
      },
    },
  ]);
});

test('processor records MCP tool dispatches without sending the final text twice', async () => {
  const store = new MemoryStateStore();
  let directApiCalls = 0;
  const processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        return {
          next_cursor: 'cursor-tool-dispatch',
          has_more: 0,
          msg_list: [customerTextMessage({ msgid: 'tool-dispatch-source' })],
        };
      },
      async sendTextMessage() {
        directApiCalls += 1;
      },
    },
    responder: {
      async respond() {
        return {
          type: 'tool_dispatch',
          dispatches: [
            { tool: 'send_text', arguments: { content: '工具已发送' } },
          ],
          receipts: [
            {
              wecomMsgId: 'tool-wecom-id',
              sentType: 'text',
              status: 'accepted',
            },
          ],
        };
      },
    },
    store,
    allowedUserIds: ['wm-one'],
    logger: silentLogger,
  });

  await processor.enqueue({
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });

  const record = await store.getMessage('tool-dispatch-source');
  assert.equal(directApiCalls, 0);
  assert.equal(record.status, 'sent');
  assert.equal(record.outboundMessages.length, 0);
  assert.equal(record.toolDispatches[0].tool, 'send_text');
  assert.equal(record.sendReceipts[0].wecomMsgId, 'tool-wecom-id');
});
