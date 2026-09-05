import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
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
  const workerFile = path.join(packageRoot, 'dist/wecom.js');
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
    "if (process.env.KINTIO_MANAGED_WORKER !== '1') process.exit(3);",
    "process.stdout.write('fake worker ready\\n');",
    "process.send?.({ type: 'ready', pid: process.pid });",
    'let idleChecks = 0;',
    "process.on('message', (message) => {",
    "  if (message === 'shutdown') process.exit(0);",
    "  if (message?.type === 'stop-if-idle') {",
    "    idleChecks += 1;",
    "    process.send?.({ type: 'stop-if-idle-result', requestId: message.requestId, pid: process.pid, ok: true, idle: idleChecks > 1 });",
    "  }",
    "});",
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
  assert.equal(daemonRecord?.mode, 'wecom');
  assert.equal(daemonRecord?.packageRoot, packageRoot);
  assert.equal(daemonRecord?.version, 2);
  assert.equal(
    daemonRecord?.version === 2 ? daemonRecord.state.databaseFile : undefined,
    path.join(home, 'data/kintio.sqlite'),
  );
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
  const busy = await requestControl(home, 'stop-if-idle');
  assert.equal(busy.idle, false);
  assert.equal(busy.phase, 'running');
  const afterBusy = await requestControl(home, 'ping');
  assert.equal(afterBusy.phase, 'running');
  assert.equal(afterBusy.workerPid, second.workerPid);
  const stopped = await requestControl(home, 'stop-if-idle');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.idle, true);
  assert.equal(stopped.phase, 'stopping');
  await daemon;
  await idleClosed;
  await assert.rejects(fs.access(daemonRecordPath(home)), { code: 'ENOENT' });
  assert.match(
    await fs.readFile(path.join(home, 'data/logs/kintio.log'), 'utf8'),
    /daemon started[\s\S]+fake worker ready[\s\S]+worker exited[\s\S]+daemon stopped/u,
  );
  assert.equal((await fs.stat(path.join(logDirectory, 'kintio.log.1'))).size, 10 * 1024 * 1024);
});

test('stop-if-idle ignores stale request IDs and accepts only the current Worker reply', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-idle-correlation-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/wecom.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configFile, 'PORT=18891\n');
  await fs.writeFile(workerFile, [
    "process.send?.({ type: 'ready', pid: process.pid });",
    'let checks = 0;',
    "process.on('message', (message) => {",
    "  if (message === 'shutdown') process.exit(0);",
    "  if (message?.type !== 'stop-if-idle') return;",
    '  checks += 1;',
    "  if (checks === 1) {",
    "    process.send?.({ type: 'stop-if-idle-result', requestId: 'stale_request', pid: process.pid, ok: true, idle: true });",
    "    setTimeout(() => process.send?.({ type: 'stop-if-idle-result', requestId: message.requestId, pid: process.pid, ok: true, idle: false }), 10);",
    '    return;',
    '  }',
    "  process.send?.({ type: 'stop-if-idle-result', requestId: message.requestId, pid: process.pid, ok: true, idle: true });",
    '});',
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  let completed = false;
  const daemon = runNativeDaemon({
    home,
    configFile,
    packageRoot,
    environment: {},
    workerControlTimeoutMs: 200,
  }).finally(() => { completed = true; });
  t.onTestFinished(async () => {
    if (!completed) await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const running = await until(async () => {
    const value = await requestControl(home, 'ping').catch(() => undefined);
    return value?.phase === 'running' ? value : undefined;
  });
  const busy = await requestControl(home, 'stop-if-idle');
  assert.equal(busy.idle, false);
  assert.equal((await requestControl(home, 'ping')).workerPid, running.workerPid);

  const stopped = await requestControl(home, 'stop-if-idle');
  assert.equal(stopped.idle, true);
  assert.equal(stopped.phase, 'stopping');
  await daemon;
});

test('stop-if-idle Worker error and timeout fail closed without stopping the daemon', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-idle-timeout-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/wecom.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configFile, 'PORT=18892\n');
  await fs.writeFile(workerFile, [
    "process.send?.({ type: 'ready', pid: process.pid });",
    'let checks = 0;',
    "process.on('message', (message) => {",
    "  if (message === 'shutdown') process.exit(0);",
    "  if (message?.type !== 'stop-if-idle') return;",
    '  checks += 1;',
    "  if (checks === 1) process.send?.({ type: 'stop-if-idle-result', requestId: message.requestId, pid: process.pid + 1, ok: true, idle: true });",
    '});',
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  let completed = false;
  const daemon = runNativeDaemon({
    home,
    configFile,
    packageRoot,
    environment: {},
    workerControlTimeoutMs: 25,
  }).finally(() => { completed = true; });
  t.onTestFinished(async () => {
    if (!completed) await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const running = await until(async () => {
    const value = await requestControl(home, 'ping').catch(() => undefined);
    return value?.phase === 'running' ? value : undefined;
  });
  await assert.rejects(
    requestControl(home, 'stop-if-idle'),
    /PID does not match/u,
  );
  assert.equal((await requestControl(home, 'ping')).workerPid, running.workerPid);
  await assert.rejects(
    requestControl(home, 'stop-if-idle'),
    /Worker idle check timed out/u,
  );
  const after = await requestControl(home, 'ping');
  assert.equal(after.phase, 'running');
  assert.equal(after.workerPid, running.workerPid);
  assert.ok(readDaemonRecord(home));
  await fs.access(path.join(home, 'data/daemon.lock'));

  await requestControl(home, 'stop');
  await daemon;
});

test('iLink daemon launches its worker and honors a last-account shutdown request', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-ilink-daemon-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/ilink.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configFile, '');
  await fs.writeFile(workerFile, [
    "if (process.env.KINTIO_MANAGED_WORKER !== '1') process.exit(3);",
    "process.send?.({ type: 'ready', pid: process.pid });",
    "setTimeout(() => process.send?.({ type: 'shutdown-request', pid: process.pid }), 100);",
    "process.on('message', (message) => { if (message === 'shutdown') process.exit(0); });",
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  const daemon = runNativeDaemon({
    home,
    configFile,
    packageRoot,
    mode: 'ilink',
    environment: {},
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const running = await until(async () => {
    const response = await requestControl(home, 'ping').catch(() => undefined);
    return response?.phase === 'running' ? response : undefined;
  });
  assert.ok(running.workerPid);
  assert.equal(readDaemonRecord(home)?.mode, 'ilink');
  await daemon;
  await assert.rejects(fs.access(daemonRecordPath(home)), { code: 'ENOENT' });
  const log = await fs.readFile(path.join(home, 'data/logs/kintio.log'), 'utf8');
  assert.match(log, /daemon started[\s\S]+daemon stopped/u);
  assert.doesNotMatch(log, /worker exited|backoff|restart limit/u);
});

test('real iLink worker publishes readiness and drains after daemon shutdown', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-real-ilink-daemon-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const workerFile = path.join(packageRoot, 'dist/ilink.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.writeFile(
    workerFile,
    `await import(${JSON.stringify(pathToFileURL(path.resolve('ilink.ts')).href)});\n`,
  );
  const daemon = runNativeDaemon({
    home,
    configFile: path.join(home, '.env'),
    packageRoot,
    mode: 'ilink',
    environment: {},
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await daemon.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const running = await until(async () => {
    const response = await requestControl(home, 'ping').catch(() => undefined);
    return response?.phase === 'running' ? response : undefined;
  });
  assert.ok(running.workerPid);
  const stopped = await requestControl(home, 'stop-if-idle');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.idle, true);
  assert.equal(stopped.phase, 'stopping');
  await daemon;
  await assert.rejects(fs.access(daemonRecordPath(home)), { code: 'ENOENT' });
  assert.match(
    await fs.readFile(path.join(home, 'data/logs/kintio.log'), 'utf8'),
    /Kintio iLink runtime is active[\s\S]+daemon stopped/u,
  );
});

test('restart exhaustion remains observable until an explicit stop', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-failed-'));
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const configFile = path.join(home, '.env');
  const workerFile = path.join(packageRoot, 'dist/wecom.js');
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
  const stopped = await requestControl(home, 'stop-if-idle');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.idle, true);
  assert.equal(stopped.phase, 'stopping');
  await daemon;
});
