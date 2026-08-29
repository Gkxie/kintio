import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, test } from 'vitest';
import type { TestContext } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import {
  createWechatKfMcpServer,
  handleWechatKfMcpRequest,
} from '../../src/mcp/wechat-kf-server.ts';
import {
  WechatKfToolExecutor,
  type WechatToolReceipt,
} from '../../src/mcp/wechat-kf-executor.ts';
import { WecomApiError } from '../../src/services/wecom-api.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';

type SendInput = {
  toUser: string;
  openKfId: string;
  payload: Record<string, unknown>;
  messageId?: string;
};

async function harness(
  t: TestContext,
  options: {
    observeMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    withImage?: boolean;
    failMediaPreparation?: boolean;
    sendPreparedMessage?: (input: SendInput) => Promise<Record<string, unknown>>;
    ilinkOffers?: {
      offer(sessionToken: string): Promise<{ offerId: string; png: Buffer }>;
      cancel(offerId: string): void;
    };
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-mcp-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  const normalized = normalizeWecomMessage({
    msgid: 'customer-one',
    open_kfid: 'wk-one',
    external_userid: 'wm-one',
    origin: 3,
    msgtype: 'text',
    text: { content: '测试' },
  }, 'wk-one');
  const page = store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [normalized],
  });
  const messageKey = page.insertedMessageKeys[0];
  if (!messageKey) throw new Error('Missing test message');
  store.claimInbound({ messageKey });
  if (options.withImage) {
    store.rememberInboundMedia({
      messageKey,
      attachments: [{ kind: 'image', mediaId: 'source-media', filename: 'source.png' }],
    });
  }
  const session = store.createAgentSession({ messageKey });
  const sends: SendInput[] = [];
  const mediaCalls = { upload: 0, clone: 0, thumbnail: 0 };
  const executor = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage(input: SendInput) {
        sends.push(structuredClone(input));
        if (options.sendPreparedMessage) return options.sendPreparedMessage(input);
        return { msgid: `wx-${sends.length}` };
      },
    },
    mediaGateway: {
      async upload() {
        mediaCalls.upload += 1;
        if (options.failMediaPreparation) throw new Error('media offline');
        return { media_id: 'uploaded-media' };
      },
      async cloneForSend() {
        mediaCalls.clone += 1;
        if (options.failMediaPreparation) throw new Error('media offline');
        return 'cloned-media';
      },
      async getCardThumbnailMediaId() {
        mediaCalls.thumbnail += 1;
        if (options.failMediaPreparation) throw new Error('media offline');
        return 'thumbnail-media';
      },
    },
    observeMs: options.observeMs ?? 0,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.ilinkOffers ? { ilinkOffers: options.ilinkOffers } : {}),
  });
  const server = createWechatKfMcpServer(executor);
  const client = new Client({ name: 'wechat-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.onTestFinished(async () => {
    await client.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { client, store, messageKey, session, sends, mediaCalls, executor };
}

async function receiptHarness(
  t: TestContext,
  values: Array<WechatToolReceipt | Error>,
) {
  const server = createWechatKfMcpServer({
    async execute() {
      const value = values.shift();
      if (!value) throw new Error('missing fake receipt');
      if (value instanceof Error) throw value;
      return value;
    },
  });
  const client = new Client({ name: 'wechat-receipt-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.onTestFinished(() => client.close());
  return client;
}

describe('WeChat MCP receipt boundary', () => {
  it('replaces thrown and provider error text with stable channel facts', async (t) => {
    const stale = Object.assign(
      new Error('token=throw-canary /root/private/state.sqlite'),
      { code: 'stale_agent_session' },
    );
    const client = await receiptHarness(t, [
      stale,
      {
        status: 'failed',
        attemptId: 'sa_provider_rejected',
        sendIndex: 0,
        type: 'text',
        msgid: '',
        error: {
          kind: 'wechat_delivery_failed',
          message: 'provider-secret-canary /www/private',
          code: 40000,
        },
      },
      {
        status: 'uncertain',
        attemptId: 'sa_provider_uncertain',
        sendIndex: 1,
        type: 'text',
        msgid: '',
        error: {
          kind: 'uncertain_result',
          message: 'transport-secret-canary /home/private',
        },
      },
    ]);
    const session = `ws_${'s'.repeat(32)}`;
    const staleResult = await client.callTool({
      name: 'send_text',
      arguments: { session, content: 'one' },
    });
    const rejectedResult = await client.callTool({
      name: 'send_text',
      arguments: { session, content: 'two' },
    });
    const uncertainResult = await client.callTool({
      name: 'send_text',
      arguments: { session, content: 'three' },
    });

    assert.deepEqual(staleResult.structuredContent, {
      status: 'failed',
      attemptId: '',
      sendIndex: -1,
      type: 'text',
      msgid: '',
      error: {
        kind: 'stale_agent_session',
        message: 'This conversation direction is stale. Continue from the participant\'s latest message.',
      },
    });
    assert.deepEqual(rejectedResult.structuredContent, {
      status: 'failed',
      attemptId: 'sa_provider_rejected',
      sendIndex: 0,
      type: 'text',
      msgid: '',
      error: {
        kind: 'wechat_delivery_failed',
        message: 'The channel rejected this message.',
        code: 40000,
      },
    });
    assert.deepEqual(uncertainResult.structuredContent, {
      status: 'uncertain',
      attemptId: 'sa_provider_uncertain',
      sendIndex: 1,
      type: 'text',
      msgid: '',
      error: {
        kind: 'uncertain_result',
        message: 'The delivery result is uncertain and the message may already have been sent. Do not retry merely because the outcome is unknown.',
      },
    });
    assert.equal(staleResult.isError, true);
    assert.equal(rejectedResult.isError, true);
    assert.equal(uncertainResult.isError, undefined);
    assert.doesNotMatch(
      JSON.stringify([staleResult, rejectedResult, uncertainResult]),
      /throw-canary|provider-secret-canary|transport-secret-canary|\/(?:root|www|home)\//u,
    );
  });

  it('rejects malformed executor receipts without exposing extra fields', async (t) => {
    const client = await receiptHarness(t, [{
      status: 'failed',
      attemptId: 'sa_malformed',
      sendIndex: 0,
      type: 'text',
      msgid: '',
      error: {
        kind: 'wechat_delivery_failed',
        message: 'must-not-leak',
      },
      corpId: 'corp-must-not-leak',
    } as unknown as WechatToolReceipt]);
    const result = await client.callTool({
      name: 'send_text',
      arguments: { session: `ws_${'m'.repeat(32)}`, content: 'hello' },
    });
    assert.deepEqual(result.structuredContent, {
      status: 'failed',
      attemptId: '',
      sendIndex: -1,
      type: 'text',
      msgid: '',
      error: {
        kind: 'wechat_tool_error',
        message: 'The adapter tool could not execute this operation.',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|corpId/u);
  });
});

test('iLink offer tool sends an in-memory QR image through the bound KF session', async (t) => {
  const offers: string[] = [];
  const created = await harness(t, {
    ilinkOffers: {
      async offer(sessionToken) {
        assert.match(sessionToken, /^ws_/u);
        return { offerId: 'offer-one', png: Buffer.from('png-bytes') };
      },
      cancel(offerId) { offers.push(offerId); },
    },
  });
  const result = await created.client.callTool({
    name: 'offer_weixin_bot_channel',
    arguments: { session: created.session.token },
  });
  assert.equal(result.isError, undefined);
  assert.equal(created.mediaCalls.upload, 1);
  assert.deepEqual(created.sends[0]?.payload, {
    msgtype: 'image', image: { media_id: 'uploaded-media' },
  });
  assert.deepEqual(offers, []);
});

test('a definitively rejected QR image cancels its background login offer', async (t) => {
  const cancelled: string[] = [];
  const created = await harness(t, {
    ilinkOffers: {
      async offer() { return { offerId: 'offer-rejected', png: Buffer.from('png') }; },
      cancel(offerId) { cancelled.push(offerId); },
    },
    async sendPreparedMessage() {
      throw new WecomApiError('rejected', { code: 40001 });
    },
  });
  const result = await created.client.callTool({
    name: 'offer_weixin_bot_channel',
    arguments: { session: created.session.token },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(cancelled, ['offer-rejected']);
});

test('WeChat MCP exposes delivery tools without participant or credential fields', async (t) => {
  const { client } = await harness(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'offer_weixin_bot_channel',
    'send_image',
    'send_link',
    'send_location',
    'send_miniprogram',
    'send_text',
  ]);
  const serialized = JSON.stringify(listed.tools);
  for (const forbidden of [
    'toUser', 'externalUserId', 'openKfId', 'corpId', 'secret', 'mediaId',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /session/u);
});

test('Streamable HTTP MCP requires the configured bearer token', async (t) => {
  const created = await harness(t);
  const request = new Request('https://robot.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const missing = await handleWechatKfMcpRequest({
    request,
    executor: created.executor,
    bearerToken: 'correct-token',
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
});

test('standard HTTP MCP Client executes through the Hono handler', async (t) => {
  const created = await harness(t);
  const bearerToken = 'http-mcp-test-bearer-token';
  const transport = new StreamableHTTPClientTransport(
    new URL('https://robot.example/mcp'),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
      fetch: async (input, init) => handleWechatKfMcpRequest({
        request: new Request(input, init),
        executor: created.executor,
        bearerToken,
      }),
    },
  );
  const client = new Client({ name: 'wechat-http-mcp-test', version: '1.0.0' });
  await client.connect(
    transport as unknown as Parameters<Client['connect']>[0],
  );
  t.onTestFinished(() => client.close());
  const result = await client.callTool({
    name: 'send_text',
    arguments: { session: created.session.token, content: 'HTTP MCP' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    (result.structuredContent as { status?: unknown } | undefined)?.status,
    'accepted',
  );
  assert.equal(created.sends.length, 1);
});

test('a standard MCP Client executes send_text and receives accepted facts', async (t) => {
  const { client, session, sends, store, messageKey } = await harness(t);
  const result = await client.callTool({
    name: 'send_text',
    arguments: { session: session.token, content: '真实执行' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    status: 'accepted',
    attemptId: store.listMessageAttempts(messageKey)[0]?.attemptId,
    sendIndex: 0,
    type: 'text',
    msgid: 'wx-1',
  });
  assert.deepEqual(sends, [{
    toUser: 'wm-one',
    openKfId: 'wk-one',
    payload: { msgtype: 'text', text: { content: '真实执行' } },
    messageId: store.listMessageAttempts(messageKey)[0]?.clientMessageId,
  }]);
});

test('fail_type=13 enters context only through the tool result as sensitive-content policy', async (t) => {
  let store: SqliteStore | undefined;
  let messageKey = '';
  const created = await harness(t, {
    observeMs: 100,
    sleep: async () => {
      const attempt = store?.listMessageAttempts(messageKey)[0];
      if (attempt?.wecomMsgId && attempt.status === 'accepted') {
        store?.markSendMsgFailed({
          wecomMsgId: attempt.wecomMsgId,
          failType: 13,
        });
      }
    },
  });
  store = created.store;
  messageKey = created.messageKey;
  const result = await created.client.callTool({
    name: 'send_text',
    arguments: { session: created.session.token, content: '公开信息，' },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: 'failed',
    attemptId: store.listMessageAttempts(messageKey)[0]?.attemptId,
    sendIndex: 0,
    type: 'text',
    msgid: 'wx-1',
    error: {
      kind: 'sensitive_content',
      message:
        'The channel rejected this message as potentially sensitive content. Do not send unlawful content; if the request is legitimate, revise the wording before deciding whether to try once more.',
      failType: 13,
    },
  });
});

test('a failure callback that precedes send_msg response reconciles during completeSend', async (t) => {
  let raceStore: SqliteStore | undefined;
  const created = await harness(t, {
    sendPreparedMessage: async () => {
      raceStore?.markSendMsgFailed({
        wecomMsgId: 'wx-early-failure',
        failType: 13,
      });
      return { msgid: 'wx-early-failure' };
    },
  });
  raceStore = created.store;
  const result = await created.client.callTool({
    name: 'send_text',
    arguments: { session: created.session.token, content: '回调竞态' },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /sensitive_content/u);
  const failure = created.store.database.prepare(`
    SELECT matched_attempt_key FROM delivery_failures
    WHERE wecom_msgid = 'wx-early-failure'
  `).get() as { matched_attempt_key?: unknown } | undefined;
  assert.equal(
    failure?.matched_attempt_key,
    created.store.listMessageAttempts(created.messageKey)[0]?.attemptId,
  );
});

test('a stale direction session fails before the channel call without consuming quota', async (t) => {
  const { client, store, session, sends, messageKey } = await harness(t);
  store.ingestSyncPage({
    openKfId: 'wk-one',
    expectedCursor: 'cursor-one',
    nextCursor: 'cursor-two',
    messages: [normalizeWecomMessage({
      msgid: 'customer-two',
      open_kfid: 'wk-one',
      external_userid: 'wm-one',
      origin: 3,
      msgtype: 'text',
      text: { content: '调整方向' },
    }, 'wk-one')],
  });
  const result = await client.callTool({
    name: 'send_text',
    arguments: { session: session.token, content: '不应发送' },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /stale_agent_session/u);
  assert.equal(sends.length, 0);
  assert.equal(store.listMessageAttempts(messageKey).length, 0);
});

test('MCP atomically enforces five sends and the sixth prepares no media or channel call', async (t) => {
  const { client, session, sends, mediaCalls } = await harness(t);
  for (let index = 0; index < 5; index += 1) {
    const result = await client.callTool({
      name: 'send_text',
      arguments: { session: session.token, content: `第${index + 1}条` },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  }
  const rejected = await client.callTool({
    name: 'send_link',
    arguments: {
      session: session.token,
      title: '第六条',
      description: '',
      url: 'https://example.com/sixth',
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.structuredContent), /send_budget_exceeded/u);
  assert.equal(sends.length, 5);
  assert.equal(mediaCalls.thumbnail, 0);
});

test('generated artifact stays session-bound and is uploaded only inside MCP', async (t) => {
  const { client, store, messageKey, session, sends, mediaCalls } = await harness(t);
  const ref = store.registerAgentArtifact({
    sessionToken: session.token,
    bytes: Buffer.from('89504e470d0a1a0a05050505', 'hex'),
    filename: 'generated.png',
    contentType: 'image/png',
    metadata: { generationId: 'generation-one', revisedPrompt: 'prompt-one' },
  });
  const result = await client.callTool({
    name: 'send_image',
    arguments: { session: session.token, mediaRef: ref },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(mediaCalls.upload, 1);
  assert.deepEqual(sends[0]?.payload, {
    msgtype: 'image', image: { media_id: 'uploaded-media' },
  });
  assert.deepEqual(store.listMessageAttempts(messageKey)[0]?.metadata, {
    generationId: 'generation-one',
    revisedPrompt: 'prompt-one',
    tool: 'generated_image',
    direction: 1,
  });
});

test('media preparation failure reports a stable MCP error before creating a send', async (t) => {
  const { client, store, messageKey, session, sends } = await harness(t, {
    withImage: true,
    failMediaPreparation: true,
  });
  const result = await client.callTool({
    name: 'send_image',
    arguments: { session: session.token, mediaRef: 'media:0' },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /media_preparation_failed/u);
  assert.equal(sends.length, 0);
  assert.equal(store.listMessageAttempts(messageKey).length, 0);
});

test('the Agent delivers multiple verified places as native locations without extra text', async (t) => {
  const { client, session, sends } = await harness(t);
  for (const [index, name] of ['甲店', '乙店', '丙店'].entries()) {
    const result = await client.callTool({
      name: 'send_location',
      arguments: {
        session: session.token,
        name,
        address: `${name}地址`,
        latitude: 39 + index / 100,
        longitude: 116 + index / 100,
      },
    });
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(sends.map((send) =>
    String((send.payload as { msgtype?: unknown }).msgtype)), [
    'location', 'location', 'location',
  ]);
});

test('five MCP tools produce exact payloads accepted by the adapter', async (t) => {
  const { client, session, sends } = await harness(t, { withImage: true });
  const calls = [
    ['send_text', { content: '文字' }],
    ['send_image', { mediaRef: 'media:0' }],
    ['send_link', {
      title: '链接', description: '说明', url: 'https://example.com/link',
    }],
    ['send_miniprogram', {
      appId: 'wx1234567890abcdef', title: '小程序', pagePath: 'pages/index',
      sourceUrl: 'https://example.com/proof',
    }],
    ['send_location', {
      name: '地点', address: '地址', latitude: 39, longitude: 116,
    }],
  ] as const;
  for (const [name, argumentsList] of calls) {
    const result = await client.callTool({
      name,
      arguments: { session: session.token, ...argumentsList },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  }
  assert.deepEqual(sends.map((send) => send.payload), [
    { msgtype: 'text', text: { content: '文字' } },
    { msgtype: 'image', image: { media_id: 'cloned-media' } },
    {
      msgtype: 'link',
      link: {
        title: '链接', desc: '说明', url: 'https://example.com/link',
        thumb_media_id: 'thumbnail-media',
      },
    },
    {
      msgtype: 'miniprogram',
      miniprogram: {
        appid: 'wx1234567890abcdef', title: '小程序', pagepath: 'pages/index',
        thumb_media_id: 'thumbnail-media',
      },
    },
    {
      msgtype: 'location',
      location: { name: '地点', address: '地址', latitude: 39, longitude: 116 },
    },
  ]);
});

test('MCP returns definitive rejection and uncertain results without automatic retry', async (t) => {
  const uncertain = await harness(t, {
    sendPreparedMessage: async () => ({}),
  });
  const uncertainResult = await uncertain.client.callTool({
    name: 'send_text',
    arguments: { session: uncertain.session.token, content: '结果不确定' },
  });
  assert.equal(uncertainResult.isError, undefined);
  assert.match(JSON.stringify(uncertainResult.structuredContent), /uncertain_result/u);

  const rejected = await harness(t, {
    sendPreparedMessage: async () => {
      throw new WecomApiError('微信同步拒绝', { code: 40000 });
    },
  });
  const rejectedResult = await rejected.client.callTool({
    name: 'send_text',
    arguments: { session: rejected.session.token, content: '同步拒绝' },
  });
  assert.equal(rejectedResult.isError, true);
  assert.match(JSON.stringify(rejectedResult.structuredContent), /wechat_delivery_failed/u);
  assert.match(JSON.stringify(rejectedResult.structuredContent), /40000/u);
  assert.equal(uncertain.sends.length, 1);
  assert.equal(rejected.sends.length, 1);
});
