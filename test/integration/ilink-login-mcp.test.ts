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
    listAccounts() { return []; },
    async setAccountRuntime() { throw new Error('not used'); },
    async deleteAccount() { throw new Error('not used'); },
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
    listAccounts() { return []; },
    async setAccountRuntime() { throw new Error('not used'); },
    async deleteAccount() { throw new Error('not used'); },
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

test('private operator MCP exposes account list, start, stop, and delete results', async (t) => {
  const accountKey = `ia_${'a'.repeat(40)}`;
  const incarnation = `ii_${'a'.repeat(64)}` as const;
  let runtimeEnabled = false;
  let deleted = false;
  const account = () => ({
    accountKey,
    generation: 1,
    incarnation,
    providerAccountId: 'operator-bot@im.bot',
    runtimeEnabled,
  });
  const server = createIlinkLoginMcpServer({
    async begin() { throw new Error('not used'); },
    status() { return { status: 'unknown' }; },
    cancel() { return false; },
    listAccounts() { return deleted ? [] : [account()]; },
    async setAccountRuntime(received, enabled, expected) {
      assert.equal(received, accountKey);
      assert.deepEqual(expected, { generation: 1, incarnation });
      runtimeEnabled = enabled;
      return { account: account(), runningCount: enabled ? 1 : 0 };
    },
    async deleteAccount(received, expected) {
      assert.equal(received, accountKey);
      assert.deepEqual(expected, { generation: 1, incarnation });
      runtimeEnabled = false;
      deleted = true;
      return { account: account(), runningCount: 0 };
    },
  });
  const client = new Client({ name: 'ilink-account-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  assert.deepEqual((await client.callTool({
    name: 'list_accounts', arguments: {},
  })).structuredContent, { accounts: [account()] });
  assert.deepEqual((await client.callTool({
    name: 'start_account', arguments: {
      accountKey, expectedGeneration: 1, expectedIncarnation: incarnation,
    },
  })).structuredContent, { account: account(), runningCount: 1 });
  assert.deepEqual((await client.callTool({
    name: 'stop_account', arguments: {
      accountKey, expectedGeneration: 1, expectedIncarnation: incarnation,
    },
  })).structuredContent, { account: account(), runningCount: 0 });
  const deletion = await client.callTool({
    name: 'delete_account', arguments: {
      accountKey, expectedGeneration: 1, expectedIncarnation: incarnation,
    },
  });
  assert.deepEqual(deletion.structuredContent, { account: account(), runningCount: 0 });
  assert.equal(deleted, true);
});

test('private operator MCP sanitizes every account lifecycle failure', async (t) => {
  const accountKey = `ia_${'f'.repeat(40)}`;
  const revision = {
    expectedGeneration: 1,
    expectedIncarnation: `ii_${'f'.repeat(64)}`,
  };
  const server = createIlinkLoginMcpServer({
    async begin() { throw new Error('not used'); },
    status() { throw new Error('secret status detail'); },
    cancel() { throw new Error('secret cancel detail'); },
    listAccounts() { throw new Error('secret list detail'); },
    async setAccountRuntime() { throw new Error('secret start detail'); },
    async deleteAccount() { throw new Error('secret delete detail'); },
  });
  const client = new Client({ name: 'ilink-account-errors-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const results = await Promise.all([
    client.callTool({
      name: 'login_status', arguments: { offerId: `qo_${'s'.repeat(20)}` },
    }),
    client.callTool({
      name: 'cancel_login', arguments: { offerId: `qo_${'c'.repeat(20)}` },
    }),
    client.callTool({ name: 'list_accounts', arguments: {} }),
    client.callTool({
      name: 'start_account', arguments: { accountKey, ...revision },
    }),
    client.callTool({
      name: 'delete_account', arguments: { accountKey, ...revision },
    }),
  ]);
  assert.ok(results.every((result) => result.isError));
  assert.ok(results.slice(0, 2).every((result) =>
    JSON.stringify(result).includes('login operation is unavailable')));
  assert.ok(results.slice(2).every((result) =>
    JSON.stringify(result).includes('account operation is unavailable')));
  assert.doesNotMatch(JSON.stringify(results), /secret .* detail/u);
});

test('private operator MCP reports stale account revisions without provider detail', async (t) => {
  const accountKey = `ia_${'d'.repeat(40)}`;
  const incarnation = `ii_${'d'.repeat(64)}` as const;
  const server = createIlinkLoginMcpServer({
    async begin() { throw new Error('not used'); },
    status() { return { status: 'unknown' }; },
    cancel() { return false; },
    listAccounts() { return []; },
    async setAccountRuntime() {
      throw Object.assign(new Error('secret revision detail'), {
        code: 'account_revision_changed',
      });
    },
    async deleteAccount() { throw new Error('not used'); },
  });
  const client = new Client({ name: 'ilink-stale-account-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({
    name: 'start_account',
    arguments: {
      accountKey,
      expectedGeneration: 1,
      expectedIncarnation: incarnation,
    },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /selected iLink account changed/u);
  assert.doesNotMatch(JSON.stringify(result), /secret revision detail/u);
});
