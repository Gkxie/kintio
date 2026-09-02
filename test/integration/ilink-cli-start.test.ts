import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { loadIlinkRuntimeConfig } from '../../src/config.ts';
import { startIlinkCliRuntime } from '../../src/ilink/cli-start.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { readDaemonRecord } from '../../src/runtime/daemon-protocol.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for iLink CLI runtime');
}

test('iLink start owns polling and Agent lifecycle without setup or Hono', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-start-'));
  t.onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = loadIlinkRuntimeConfig({ environment: {}, root: home });
  assert.equal('wecom' in config, false);
  assert.equal('port' in config, false);
  const controller = new AbortController();
  const output: string[] = [];
  const running = startIlinkCliRuntime({
    config,
    signal: controller.signal,
    stdout: (text) => output.push(text),
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(async () => {
    controller.abort();
    await running.catch(() => undefined);
  });
  await eventually(() => output.join('').includes('iLink runtime is active'));
  assert.equal(fs.existsSync(config.state.lockFile), true);
  controller.abort();
  assert.equal(await running, 130);
  assert.equal(fs.existsSync(config.state.lockFile), false);
  assert.equal(fs.existsSync(config.state.databaseFile), true);
});

test('foreground iLink lifecycle never loses a concurrent stop/start decision', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-foreground-'));
  const home = path.join(profile, '.kintio');
  const storageKey = Buffer.alloc(32, 73).toString('base64url');
  const environment = { ILINK_STORAGE_KEY: storageKey };
  const config = loadIlinkRuntimeConfig({ environment, root: home });
  const accountKey = createIlinkAccountKey('foreground-bot@im.bot');
  const persistence = new StatePersistence({ filePath: config.state.databaseFile });
  const box = new IlinkSecretBox(storageKey);
  persistence.createIlinkStore().registerAccount({
    providerAccountId: 'foreground-bot@im.bot',
    ownerPeerId: 'foreground-owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('foreground-token', {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: 'foreground-owner@im.wechat',
      generation: 1,
    }),
    agentAccess: 'host',
    now: Date.now(),
  });
  persistence.close();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/notifystart') || pathname.endsWith('/notifystop')) {
      return Response.json({ ret: 0 });
    }
    return await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        const error = new Error('poll aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const overrides = {
    env: environment,
    cwd: profile,
    homeDirectory: profile,
    packageRoot: path.resolve('.'),
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
  let completed = false;
  const foreground = runCli([
    'ilink', 'start', '--foreground', '--home', home,
  ], overrides).finally(() => { completed = true; });
  t.onTestFinished(async () => {
    if (!completed) {
      await runCli(['ilink', 'stop', '--home', home], overrides).catch(() => 1);
    }
    await foreground.catch(() => undefined);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await eventually(() => stdout.join('').includes('iLink runtime is active'));
  assert.equal(fs.existsSync(path.join(home, 'data/lifecycle.lock')), true);
  const [stopResult, startResult] = await Promise.all([
    runCli(['ilink', 'stop', '--home', home], overrides),
    runCli(['ilink', 'start', '--home', home], overrides),
  ]);
  assert.equal(stopResult, 0, stderr.join(''));
  assert.ok(startResult === 0 || startResult === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (!completed || readDaemonRecord(home)?.mode === 'ilink') {
    assert.equal(
      await runCli(['ilink', 'stop', '--home', home], overrides),
      0,
      stderr.join(''),
    );
  } else {
    const inspected = new StatePersistence({ filePath: config.state.databaseFile });
    assert.equal(inspected.createIlinkStore().getAccount(accountKey)?.runtimeEnabled, false);
    inspected.close();
  }
  assert.equal(await foreground, 0, stderr.join(''));
  await eventually(() => !fs.existsSync(config.state.lockFile));
  assert.equal(fs.existsSync(config.state.lockFile), false);
  assert.equal(fs.existsSync(path.join(home, 'data/lifecycle.lock')), false);
});
