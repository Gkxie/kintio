import assert from 'node:assert/strict';
import { describe, it, test } from 'vitest';

import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { IlinkMediaError } from '../../src/ilink/media.ts';
import { normalizeIlinkInboundMessage } from '../../src/ilink/message.ts';
import { IlinkProtocolError } from '../../src/ilink/protocol/client.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { IlinkSqliteStore } from '../../src/ilink/sqlite-store.ts';
import {
  ILINK_REPLY_WINDOW_LIFETIME_MS,
  createIlinkAccountKey,
} from '../../src/ilink/store-types.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

const botId = 'executor-bot@im.bot';
const peerId = 'executor-owner@im.wechat';
const accountKey = createIlinkAccountKey(botId);
const key = Buffer.alloc(32, 19).toString('base64url');

async function fixture(
  t: Parameters<typeof createTempSqlite>[0],
  messageAgeMs = 1_000,
) {
  const temp = await createTempSqlite(t, { prefix: 'ilink-executor-' });
  let now = 1_800_000_000_000;
  const store = temp.trackSqlite(new SqliteStore({ filePath: temp.filePath, clock: () => now }));
  const ilinkStore = new IlinkSqliteStore({ store, clock: () => now });
  const box = new IlinkSecretBox(key);
  ilinkStore.registerAccount({
    providerAccountId: botId,
    ownerPeerId: peerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('bot-secret', {
      secretKind: 'bot_token', accountId: accountKey, peerId, generation: 1,
    }),
    now,
  });
  const normalized = normalizeIlinkInboundMessage({
    message_id: 1,
    seq: 1,
    from_user_id: peerId,
    to_user_id: botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: now - messageAgeMs,
    context_token: 'context-secret',
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text: 'hello' },
    }],
  }, { accountKey, botId, ownerUserId: peerId }, { cursor: 'initial', index: 0 });
  assert.ok(normalized);
  const candidate = Object.freeze({
    ...normalized,
    sync: Object.freeze({ cursor: '', index: 0 }),
  });
  const committed = ilinkStore.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-one',
    messages: [{
      candidate,
      secretGeneration: 101,
      sealedContextToken: box.seal(candidate.contextToken, {
        secretKind: 'context_token', accountId: accountKey, peerId, generation: 101,
      }),
    }],
  });
  const messageKey = committed.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey });
  const session = store.createAgentSession({ messageKey });
  return {
    store,
    ilinkStore,
    box,
    session,
    messageKey,
    advance(milliseconds: number) { now += milliseconds; },
  };
}

test('iLink executor resolves encrypted routing from the session and sends text', async (t) => {
  const created = await fixture(t);
  const calls: unknown[] = [];
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: ({ token, baseUrl }) => {
      assert.equal(token, 'bot-secret');
      assert.equal(baseUrl, 'https://ilinkai.weixin.qq.com/');
      return { async sendMessage(request) { calls.push(structuredClone(request)); } };
    },
  });
  const result = await executor.execute('send_text', {
    session: created.session.token,
    content: '通过 iLink 回复',
  });
  assert.equal(result.status, 'accepted');
  assert.match(result.attemptId, /^sa_/u);
  assert.equal(calls.length, 1);
  const request = calls[0] as {
    msg: { to_user_id: string; context_token: string; item_list: unknown[] };
  };
  assert.equal(request.msg.to_user_id, peerId);
  assert.equal(request.msg.context_token, 'context-secret');
  assert.deepEqual(request.msg.item_list, [{
    type: IlinkMessageItemType.TEXT,
    text_item: { text: '通过 iLink 回复' },
  }]);
  const attempt = created.store.listMessageAttempts(created.messageKey)[0];
  assert.equal(attempt?.channel, 'weixin_ilink');
  assert.equal(attempt?.status, 'accepted');
  assert.doesNotMatch(JSON.stringify(attempt?.payload), /context-secret|bot-secret/u);
});

test('WeChat delivery failures cannot change iLink attempts in either order', async (t) => {
  const created = await fixture(t);
  let failBeforeResponse = false;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage(request) {
        const clientId = String(request.msg.client_id || '');
        if (failBeforeResponse) {
          created.store.markSendMsgFailed({ wecomMsgId: clientId, failType: 13 });
        }
      },
    }),
  });

  for (const [index, beforeResponse] of [false, true].entries()) {
    failBeforeResponse = beforeResponse;
    const result = await executor.execute('send_text', {
      session: created.session.token,
      content: `message-${index}`,
    });
    assert.equal(result.status, 'accepted');
    if (!beforeResponse) {
      assert.equal(created.store.markSendMsgFailed({
        wecomMsgId: result.msgid,
        failType: 13,
      }), false);
    }
    assert.equal(created.store.getAttempt(result.attemptId)?.status, 'accepted');
  }
});

test('iLink session cannot trigger any WeChat KF media or send side effect', async (t) => {
  const created = await fixture(t);
  const calls = { upload: 0, clone: 0, thumbnail: 0, send: 0, offer: 0 };
  const executor = new WechatKfToolExecutor({
    store: created.store,
    apiClient: {
      async sendPreparedMessage() {
        calls.send += 1;
        return { msgid: 'must-not-send' };
      },
    },
    mediaGateway: {
      async upload() {
        calls.upload += 1;
        return { media_id: 'must-not-upload' };
      },
      async cloneForSend() {
        calls.clone += 1;
        return 'must-not-clone';
      },
      async getCardThumbnailMediaId() {
        calls.thumbnail += 1;
        return 'must-not-thumbnail';
      },
    },
    ilinkOffers: {
      async offer() {
        calls.offer += 1;
        return { offerId: 'must-not-offer', png: Buffer.alloc(8) };
      },
      cancel() {},
    },
    observeMs: 0,
  });
  const session = created.session.token;
  for (const [tool, input] of [
    ['send_text', { content: 'text' }],
    ['send_image', { mediaRef: 'media:0' }],
    ['send_link', { title: 'link', description: '', url: 'https://example.com' }],
    ['send_miniprogram', {
      appId: 'wx1234567890abcdef', title: 'mini', pagePath: '/pages/index',
      sourceUrl: 'https://example.com',
    }],
    ['send_location', {
      name: 'location', address: 'address', latitude: 1, longitude: 2,
    }],
    ['offer_weixin_bot_channel', {}],
  ] as const) {
    await assert.rejects(
      executor.execute(tool, { session, ...input }),
      (error: unknown) => Boolean(
        error && typeof error === 'object' && 'code' in error &&
        error.code === 'wrong_channel',
      ),
    );
  }
  assert.deepEqual(calls, { upload: 0, clone: 0, thumbnail: 0, send: 0, offer: 0 });
});

test('iLink executor distinguishes definitive and uncertain failures without retry', async (t) => {
  const created = await fixture(t);
  const failures: Error[] = [
    new IlinkProtocolError('business', 'rejected', { ret: -2 }),
    new IlinkProtocolError('transport', 'network failed'),
    new IlinkProtocolError('http', 'forbidden', { status: 403 }),
  ];
  let calls = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage() {
        calls += 1;
        throw failures.shift()!;
      },
    }),
  });
  const rejected = await executor.execute('send_text', {
    session: created.session.token,
    content: 'first',
  });
  const uncertain = await executor.execute('send_text', {
    session: created.session.token,
    content: 'second',
  });
  const forbidden = await executor.execute('send_text', {
    session: created.session.token,
    content: 'third',
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error?.kind, 'ilink_delivery_failed');
  assert.equal(rejected.error?.ret, -2);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.error?.kind, 'uncertain_result');
  assert.equal(forbidden.status, 'failed');
  assert.equal(forbidden.error?.code, 403);
  assert.equal(calls, 3);
  const invalid = await executor.execute('send_text', {
    session: `ws_${'x'.repeat(32)}`,
    content: 'invalid session',
  });
  assert.equal(invalid.error?.kind, 'ilink_session_invalid');
  const unsupported = await (executor.execute as unknown as (
    tool: string,
    input: { session: string; content: string },
  ) => Promise<typeof invalid>)('other', {
    session: created.session.token,
    content: 'unsupported',
  });
  assert.equal(unsupported.status, 'failed');
});

describe('iLink reply window', () => {
it('allows at most ten serialized sends', async (t) => {
  const created = await fixture(t);
  let active = 0;
  let peak = 0;
  let sent = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage() {
        sent += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      },
    }),
  });
  const results = await Promise.all(Array.from({ length: 11 }, (_, index) =>
    executor.execute('send_text', {
      session: created.session.token,
      content: `parallel-${index}`,
    }),
  ));
  assert.equal(results.filter((result) => result.status === 'accepted').length, 10);
  assert.equal(results.filter((result) => result.status === 'failed').length, 1);
  assert.equal(peak, 1);
  assert.equal(sent, 10);
  assert.equal(results.filter((result) => result.error?.kind === 'reply_quota_exhausted').length, 1);
  const attempts = created.store.listMessageAttempts(created.messageKey);
  assert.deepEqual(attempts.map((item) => item.sendIndex),
    Array.from({ length: 11 }, (_, index) => index));
  assert.deepEqual(attempts.at(-1) && {
    status: attempts.at(-1)?.status,
    errorCode: attempts.at(-1)?.errorCode,
  }, { status: 'failed', errorCode: 'reply_quota_exhausted' });
  assert.match(results.at(-1)?.attemptId || '', /^sa_/u);
  assert.equal(created.store.finalizeAgentExecution({
    messageKey: created.messageKey,
    attemptIds: results.map((result) => result.attemptId),
  }).status, 'completed');
});

it('rejects the eleventh image before media or provider HTTP', async (t) => {
  const created = await fixture(t);
  const [media] = created.store.rememberInboundMedia({
    messageKey: created.messageKey,
    attachments: [{ kind: 'image', mediaId: 'ilink:0', filename: 'source.jpg' }],
  });
  assert.ok(media);
  const session = created.store.createAgentSession({ messageKey: created.messageKey });
  let clients = 0;
  let resolved = 0;
  let uploaded = 0;
  let sent = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    mediaGateway: {
      async resolveReference() {
        resolved += 1;
        return {
          kind: 'image' as const,
          bytes: Buffer.from('ffd8ffda0008000100003f00ffd9', 'hex'),
          contentType: 'image/jpeg' as const,
        };
      },
    },
    createClient: () => {
      clients += 1;
      return { async sendMessage() { sent += 1; } };
    },
    async uploadImage() {
      uploaded += 1;
      throw new Error('must not upload');
    },
  });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await executor.execute('send_text', {
      session: session.token,
      content: `quota-${index}`,
    })).status, 'accepted');
  }
  const rejected = await executor.execute('send_image', {
    session: session.token,
    mediaRef: media.ref,
  });
  assert.deepEqual({ status: rejected.status, kind: rejected.error?.kind }, {
    status: 'failed',
    kind: 'reply_quota_exhausted',
  });
  assert.match(rejected.attemptId, /^sa_/u);
  assert.deepEqual({ clients, resolved, uploaded, sent }, {
    clients: 10,
    resolved: 0,
    uploaded: 0,
    sent: 10,
  });
  assert.deepEqual(created.ilinkStore.getReplyWindow(session.replyWindowId) && {
    next: created.ilinkStore.getReplyWindow(session.replyWindowId)?.nextSendIndex,
    reserved: created.ilinkStore.getReplyWindow(session.replyWindowId)?.reservedSendCount,
    transmitted: created.ilinkStore.getReplyWindow(session.replyWindowId)?.transmittedSendCount,
  }, { next: 10, reserved: 0, transmitted: 10 });
});

it('expires exactly 24 hours after the inbound message, including after cleanup', async (t) => {
  const created = await fixture(t, ILINK_REPLY_WINDOW_LIFETIME_MS);
  created.store.cleanup();
  assert.equal(
    created.ilinkStore.getReplyWindow(created.session.replyWindowId)?.state,
    'open',
  );
  assert.equal(
    created.ilinkStore.getReplyWindowSecret(created.session.replyWindowId),
    undefined,
  );
  const [media] = created.store.rememberInboundMedia({
    messageKey: created.messageKey,
    attachments: [{ kind: 'image', mediaId: 'ilink:0', filename: 'source.jpg' }],
  });
  assert.ok(media);
  const session = created.store.createAgentSession({ messageKey: created.messageKey });
  let clients = 0;
  let resolved = 0;
  let uploaded = 0;
  let sent = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    mediaGateway: {
      async resolveReference() {
        resolved += 1;
        throw new Error('must not resolve');
      },
    },
    createClient: () => {
      clients += 1;
      return { async sendMessage() { sent += 1; } };
    },
    async uploadImage() {
      uploaded += 1;
      throw new Error('must not upload');
    },
  });
  const rejected = await executor.execute('send_image', {
    session: session.token,
    mediaRef: media.ref,
  });
  assert.deepEqual({ status: rejected.status, kind: rejected.error?.kind }, {
    status: 'failed',
    kind: 'reply_window_expired',
  });
  assert.match(rejected.attemptId, /^sa_/u);
  assert.deepEqual({ clients, resolved, uploaded, sent }, {
    clients: 0,
    resolved: 0,
    uploaded: 0,
    sent: 0,
  });
  assert.deepEqual(created.ilinkStore.getReplyWindow(session.replyWindowId) && {
    next: created.ilinkStore.getReplyWindow(session.replyWindowId)?.nextSendIndex,
    reserved: created.ilinkStore.getReplyWindow(session.replyWindowId)?.reservedSendCount,
    transmitted: created.ilinkStore.getReplyWindow(session.replyWindowId)?.transmittedSendCount,
  }, { next: 0, reserved: 0, transmitted: 0 });
  assert.equal(created.store.finalizeAgentExecution({
    messageKey: created.messageKey,
    attemptIds: [rejected.attemptId],
  }).status, 'completed');
});

it('revalidates after media download and preserves the exact expiry reason', async (t) => {
  const created = await fixture(t, ILINK_REPLY_WINDOW_LIFETIME_MS - 1_000);
  const [media] = created.store.rememberInboundMedia({
    messageKey: created.messageKey,
    attachments: [{ kind: 'image', mediaId: 'ilink:0', filename: 'source.jpg' }],
  });
  assert.ok(media);
  const session = created.store.createAgentSession({ messageKey: created.messageKey });
  let clients = 0;
  let resolved = 0;
  let uploaded = 0;
  let sent = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    mediaGateway: {
      async resolveReference() {
        resolved += 1;
        created.advance(1_000);
        return {
          kind: 'image' as const,
          bytes: Buffer.from('ffd8ffda0008000100003f00ffd9', 'hex'),
          contentType: 'image/jpeg' as const,
        };
      },
    },
    createClient: () => {
      clients += 1;
      return { async sendMessage() { sent += 1; } };
    },
    async uploadImage() {
      uploaded += 1;
      throw new Error('must not upload after expiry');
    },
  });
  const rejected = await executor.execute('send_image', {
    session: session.token,
    mediaRef: media.ref,
  });
  assert.deepEqual({
    status: rejected.status,
    kind: rejected.error?.kind,
    durableCode: created.store.getAttempt(rejected.attemptId)?.errorCode,
  }, {
    status: 'failed',
    kind: 'reply_window_expired',
    durableCode: 'reply_window_expired',
  });
  assert.deepEqual({ clients, resolved, uploaded, sent }, {
    clients: 1,
    resolved: 1,
    uploaded: 0,
    sent: 0,
  });
});
});

test('host queue notice uses the same iLink window and consumes one real send', async (t) => {
  const created = await fixture(t);
  const calls: unknown[] = [];
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage(request) { calls.push(structuredClone(request)); },
    }),
  });
  await executor.notifyQueued(created.messageKey);
  const attempt = created.store.listMessageAttempts(created.messageKey)[0];
  assert.equal(attempt?.source, 'queue_notice');
  assert.equal(attempt?.status, 'accepted');
  assert.equal(
    created.ilinkStore.getReplyWindow(created.session.replyWindowId)
      ?.transmittedSendCount,
    1,
  );
  assert.equal(calls.length, 1);
});

test('a slow queue notice is serialized before the formal Agent reply', async (t) => {
  const created = await fixture(t);
  let releaseNotice!: () => void;
  let noticeStarted!: () => void;
  const noticeGate = new Promise<void>((resolve) => { releaseNotice = resolve; });
  const started = new Promise<void>((resolve) => { noticeStarted = resolve; });
  const contents: string[] = [];
  let active = 0;
  let peak = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage(request) {
        const content = request.msg.item_list?.[0]?.text_item?.text || '';
        contents.push(content);
        active += 1;
        peak = Math.max(peak, active);
        if (content === 'Your conversation is queued. Please wait.') {
          noticeStarted();
          await noticeGate;
        }
        active -= 1;
      },
    }),
  });

  const notice = executor.notifyQueued(created.messageKey);
  await started;
  const reply = executor.execute('send_text', {
    session: created.session.token,
    content: '正式回复',
  });
  let idle = false;
  const waiting = executor.waitForIdle().then(() => { idle = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  assert.deepEqual(contents, ['Your conversation is queued. Please wait.']);

  releaseNotice();
  const [, result] = await Promise.all([notice, reply]);
  await waiting;
  assert.equal(result.status, 'accepted');
  assert.equal(peak, 1);
  assert.deepEqual(contents, ['Your conversation is queued. Please wait.', '正式回复']);
  assert.deepEqual(
    created.store.listMessageAttempts(created.messageKey).map((attempt) => ({
      source: attempt.source,
      status: attempt.status,
    })),
    [
      { source: 'queue_notice', status: 'accepted' },
      { source: 'mcp_tool', status: 'accepted' },
    ],
  );
});

test('iLink executor uploads and sends a session-bound generated image', async (t) => {
  const created = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
  const mediaRef = created.store.registerAgentArtifact({
    sessionToken: created.session.token,
    bytes: png,
    filename: 'generated.png',
    contentType: 'image/png',
    metadata: {
      generationId: 'ilink-generation-one',
      revisedPrompt: 'keep the subject and replace only the background',
    },
  });
  const sends: unknown[] = [];
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage(request) { sends.push(structuredClone(request)); },
    }),
    async uploadImage(input) {
      assert.deepEqual(input.bytes, png);
      assert.equal(input.peerId, peerId);
      return {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: 'uploaded-image',
            aes_key: Buffer.alloc(16, 1).toString('base64'),
            encrypt_type: 1,
          },
          mid_size: 16,
        },
      };
    },
  });
  const result = await executor.execute('send_image', {
    session: created.session.token,
    mediaRef,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.type, 'image');
  assert.equal(sends.length, 1);
  assert.equal(
    (sends[0] as { msg: { item_list: Array<{ type: number }> } })
      .msg.item_list[0]?.type,
    IlinkMessageItemType.IMAGE,
  );
  assert.deepEqual(created.store.getAttempt(result.attemptId)?.metadata, {
    direction: created.store.getInbound(created.messageKey)?.inboxSeq,
    generationId: 'ilink-generation-one',
    replyWindowSendIndex: 0,
    revisedPrompt: 'keep the subject and replace only the background',
    tool: 'generated_image',
  });
});

test('iLink executor can resend only inbound media bound to the current session', async (t) => {
  const created = await fixture(t);
  const [remembered] = created.store.rememberInboundMedia({
    messageKey: created.messageKey,
    attachments: [{ kind: 'image', mediaId: 'ilink:0', filename: 'source.jpg' }],
  });
  assert.ok(remembered);
  const session = created.store.createAgentSession({ messageKey: created.messageKey });
  const jpeg = Buffer.from('ffd8ffda0008000100003f00ffd9', 'hex');
  const resolved: Array<{ messageKey: string; mediaId: string }> = [];
  let uploaded = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    mediaGateway: {
      async resolveReference(input) {
        resolved.push({ ...input });
        return { kind: 'image', bytes: jpeg, contentType: 'image/jpeg' };
      },
    },
    createClient: () => ({ async sendMessage() {} }),
    async uploadImage(input) {
      uploaded += 1;
      assert.deepEqual(input.bytes, jpeg);
      return {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: 'resent-inbound',
            aes_key: Buffer.alloc(16, 3).toString('base64'),
            encrypt_type: 1,
          },
          mid_size: jpeg.length,
        },
      };
    },
  });
  const accepted = await executor.execute('send_image', {
    session: session.token,
    mediaRef: remembered.ref,
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(resolved, [{ messageKey: created.messageKey, mediaId: 'ilink:0' }]);
  assert.equal(uploaded, 1);

  const rejected = await executor.execute('send_image', {
    session: session.token,
    mediaRef: 'media:9',
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error?.kind, 'invalid_media_reference');
  assert.equal(uploaded, 1);
});

test('image upload has a durable pending attempt and releases quota before sendmessage', async (t) => {
  const created = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
  const mediaRef = created.store.registerAgentArtifact({
    sessionToken: created.session.token,
    bytes: png,
    filename: 'generated.png',
    contentType: 'image/png',
  });
  let sends = 0;
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({ async sendMessage() { sends += 1; } }),
    async uploadImage() {
      assert.equal(
        created.store.listMessageAttempts(created.messageKey)[0]?.status,
        'pending',
      );
      throw new IlinkMediaError('upload_failed', 'upload failed before sendmessage');
    },
  });
  const result = await executor.execute('send_image', {
    session: created.session.token,
    mediaRef,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.kind, 'media_prepare_failed');
  assert.equal(result.attemptId, created.store.listMessageAttempts(created.messageKey)[0]?.attemptId);
  assert.equal(sends, 0);
  assert.equal(
    created.ilinkStore.getReplyWindow(created.session.replyWindowId)
      ?.transmittedSendCount,
    0,
  );
  assert.equal(
    created.ilinkStore.getReplyWindow(created.session.replyWindowId)
      ?.reservedSendCount,
    0,
  );
});

test('image sendmessage returns definitive and uncertain channel facts', async (t) => {
  const created = await fixture(t);
  const mediaRef = created.store.registerAgentArtifact({
    sessionToken: created.session.token,
    bytes: Buffer.from('89504e470d0a1a0a01020304', 'hex'),
    filename: 'generated.png',
    contentType: 'image/png',
  });
  const failures: Error[] = [
    new IlinkProtocolError('business', 'image rejected', { ret: -3 }),
    new IlinkProtocolError('transport', 'socket closed'),
  ];
  const executor = new IlinkSendExecutor({
    store: created.store,
    ilinkStore: created.ilinkStore,
    secretBox: created.box,
    createClient: () => ({
      async sendMessage() { throw failures.shift()!; },
    }),
    async uploadImage() {
      return {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: 'uploaded',
            aes_key: Buffer.alloc(16, 2).toString('base64'),
            encrypt_type: 1,
          },
          mid_size: 16,
        },
      };
    },
  });
  const rejected = await executor.execute('send_image', {
    session: created.session.token,
    mediaRef,
  });
  const uncertain = await executor.execute('send_image', {
    session: created.session.token,
    mediaRef,
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error?.ret, -3);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.error?.kind, 'uncertain_result');
});
