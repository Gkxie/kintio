import assert from 'node:assert/strict';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { test } from 'vitest';

import { createConfig } from '../../src/config.ts';
import { runIlinkCliLogin } from '../../src/ilink/cli-login.ts';
import { IlinkLoginManager } from '../../src/ilink/login-manager.ts';
import type { IlinkQrStatusResponse } from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { createIlinkLoginMcpServer } from '../../src/mcp/ilink-login-server.ts';
import { McpIpcHost } from '../../src/mcp/ipc-host.ts';
import { operatorMcpInstanceKey } from '../../src/mcp/ipc-protocol.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

test('terminal adapter reaches the running Worker through private local MCP only', async (t) => {
  const temp = await createTempSqlite(t, { prefix: 'kintio-ilink-cli-mcp-' });
  const root = temp.directory;
  let now = 1_000_000;
  const storageKey = Buffer.alloc(32, 44).toString('base64url');
  const config = createConfig({
    ILINK_ENABLED: 'true',
    KINTIO_DB_FILE: temp.filePath,
    CODEX_WORKING_DIRECTORY: path.join(root, 'codex-workspace'),
    ILINK_STORAGE_KEY: storageKey,
  }, root);
  const persistence = temp.openInjectedPersistenceForTest({ clock: () => now });
  const accounts = persistence.createIlinkStore({ clock: () => now });
  const secretBox = new IlinkSecretBox(storageKey);
  const offers = persistence.createIlinkLoginStore({ secretBox, clock: () => now });
  const providerAccountId = 'cli-mcp-bot@im.bot';
  const ownerPeerId = 'cli-mcp-owner@im.wechat';
  const providerStatuses: IlinkQrStatusResponse[] = [
    { status: 'scaned' },
    {
      status: 'confirmed',
      bot_token: 'cli-mcp-bot-token',
      ilink_bot_id: providerAccountId,
      ilink_user_id: ownerPeerId,
      baseurl: 'https://ilinkai.weixin.qq.com/',
    },
  ];
  let listenerRefreshes = 0;
  const manager = new IlinkLoginManager({
    offers,
    accounts,
    secretBox,
    clock: () => now,
    sleep: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
    client: {
      async createQr() {
        return {
          qrcode: 'cli-mcp-provider-status-token',
          qrcode_img_content: 'weixin://ilink/login/through-local-mcp',
        };
      },
      async getQrStatus() {
        return providerStatuses.shift() || { status: 'wait' as const };
      },
      resolveRedirectBaseUrl(hostname: string) { return `https://${hostname}/`; },
    },
    onAccountsChanged: () => { listenerRefreshes += 1; },
    logger: { info() {}, warn() {}, error() {} },
  });
  await manager.start();
  const calls = { begin: 0, status: 0, cancel: 0 };
  const host = new McpIpcHost({
    instanceKey: operatorMcpInstanceKey(config.state.lockFile),
    stateDirectory: path.dirname(config.state.lockFile),
    relayFile: path.resolve('mcp-relay.ts'),
    memory: () => new McpServer({ name: 'unused-memory', version: '1.0.0' }),
    operator: () => createIlinkLoginMcpServer({
      begin() {
        calls.begin += 1;
        if (calls.begin > 1) throw new Error('iLink account limit reached');
        return manager.offer({ kind: 'terminal' });
      },
      status(offerId) {
        calls.status += 1;
        return manager.status(offerId);
      },
      cancel(offerId) {
        calls.cancel += 1;
        return manager.cancel(offerId);
      },
    }),
  });
  t.onTestFinished(() => host.close(true));
  t.onTestFinished(() => manager.close());
  await host.start();

  const output: string[] = [];
  const result = await runIlinkCliLogin({
    config,
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    clock: () => now,
    sleep: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
  });

  assert.equal(result, 0);
  assert.equal(calls.begin, 1);
  assert.ok(calls.status >= 1);
  assert.equal(calls.cancel, 0);
  assert.match(output.join(''), /login succeeded/u);
  assert.doesNotMatch(output.join(''), /through-local-mcp|weixin:\/\//u);
  const accountKey = createIlinkAccountKey(providerAccountId);
  const stored = accounts.getAccountWithSecret(accountKey);
  assert.ok(stored);
  assert.equal(stored.account.agentAccess, 'host');
  assert.equal(stored.account.ownerPeerId, ownerPeerId);
  assert.equal(secretBox.open(stored.secret.sealedBotToken, {
    secretKind: 'bot_token',
    accountId: accountKey,
    peerId: ownerPeerId,
    generation: 1,
  }), 'cli-mcp-bot-token');
  assert.equal(listenerRefreshes, 1);
  await assert.rejects(() => runIlinkCliLogin({
    config,
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
  }), /account limit has been reached/u);
  await host.close();
  await manager.close();
  persistence.close();
});
