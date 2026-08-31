import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { AgentInput, AgentSubmission } from '../../src/agent/runtime.ts';
import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { IlinkMediaGateway } from '../../src/ilink/media-gateway.ts';
import { normalizeIlinkInboundMessage } from '../../src/ilink/message.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

test('iLink inbound traverses the shared Harness and replies through its bound MCP executor', async (t) => {
  const temp = await createTempSqlite(t, { prefix: 'ilink-harness-' });
  const now = 1_800_000_000_000;
  const botId = 'harness-bot@im.bot';
  const peerId = 'harness-user@im.wechat';
  const accountKey = createIlinkAccountKey(botId);
  const persistence = temp.openPersistence({ clock: () => now });
  const store = persistence.core;
  const ilinkStore = persistence.createIlinkStore({ clock: () => now });
  const box = new IlinkSecretBox(Buffer.alloc(32, 29).toString('base64url'));
  ilinkStore.registerAccount({
    providerAccountId: botId,
    ownerPeerId: peerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('harness-bot-token', {
      secretKind: 'bot_token', accountId: accountKey, peerId, generation: 1,
    }),
    now,
  });
  const normalized = normalizeIlinkInboundMessage({
    message_id: 41,
    seq: 41,
    from_user_id: peerId,
    to_user_id: botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: now - 1_000,
    context_token: 'harness-context-token',
    item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text: 'hello' } }],
  }, { accountKey, botId, ownerUserId: peerId }, { cursor: '', index: 0 });
  assert.ok(normalized);
  const normalizedFollowup = normalizeIlinkInboundMessage({
    message_id: 42,
    seq: 42,
    from_user_id: peerId,
    to_user_id: botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: now,
    context_token: 'harness-context-token-2',
    item_list: [
      { type: IlinkMessageItemType.TEXT, text_item: { text: 'followup' } },
      {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          media: {
            full_url:
              'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=harness',
            aes_key: Buffer.alloc(16, 6).toString('base64'),
          },
        },
      },
    ],
  }, { accountKey, botId, ownerUserId: peerId }, { cursor: '', index: 1 });
  assert.ok(normalizedFollowup);
  const page = ilinkStore.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-harness',
    messages: [
      {
        message: normalized.message,
        ...(normalized.facts.providerSeq === undefined
          ? {}
          : { providerSeq: normalized.facts.providerSeq }),
        secretGeneration: 41,
        sealedContextToken: box.seal(normalized.facts.contextToken, {
          secretKind: 'context_token', accountId: accountKey, peerId, generation: 41,
        }),
      },
      {
        message: normalizedFollowup.message,
        ...(normalizedFollowup.facts.providerSeq === undefined
          ? {}
          : { providerSeq: normalizedFollowup.facts.providerSeq }),
        secretGeneration: 42,
        sealedContextToken: box.seal(normalizedFollowup.facts.contextToken, {
          secretKind: 'context_token', accountId: accountKey, peerId, generation: 42,
        }),
        sealedImages: normalizedFollowup.facts.images.map((image) => ({
          position: image.position,
          secretGeneration: 4_200 + image.position,
          sealedLocator: box.seal(JSON.stringify({
            downloadUrl: image.downloadUrl,
            aesKey: image.aesKey,
          }), {
            secretKind: 'media_locator', accountId: accountKey, peerId,
            generation: 4_200 + image.position,
          }),
        })),
      },
    ],
  });
  const calls: unknown[] = [];
  const mediaGateway = new IlinkMediaGateway({
    store: ilinkStore,
    secretBox: box,
    async download() {
      return {
        bytes: Buffer.from('89504e470d0a1a0a0102', 'hex'),
        contentType: 'image/png',
      };
    },
  });
  const executor = new IlinkSendExecutor({
    store,
    ilinkStore,
    secretBox: box,
    createClient: () => ({
      async sendMessage(request) { calls.push(structuredClone(request)); },
    }),
  });
  const processor = new ConversationProcessor({
    store,
    agent: {
      async ensureThread(_conversationId, threadId) {
        return threadId || 'thread-ilink-independent';
      },
      activePrimary() { return undefined; },
      async submit(input: AgentInput): Promise<AgentSubmission> {
        assert.equal(input.channel, 'weixin_ilink');
        assert.match(input.contextText, /hello\nfollowup/u);
        assert.equal(input.resolvedMedia?.length, 1);
        assert.equal(input.resolvedMedia?.[0]?.contentType, 'image/png');
        const result = await executor.execute('send_text', {
          session: input.toolSessionToken,
          content: 'iLink response',
        });
        return {
          kind: 'started',
          primaryMessageKey: input.message.messageKey,
          turnId: 'ilink-turn',
          threadId: input.threadId,
          completion: Promise.resolve({ executedAttemptIds: [result.attemptId] }),
        };
      },
      async close() {},
      async abort() {},
    },
    mediaGateway,
    channel: { async kick() {} },
    allowedUserIds: [],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => processor.close());
  const messageKey = page.insertedMessageKeys[0]!;
  assert.equal(store.getInbound(messageKey)?.type, 'mixed');
  await processor.enqueue(messageKey);
  await processor.waitForIdle();
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
  assert.equal(
    store.getConversation('weixin_ilink', accountKey, peerId)?.threadId,
    'thread-ilink-independent',
  );
  assert.equal(calls.length, 1);
  assert.equal(store.listMessageAttempts(messageKey)[0]?.channel, 'weixin_ilink');
});

test('a newer iLink direction atomically absorbs older unprocessed input', async (t) => {
  const temp = await createTempSqlite(t, { prefix: 'ilink-recovery-window-' });
  const now = 1_800_000_000_000;
  const botId = 'recovery-bot@im.bot';
  const peerId = 'recovery-user@im.wechat';
  const accountKey = createIlinkAccountKey(botId);
  const persistence = temp.openPersistence({ clock: () => now });
  const store = persistence.core;
  const ilinkStore = persistence.createIlinkStore({ clock: () => now });
  const box = new IlinkSecretBox(Buffer.alloc(32, 18).toString('base64url'));
  ilinkStore.registerAccount({
    providerAccountId: botId,
    ownerPeerId: peerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('recovery-token', {
      secretKind: 'bot_token', accountId: accountKey, peerId, generation: 1,
    }),
    now,
  });
  const normalized = (id: number, cursor: string, text: string) => {
    const value = normalizeIlinkInboundMessage({
      message_id: id,
      seq: id,
      from_user_id: peerId,
      to_user_id: botId,
      message_type: IlinkMessageType.USER,
      message_state: IlinkMessageState.FINISH,
      create_time_ms: now - 10 + id,
      context_token: `context-${id}`,
      item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text } }],
    }, { accountKey, botId, ownerUserId: peerId }, {
      cursor,
      index: 0,
    });
    assert.ok(value);
    return value;
  };
  const entry = (value: NonNullable<ReturnType<typeof normalized>>) => ({
    message: value.message,
    ...(value.facts.providerSeq === undefined
      ? {}
      : { providerSeq: value.facts.providerSeq }),
    secretGeneration: value.facts.providerSeq!,
    sealedContextToken: box.seal(value.facts.contextToken, {
      secretKind: 'context_token', accountId: accountKey, peerId,
      generation: value.facts.providerSeq!,
    }),
  });
  const oldPage = ilinkStore.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-old',
    messages: [entry(normalized(1, '', 'older input'))],
  });
  const currentPage = ilinkStore.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-old',
    nextCursor: 'cursor-current',
    messages: [entry(normalized(2, 'cursor-old', 'newer input'))],
  });
  const oldKey = oldPage.insertedMessageKeys[0]!;
  const currentKey = currentPage.insertedMessageKeys[0]!;
  const currentWindow = ilinkStore.getReplyWindowSecretBySource(currentKey);
  assert.ok(currentWindow);
  assert.equal(store.getInbound(oldKey)?.status, 'absorbed');
  assert.equal(store.getInbound(currentKey)?.status, 'received');

  const sent: string[] = [];
  const executor = new IlinkSendExecutor({
    store,
    ilinkStore,
    secretBox: box,
    createClient: () => ({
      async sendMessage(request) {
        sent.push(request.msg.item_list?.[0]?.text_item?.text || '');
      },
    }),
  });
  const processor = new ConversationProcessor({
    store,
    agent: {
      async ensureThread(_conversationId, threadId) {
        return threadId || 'thread-recovery-current-window';
      },
      activePrimary() { return undefined; },
      async submit(input: AgentInput): Promise<AgentSubmission> {
        assert.match(input.contextText, /older input\nnewer input/u);
        const session = store.getAgentSession(input.toolSessionToken);
        assert.equal(session.replyWindowId, currentWindow.replyWindowId);
        const result = await executor.execute('send_text', {
          session: input.toolSessionToken,
          content: 'merged direction reply',
        });
        return {
          kind: 'started',
          primaryMessageKey: input.message.messageKey,
          turnId: 'recovery-turn',
          threadId: input.threadId,
          completion: Promise.resolve({ executedAttemptIds: [result.attemptId] }),
        };
      },
      async close() {},
      async abort() {},
    },
    mediaGateway: { async resolveForCodex() { return []; } },
    channel: { async kick() {} },
    allowedUserIds: [],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => processor.close());
  await processor.enqueue(currentKey);
  await processor.waitForIdle();

  assert.equal(store.getInbound(oldKey)?.status, 'absorbed');
  assert.equal(store.getInbound(currentKey)?.status, 'completed');
  assert.deepEqual(sent, ['merged direction reply']);
  assert.equal(
    Number(store.listMessageAttempts(currentKey)[0]?.metadata?.direction),
    store.getInbound(currentKey)?.inboxSeq,
  );
});
