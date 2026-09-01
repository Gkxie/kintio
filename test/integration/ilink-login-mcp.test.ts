import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test } from 'vitest';

import { createIlinkLoginMcpServer } from '../../src/mcp/ilink-login-server.ts';

test('local login MCP supports cancellation and sanitizes provider failures', async (t) => {
  const server = createIlinkLoginMcpServer({
    begin() {
      throw new Error('iLink account limit reached with secret provider detail');
    },
    status() { return { status: 'unknown' }; },
    cancel(offerId) { return offerId === `qo_${'c'.repeat(20)}`; },
  });
  const client = new Client({ name: 'ilink-login-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const cancelled = await client.callTool({
    name: 'cancel_login',
    arguments: { offerId: `qo_${'c'.repeat(20)}` },
  });
  assert.deepEqual(cancelled.structuredContent, { cancelled: true });

  const failed = await client.callTool({ name: 'begin_login', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed), /account limit has been reached/u);
  assert.doesNotMatch(JSON.stringify(failed), /secret provider detail/u);
});

test('aborting begin_login cancels an offer created after the caller disconnects', async (t) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const cancelled: string[] = [];
  const server = createIlinkLoginMcpServer({
    async begin() {
      await ready;
      return {
        offerId: `qo_${'b'.repeat(20)}`,
        qrContent: 'weixin://late-offer',
        expiresAt: Date.now() + 300_000,
      };
    },
    status() { return { status: 'waiting' }; },
    cancel(offerId) {
      cancelled.push(offerId);
      return true;
    },
  });
  const client = new Client({ name: 'ilink-login-abort-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const controller = new AbortController();
  const call = client.callTool(
    { name: 'begin_login', arguments: {} },
    undefined,
    { signal: controller.signal },
  );
  controller.abort();
  release();
  await assert.rejects(call, /abort/iu);
  for (let attempt = 0; attempt < 20 && cancelled.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(cancelled, [`qo_${'b'.repeat(20)}`]);
});
