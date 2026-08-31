import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test, type TestContext } from 'vitest';

import {
  createIlinkMcpServer,
  type IlinkSendTextInput,
  type IlinkToolExecutor,
  type IlinkToolName,
  type IlinkToolReceipt,
} from '../../src/mcp/ilink-server.ts';

const ACCEPTED: IlinkToolReceipt = {
  status: 'accepted',
  attemptId: 'attempt-0001',
  sendIndex: 0,
  type: 'text',
  msgid: 'ilink-message-0001',
};

async function harness(
  t: TestContext,
  execute: (
    tool: IlinkToolName,
    input: IlinkSendTextInput,
  ) => Promise<IlinkToolReceipt> = async (tool) => ({
    ...ACCEPTED,
    type: tool === 'send_image' ? 'image' : 'text',
  }),
) {
  const calls: { tool: IlinkToolName; input: IlinkSendTextInput }[] = [];
  const executor: IlinkToolExecutor = {
    async execute(tool, input) {
      calls.push({ tool, input: structuredClone(input) });
      return execute(tool, input);
    },
  };
  const server = createIlinkMcpServer(executor);
  const client = new Client({ name: 'ilink-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.onTestFinished(() => client.close());
  return { client, executor, calls };
}

test('iLink MCP exposes only bound text and image send capabilities', async (t) => {
  const created = await harness(t);
  const listed = await created.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['send_text', 'send_image']);
  const schema = listed.tools[0]?.inputSchema as {
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties || {}).sort(), ['content', 'session']);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(
    JSON.stringify(listed),
    /account|peer|token|context|baseUrl|base_url|qrcode|qr_code/iu,
  );

  const session = `ws_${'A'.repeat(32)}`;
  const result = await created.client.callTool({
    name: 'send_text',
    arguments: { session, content: '你好，iLink。' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(created.calls, [{
    tool: 'send_text',
    input: { session, content: '你好，iLink。' },
  }]);
  assert.deepEqual(result.structuredContent, ACCEPTED);
  const image = await created.client.callTool({
    name: 'send_image',
    arguments: { session, mediaRef: 'artifact:0' },
  });
  assert.equal((image.structuredContent as { type?: unknown }).type, 'image');
  assert.deepEqual(created.calls[1], {
    tool: 'send_image',
    input: { session, mediaRef: 'artifact:0' },
  });
});

test('iLink MCP rejects invalid sessions, text bounds, and routing fields', async (t) => {
  const created = await harness(t);
  const session = `ws_${'B'.repeat(32)}`;
  for (const arguments_ of [
    { session: 'invalid', content: 'valid' },
    { session, content: '' },
    { session, content: ' '.repeat(4) },
    { session, content: 'a'.repeat(2_001) },
    { session, content: '🙂'.repeat(501) },
    { session, content: 'valid', account: 'forbidden' },
    { session, content: 'valid', peer: 'forbidden' },
    { session, content: 'valid', token: 'forbidden' },
    { session, content: 'valid', context: 'forbidden' },
    { session, content: 'valid', baseUrl: 'https://forbidden.invalid' },
  ]) {
    const result = await created.client.callTool({
      name: 'send_text',
      arguments: arguments_,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments/iu);
  }
  for (const mediaRef of ['file:0', '../local', 'artifact:100']) {
    const result = await created.client.callTool({
      name: 'send_image',
      arguments: { session, mediaRef },
    });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(created.calls, []);
});

test('iLink MCP preserves attempt facts and replaces provider error text with safe facts', async (t) => {
  const receipts: IlinkToolReceipt[] = [
    {
      status: 'failed',
      attemptId: 'attempt-failed',
      sendIndex: 1,
      type: 'text',
      msgid: '',
      error: {
        kind: 'reply_window_expired',
        message: 'secret context_token=do-not-leak',
        code: 'WINDOW_EXPIRED',
        ret: -14,
      },
    },
    {
      status: 'uncertain',
      attemptId: 'attempt-uncertain',
      sendIndex: 2,
      type: 'text',
      msgid: '',
      error: {
        kind: 'unknown-secret-kind',
        message: 'https://private.invalid/token',
        code: 'unsafe/code',
      },
    },
    {
      status: 'failed',
      attemptId: 'attempt-quota',
      sendIndex: 10,
      type: 'text',
      msgid: '',
      error: {
        kind: 'reply_quota_exhausted',
        message: 'provider detail must not leak',
      },
    },
  ];
  const created = await harness(t, async () => receipts.shift()!);
  const session = `ws_${'C'.repeat(32)}`;

  const failed = await created.client.callTool({
    name: 'send_text',
    arguments: { session, content: 'first' },
  });
  const uncertain = await created.client.callTool({
    name: 'send_text',
    arguments: { session, content: 'second' },
  });
  const exhausted = await created.client.callTool({
    name: 'send_text',
    arguments: { session, content: 'third' },
  });

  assert.equal(failed.isError, true);
  assert.deepEqual(failed.structuredContent, {
    status: 'failed',
    attemptId: 'attempt-failed',
    sendIndex: 1,
    type: 'text',
    msgid: '',
    error: {
      kind: 'reply_window_expired',
      message: 'The iLink reply window closed 24 hours after the participant\'s last message. Stop retrying and wait for another inbound message.',
      code: 'WINDOW_EXPIRED',
      ret: -14,
    },
  });
  assert.equal(uncertain.isError, undefined);
  assert.deepEqual(uncertain.structuredContent, {
    status: 'uncertain',
    attemptId: 'attempt-uncertain',
    sendIndex: 2,
    type: 'text',
    msgid: '',
    error: {
      kind: 'uncertain_result',
      message: 'The iLink delivery outcome is uncertain and may have succeeded.',
    },
  });
  assert.deepEqual(exhausted.structuredContent, {
    status: 'failed',
    attemptId: 'attempt-quota',
    sendIndex: 10,
    type: 'text',
    msgid: '',
    error: {
      kind: 'reply_quota_exhausted',
      message: 'The ten-message quota for this iLink reply window is exhausted. Stop retrying and wait for another inbound message.',
    },
  });
  assert.doesNotMatch(
    JSON.stringify([failed, uncertain, exhausted]),
    /context_token|do-not-leak|private\.invalid|provider detail|unsafe\/code|unknown-secret-kind/u,
  );
});

test('iLink MCP contains thrown errors and executor receipt field leakage', async (t) => {
  let calls = 0;
  const created = await harness(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error('token=must-not-leak');
    return {
      ...ACCEPTED,
      account: 'must-not-leak',
    } as unknown as IlinkToolReceipt;
  });
  const session = `ws_${'D'.repeat(32)}`;
  for (const content of ['throw', 'extra']) {
    const result = await created.client.callTool({
      name: 'send_text',
      arguments: { session, content },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      status: 'failed',
      attemptId: '',
      sendIndex: -1,
      type: 'text',
      msgid: '',
      error: {
        kind: 'ilink_tool_error',
        message: 'The iLink tool could not execute the message.',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|account/iu);
  }
});
