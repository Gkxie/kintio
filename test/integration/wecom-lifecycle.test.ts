import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'vitest';

import { loadSharedRuntimeConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import { readIlinkAccountSnapshot } from '../../src/ilink/cli-accounts.ts';

async function fixture(t: TestContext, environment: NodeJS.ProcessEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-wecom-lifecycle-'));
  t.onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '0.0.0.0', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  t.onTestFinished(async () => {
    if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
  });
  await fs.mkdir(path.join(home, 'wecom'), { mode: 0o700 });
  const file = path.join(home, 'wecom/.env');
  await fs.writeFile(file, `PORT=${port}\nCODEX_ENABLED=false\nWECOM_CALLBACK_TOKEN=TestCallback\nWECOM_ENCODING_AES_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG\n`, { mode: 0o600 });
  const config = loadSharedRuntimeConfig({ root: home, environment });
  const runtime = await createRuntime({ config, logger: { info() {}, warn() {}, error() {} } });
  t.onTestFinished(() => runtime.close());
  await runtime.start();
  const releasePort = () => new Promise<void>((resolve) => socket.close(() => resolve()));
  const url = 'http://127.0.0.1:' + port + '/';
  const accounts = () => readIlinkAccountSnapshot({ config, packageRoot: path.resolve('.'), signal: AbortSignal.timeout(5_000) });
  return { runtime, config, home, file, port, url, releasePort, accounts };
}

it('a bad WeCom configuration does not prevent the standalone iLink runtime from starting', async (t) => {
  const { runtime, file, accounts } = await fixture(t);
  await fs.writeFile(file, 'PORT=invalid\n');
  await assert.rejects(runtime.wecomControl!('start'), /PORT/u);
  assert.equal((await accounts()).mode, 'runtime');
  assert.deepEqual(await runtime.wecomControl!('status'), { running: false });
});

it('an invalid saved WeCom configuration does not take down shared runtime recovery', async (t) => {
  const { runtime, config, releasePort, file } = await fixture(t);
  await releasePort();
  await runtime.wecomControl!('start');
  await runtime.close();
  await fs.writeFile(file, 'CODEX_ENABLED=synthetic-sensitive-config-value\n');
  const errors: string[] = [];
  const restored = await createRuntime({ config, logger: { info() {}, warn() {}, error: (message) => errors.push(message) } });
  t.onTestFinished(() => restored.close());
  await restored.start();
  assert.deepEqual(await restored.wecomControl!('status'), { running: false });
  assert.equal((await readIlinkAccountSnapshot({ config, packageRoot: path.resolve('.'), signal: AbortSignal.timeout(5_000) })).mode, 'runtime');
  assert.match(errors.join('\n'), /listener could not be restored/u);
  assert.doesNotMatch(errors.join('\n'), /synthetic-sensitive-config-value/u);
});

it('disabling iLink Agent processing does not disable the independent WeCom listener', async (t) => {
  const { runtime, releasePort, url, accounts } = await fixture(t, { CODEX_ENABLED: 'false' });
  await releasePort();
  await runtime.wecomControl!('start');
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await accounts()).mode, 'runtime');
});

it('an occupied callback port fails only WeCom; fixing it permits a retry without reopening SQLite', async (t) => {
  const { runtime, releasePort, accounts, url } = await fixture(t);
  await assert.rejects(runtime.wecomControl!('start'), /EADDRINUSE/u);
  assert.equal((await accounts()).mode, 'runtime');
  await releasePort();
  await runtime.wecomControl!('start');
  assert.equal((await fetch(url)).status, 200);
});

it('serializes overlapping WeCom start and stop commands and permits a subsequent start', async (t) => {
  const { runtime, releasePort, url } = await fixture(t);
  await releasePort();
  await Promise.all([runtime.wecomControl!('start'), runtime.wecomControl!('stop')]);
  assert.deepEqual(await runtime.wecomControl!('status'), { running: false });
  await runtime.wecomControl!('start');
  assert.equal((await fetch(url)).status, 200);
});

it('a second WeCom configuration cannot replace the running singleton implicitly', async (t) => {
  const { runtime, home, releasePort } = await fixture(t);
  await releasePort();
  await runtime.wecomControl!('start');
  await assert.rejects(runtime.wecomControl!('start', path.join(home, 'another.env')), /another config/u);
  assert.deepEqual(await runtime.wecomControl!('status'), { running: true });
});

it('the idle update gate closes callback admission while keeping shared shutdown graceful', async (t) => {
  const { runtime, releasePort, url } = await fixture(t);
  await releasePort();
  await runtime.wecomControl!('start');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.stopAcceptingIfIdle(), true);
  assert.equal((await fetch(url, { method: 'POST' })).status, 503);
  await runtime.close();
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  await assert.rejects(runtime.start(), /stopping/u);
});

it('abort closes the callback socket as well as Agent and MCP resources', async (t) => {
  const { runtime, releasePort, url } = await fixture(t);
  await releasePort();
  await runtime.wecomControl!('start');
  await runtime.abort();
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
});
