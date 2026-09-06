import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { createConfig } from '../../src/config.ts';
import {
  IlinkSecretBox,
  readOrCreateIlinkStorageKey,
} from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { acquireSingleInstanceLock } from '../../src/runtime/single-instance-lock.ts';
import { createRuntime } from '../../src/runtime.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('standalone iLink login needs no setup, config, Hono, or running Worker', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-standalone-'));
  const home = path.join(profile, '.kintio');
  t.onTestFinished(() => fs.rmSync(profile, { recursive: true, force: true }));
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    return url.pathname.endsWith('/get_bot_qrcode')
      ? response({
          qrcode: 'standalone-provider-token',
          qrcode_img_content: 'weixin://ilink/login/standalone',
        })
      : response({
          status: 'confirmed',
          bot_token: 'standalone-bot-token',
          ilink_bot_id: 'standalone-bot@im.bot',
          ilink_user_id: 'standalone-owner@im.wechat',
          baseurl: 'https://ilinkai.weixin.qq.com/',
        });
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCli(['ilink', 'login', '--home', home], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
  });

  assert.equal(result, 0, stderr.join(''));
  assert.deepEqual(calls, [
    '/ilink/bot/get_bot_qrcode',
    '/ilink/bot/get_qrcode_status',
  ]);
  assert.equal(fs.existsSync(path.join(home, '.env')), false);
  assert.equal(fs.existsSync(path.join(home, 'data/kintio.lock')), false);
  const databaseFile = path.join(home, 'data/kintio.sqlite');
  const keyFile = path.join(home, 'data/ilink-storage.key');
  assert.equal(fs.existsSync(databaseFile), true);
  assert.equal(fs.existsSync(keyFile), true);
  const persistence = new StatePersistence({ filePath: databaseFile });
  t.onTestFinished(() => persistence.close());
  const accountKey = createIlinkAccountKey('standalone-bot@im.bot');
  const stored = persistence.createIlinkStore().getAccountWithSecret(accountKey);
  assert.ok(stored);
  assert.equal(stored.account.agentAccess, 'host');
  assert.equal(stored.account.runtimeEnabled, false);
  assert.equal(stored.account.ownerPeerId, 'standalone-owner@im.wechat');
  const box = new IlinkSecretBox(readOrCreateIlinkStorageKey(
    keyFile,
    { allowCreate: false },
  ));
  assert.equal(box.open(stored.secret.sealedBotToken, {
    secretKind: 'bot_token',
    accountId: accountKey,
    peerId: stored.account.ownerPeerId,
    generation: stored.account.generation,
  }), 'standalone-bot-token');
  assert.doesNotMatch(stdout.join(''), /standalone-provider-token|standalone-bot-token/u);
});

test('a locked instance with unavailable IPC never becomes a second writer', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-locked-'));
  const home = path.join(profile, '.kintio');
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  t.onTestFinished(() => fs.rmSync(profile, { recursive: true, force: true }));
  const lock = acquireSingleInstanceLock({
    filePath: path.join(data, 'kintio.lock'),
  });
  t.onTestFinished(() => { lock.release(); });
  let fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    return response({});
  });
  const stderr: string[] = [];
  const result = await runCli(['ilink', 'login', '--home', home], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout() {},
    stderr: (text) => stderr.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
  });
  assert.equal(result, 1);
  assert.match(stderr.join(''), /private iLink operator control is unavailable/u);
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(path.join(data, 'kintio.sqlite')), false);
});

test('a missing storage key blocks login but not complete account deletion', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-key-loss-'));
  const home = path.join(profile, '.kintio');
  const databaseFile = path.join(home, 'data/kintio.sqlite');
  t.onTestFinished(() => fs.rmSync(profile, { recursive: true, force: true }));
  const persistence = new StatePersistence({ filePath: databaseFile });
  const key = Buffer.alloc(32, 61).toString('base64url');
  const box = new IlinkSecretBox(key);
  persistence.createIlinkStore().registerAccount({
    providerAccountId: 'lost-key-bot@im.bot',
    ownerPeerId: 'lost-key-owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('lost-key-token', {
      secretKind: 'bot_token',
      accountId: createIlinkAccountKey('lost-key-bot@im.bot'),
      peerId: 'lost-key-owner@im.wechat',
      generation: 1,
    }),
    agentAccess: 'host',
    now: Date.now(),
  });
  persistence.close();
  let fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    return response({});
  });
  const stderr: string[] = [];
  const result = await runCli(['ilink', 'login', '--home', home], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout() {},
    stderr: (text) => stderr.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
  });
  assert.equal(result, 1);
  assert.match(stderr.join(''), /storage key is missing for existing encrypted state/u);
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(path.join(home, 'data/ilink-storage.key')), false);

  stderr.length = 0;
  const deleted = await runCli([
    'ilink', 'delete', '--home', home, '--account', 'lost-key-bot@im.bot', '--yes',
  ], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout() {},
    stderr: (text) => stderr.push(text),
  });
  assert.equal(deleted, 0, stderr.join(''));
  const inspected = new StatePersistence({ filePath: databaseFile });
  assert.equal(inspected.createIlinkStore().getAccount(
    createIlinkAccountKey('lost-key-bot@im.bot'),
  ), undefined);
  inspected.close();
});

test('iLink refuses to borrow a WeCom instance database or enrollment capability', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-ipc-owner-'));
  const home = path.join(profile, '.kintio');
  t.onTestFinished(() => fs.rmSync(profile, { recursive: true, force: true }));
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname.endsWith('/get_bot_qrcode')
      ? response({
          qrcode: 'ipc-owner-provider-token',
          qrcode_img_content: 'weixin://ilink/login/ipc-owner',
        })
      : response({
          status: 'confirmed',
          bot_token: 'ipc-owner-bot-token',
          ilink_bot_id: 'ipc-owner-bot@im.bot',
          ilink_user_id: 'ipc-owner-user@im.wechat',
          baseurl: 'https://ilinkai.weixin.qq.com/',
        });
  });
  const config = createConfig({
    WECOM_CORP_ID: 'ww-ipc-owner',
    WECOM_KF_SECRET: 'not-used',
    ILINK_ENABLED: 'false',
  }, home);
  const runtime = await createRuntime({
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => runtime.abort());
  const stderr: string[] = [];
  const result = await runCli(['ilink', 'login', '--home', home], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout() {},
    stderr: (text) => stderr.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
  });
  assert.equal(result, 1);
  assert.match(stderr.join(''), /not running|unavailable|locked|owned|connect/i);
  assert.equal(fs.existsSync(config.state.lockFile), true);
  await runtime.close();
  assert.equal(fs.existsSync(config.state.lockFile), false);
  const persistence = new StatePersistence({ filePath: config.state.databaseFile });
  t.onTestFinished(() => persistence.close());
  assert.equal(
    persistence.createIlinkStore().listActiveAccounts().length,
    0,
  );
});

test('standalone checkpoint failure still closes SQLite before releasing its lock', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-cleanup-'));
  const home = path.join(profile, '.kintio');
  t.onTestFinished(() => fs.rmSync(profile, { recursive: true, force: true }));
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname.endsWith('/get_bot_qrcode')
      ? response({
          qrcode: 'cleanup-provider-token',
          qrcode_img_content: 'weixin://ilink/login/cleanup',
        })
      : response({
          status: 'confirmed',
          bot_token: 'cleanup-bot-token',
          ilink_bot_id: 'cleanup-bot@im.bot',
          ilink_user_id: 'cleanup-owner@im.wechat',
          baseurl: 'https://ilinkai.weixin.qq.com/',
        });
  });
  vi.spyOn(SqliteStore.prototype, 'checkpoint').mockImplementationOnce(() => {
    throw new Error('simulated standalone checkpoint failure');
  });
  const stderr: string[] = [];
  assert.equal(await runCli(['ilink', 'login', '--home', home], {
    env: {},
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout() {},
    stderr: (text) => stderr.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
  }), 1);
  assert.match(stderr.join(''), /Standalone iLink login cleanup failed/u);
  const lockFile = path.join(home, 'data/kintio.lock');
  assert.equal(fs.existsSync(lockFile), false);
  const persistence = new StatePersistence({
    filePath: path.join(home, 'data/kintio.sqlite'),
  });
  persistence.close();
});
