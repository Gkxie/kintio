import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';

import {
  controlAddress,
  daemonRecordPath,
  readDaemonRecord,
  requestControl,
} from '../../src/runtime/daemon-protocol.ts';
import { runNativeDaemon } from '../../src/runtime/native-daemon.ts';

async function until<T>(operation: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error('Timed out waiting for native daemon state');
}

test('native daemon authenticates control, restarts a crash, logs, and stops', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-core-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/index.js');
  const logDirectory = path.join(home, 'data/logs');
  await fs.mkdir(logDirectory, { recursive: true });
  await fs.writeFile(
    path.join(logDirectory, 'kintio.log'),
    Buffer.alloc(10 * 1024 * 1024, 0x78),
  );
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configFile, 'PORT=18889\nSHUTDOWN_TIMEOUT_MS=1000\n');
  await fs.writeFile(workerFile, [
    "process.stdout.write('fake worker ready\\n');",
    "process.send?.({ type: 'ready', pid: process.pid });",
    "process.on('message', (message) => { if (message === 'shutdown') process.exit(0); });",
    "process.on('disconnect', () => process.exit(0));",
    'setInterval(() => undefined, 1000).unref();',
  ].join('\n'));
  let completed = false;
  const daemon = runNativeDaemon({
    home,
    configFile,
    packageRoot,
    environment: {},
  }).finally(() => { completed = true; });
  t.onTestFinished(async () => {
    if (!completed) await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const first = await until(async () => {
    const response = await requestControl(home, 'ping').catch(() => undefined);
    return response?.phase === 'running' && response.workerPid ? response : undefined;
  });
  const daemonRecord = readDaemonRecord(home);
  const daemonRecordSource = await fs.readFile(path.join(home, 'data/daemon.json'), 'utf8');
  const daemonRecordMtime = (await fs.stat(path.join(home, 'data/daemon.json'))).mtimeMs;
  const control = readDaemonRecord(home);
  assert.ok(control);
  const rejected = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(
      controlAddress(home, process.platform, control.runId),
    );
    let source = '';
    socket.once('connect', () => socket.write(
      `${JSON.stringify({ version: 1, command: 'ping', token: 'x'.repeat(32) })}\n`,
    ));
    socket.on('data', (chunk: Buffer) => { source += chunk.toString(); });
    socket.once('end', () => resolve(JSON.parse(source) as Record<string, unknown>));
    socket.once('error', reject);
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.runId, first.runId);
  process.kill(first.workerPid!, 'SIGKILL');

  const second = await until(async () => {
    const response = await requestControl(home, 'ping').catch(() => undefined);
    return response?.phase === 'running' &&
      response.workerPid !== first.workerPid && response.workerPid
      ? response
      : undefined;
  });
  assert.notEqual(second.workerPid, first.workerPid);
  assert.equal(daemonRecord?.configFile, configFile);
  assert.equal(daemonRecord?.packageRoot, packageRoot);
  assert.equal(
    await fs.readFile(path.join(home, 'data/daemon.json'), 'utf8'),
    daemonRecordSource,
  );
  assert.equal((await fs.stat(path.join(home, 'data/daemon.json'))).mtimeMs, daemonRecordMtime);

  const idle = net.createConnection(
    controlAddress(home, process.platform, control.runId),
  );
  await new Promise<void>((resolve, reject) => {
    idle.once('connect', resolve);
    idle.once('error', reject);
  });
  const idleClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()));
  const stopped = await requestControl(home, 'stop');
  assert.equal(stopped.ok, true);
  await daemon;
  await idleClosed;
  await assert.rejects(fs.access(daemonRecordPath(home)), { code: 'ENOENT' });
  assert.match(
    await fs.readFile(path.join(home, 'data/logs/kintio.log'), 'utf8'),
    /daemon started[\s\S]+fake worker ready[\s\S]+worker exited[\s\S]+daemon stopped/u,
  );
  assert.equal((await fs.stat(path.join(logDirectory, 'kintio.log.1'))).size, 10 * 1024 * 1024);
});

test('restart exhaustion remains observable until an explicit stop', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-failed-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/index.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configFile, 'PORT=18890\n');
  await fs.writeFile(workerFile, 'setTimeout(() => process.exit(9), 100);\n');
  let completed = false;
  const daemon = runNativeDaemon({
    home,
    configFile,
    packageRoot,
    environment: {},
  }).finally(() => { completed = true; });
  t.onTestFinished(async () => {
    if (!completed) await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const response = async () => await requestControl(home, 'ping').catch(() => undefined);
  const waitFor = async (predicate: (value: Awaited<ReturnType<typeof response>>) => boolean) => {
    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    while (process.hrtime.bigint() < deadline) {
      const value = await response();
      if (predicate(value)) return value;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for daemon transition');
  };

  let active = await waitFor((value) => value?.phase === 'starting' && !!value.workerPid);
  for (const restartDelay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]) {
    await waitFor((value) => value?.phase === 'backoff');
    const previousPid = active?.workerPid;
    await vi.advanceTimersByTimeAsync(restartDelay);
    active = await waitFor(
      (value) => value?.phase === 'starting' && !!value.workerPid && value.workerPid !== previousPid,
    );
  }
  const failed = await waitFor((value) => value?.phase === 'failed');
  assert.match(failed?.message || '', /restart limit exceeded/u);
  assert.equal(completed, false);
  assert.equal((await requestControl(home, 'ping')).phase, 'failed');
  assert.equal((await requestControl(home, 'stop')).ok, true);
  await daemon;
});
