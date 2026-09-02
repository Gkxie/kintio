import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { test } from 'vitest';

import {
  controlAddress,
  daemonRecordPath,
  parseControlRequest,
  parseControlResponse,
  parseDaemonRecord,
  parseWorkerStopIfIdleRequest,
  parseWorkerStopIfIdleResponse,
  readDaemonRecord,
  requestControl,
  writeDaemonRecord,
  type ControlResponse,
  type DaemonRecord,
} from '../../src/runtime/daemon-protocol.ts';

const TOKEN = 'a'.repeat(43);
const CONFIG_FILE = path.resolve('/tmp/kintio-config/.env');
const PACKAGE_ROOT = path.resolve('.');

async function temporaryHome(t: TestContext): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-protocol-'));
  t.onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

function daemon(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    version: 1,
    runId: 'run_1',
    daemonPid: 1234,
    configFile: CONFIG_FILE,
    mode: 'service',
    packageRoot: PACKAGE_ROOT,
    token: TOKEN,
    ...overrides,
  };
}

function response(overrides: Partial<ControlResponse> = {}): ControlResponse {
  return {
    ok: true,
    runId: 'run_1',
    daemonPid: 1234,
    workerPid: 5678,
    phase: 'running',
    ...overrides,
  };
}

test('control addresses are short, local, instance-scoped, and run-scoped', () => {
  const first = path.resolve('/tmp/kintio-first');
  const second = path.resolve('/tmp/kintio-second');
  const posix = controlAddress(first, 'linux');
  assert.match(posix, /[/\\]kintio-[a-f0-9]{32}\.sock$/u);
  assert.equal(controlAddress(first, 'darwin'), posix);
  assert.notEqual(controlAddress(second, 'linux'), posix);
  assert.notEqual(controlAddress(first, 'linux', 'run_1'), posix);
  assert.equal(controlAddress(first, 'linux', 'run_1').length, 49);

  const windows = controlAddress(first, 'win32');
  assert.match(windows, /^\\\\\.\\pipe\\kintio-[a-f0-9]{32}$/u);
  assert.notEqual(controlAddress(first, 'win32', 'run_1'), windows);
});

test('control address identity follows filesystem aliases', async (t) => {
  const root = await temporaryHome(t);
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(controlAddress(real), controlAddress(alias));
});

test('protocol schemas are versioned, closed, and validate security-sensitive fields', () => {
  assert.deepEqual(parseDaemonRecord(daemon()), daemon());
  const legacy: Record<string, unknown> = { ...daemon() };
  delete legacy.mode;
  assert.deepEqual(parseDaemonRecord(legacy), daemon());
  assert.deepEqual(parseControlRequest({ version: 1, command: 'stop', token: TOKEN }), {
    version: 1,
    command: 'stop',
    token: TOKEN,
  });
  assert.deepEqual(parseControlResponse(response()), response());
  assert.deepEqual(parseWorkerStopIfIdleRequest({
    type: 'stop-if-idle',
    requestId: 'request_1',
  }), {
    type: 'stop-if-idle',
    requestId: 'request_1',
  });
  assert.deepEqual(parseWorkerStopIfIdleResponse({
    type: 'stop-if-idle-result',
    requestId: 'request_1',
    pid: 5678,
    ok: true,
    idle: false,
  }), {
    type: 'stop-if-idle-result',
    requestId: 'request_1',
    pid: 5678,
    ok: true,
    idle: false,
  });

  assert.throws(() => parseDaemonRecord({ ...daemon(), extra: true }));
  assert.throws(() => parseDaemonRecord({ ...daemon(), configFile: 'relative.env' }));
  assert.throws(() => parseDaemonRecord({ ...daemon(), token: 'short' }));
  assert.throws(() => parseControlRequest({ version: 1, command: 'restart', token: TOKEN }));
  assert.throws(() => parseControlResponse({ ...response(), phase: 'online' }));
  assert.throws(() => parseControlResponse({ ...response(), message: '' }));
  assert.throws(() => parseWorkerStopIfIdleRequest({
    type: 'stop-if-idle', requestId: '',
  }));
  assert.throws(() => parseWorkerStopIfIdleRequest({
    type: 'stop-if-idle', requestId: 'bad request',
  }));
  assert.throws(() => parseWorkerStopIfIdleRequest({
    type: 'stop-if-idle', requestId: 'x'.repeat(129),
  }));
  assert.throws(() => parseWorkerStopIfIdleRequest({
    type: 'stop-if-idle', requestId: 'request_1', extra: true,
  }));
  assert.throws(() => parseWorkerStopIfIdleResponse({
    type: 'stop-if-idle-result', requestId: 'request_1', pid: 5678, ok: true,
  }));
  assert.throws(() => parseWorkerStopIfIdleResponse({
    type: 'stop-if-idle-result', requestId: 'request_1', pid: 5678, ok: false,
  }));
  assert.throws(() => parseWorkerStopIfIdleResponse({
    type: 'stop-if-idle-result', requestId: 'request_1', pid: 5678,
    ok: false, idle: false, message: 'failed',
  }));
});

test('daemon identity and control capability share one private static record', async (t) => {
  const home = await temporaryHome(t);
  writeDaemonRecord(home, daemon());

  assert.deepEqual(readDaemonRecord(home), daemon());
  assert.equal((await fs.readFile(daemonRecordPath(home), 'utf8')).includes(TOKEN), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(daemonRecordPath(home))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(path.join(home, 'data')), ['daemon.json']);
});

test('metadata reads fail closed for redirects, unsafe permissions, and oversized JSON', async (t) => {
  const home = await temporaryHome(t);
  await fs.mkdir(path.join(home, 'data'), { recursive: true });
  const outside = path.join(home, 'outside.json');
  await fs.writeFile(outside, `${JSON.stringify(daemon())}\n`, { mode: 0o600 });
  await fs.symlink(outside, daemonRecordPath(home), 'file');
  assert.throws(() => readDaemonRecord(home), /not a regular file/u);

  await fs.rm(daemonRecordPath(home));
  await fs.writeFile(daemonRecordPath(home), `${JSON.stringify(daemon())}\n`, { mode: 0o644 });
  if (process.platform !== 'win32') {
    assert.throws(() => readDaemonRecord(home), /unsafe permissions/u);
  }

  await fs.rm(daemonRecordPath(home));
  await fs.writeFile(daemonRecordPath(home), 'x'.repeat(4_097), { mode: 0o600 });
  assert.throws(() => readDaemonRecord(home), /exceeds 4096 bytes/u);
});

async function listen(
  t: TestContext,
  home: string,
  reply: (request: unknown) => string | undefined,
): Promise<void> {
  const address = controlAddress(home, process.platform, daemon().runId);
  const server = net.createServer((socket) => {
    let source = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      source += chunk;
      const newline = source.indexOf('\n');
      if (newline === -1) return;
      const output = reply(JSON.parse(source.slice(0, newline)) as unknown);
      if (output !== undefined) socket.end(output);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  t.onTestFinished(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

test('control client authenticates lifecycle commands over one local IPC message', async (t) => {
  const home = await temporaryHome(t);
  writeDaemonRecord(home, daemon());
  const commands: string[] = [];
  await listen(t, home, (value) => {
    const parsed = parseControlRequest(value);
    commands.push(parsed.command);
    return `${JSON.stringify(response({
      phase: parsed.command === 'stop' || parsed.command === 'stop-if-idle'
        ? 'stopping'
        : 'running',
      ...(parsed.command === 'stop-if-idle' ? { idle: true } : {}),
    }))}\n`;
  });

  assert.deepEqual(await requestControl(home, 'ping'), response());
  assert.deepEqual(await requestControl(home, 'stop'), response({ phase: 'stopping' }));
  assert.deepEqual(await requestControl(home, 'stop-if-idle'), response({
    phase: 'stopping',
    idle: true,
  }));
  assert.deepEqual(commands, ['ping', 'stop', 'stop-if-idle']);
});

test('stop-if-idle client fails closed on omitted or contradictory decisions', async (t) => {
  const omittedHome = await temporaryHome(t);
  writeDaemonRecord(omittedHome, daemon());
  await listen(t, omittedHome, () => `${JSON.stringify(response())}\n`);
  await assert.rejects(
    requestControl(omittedHome, 'stop-if-idle'),
    /omitted the idle decision/u,
  );

  const phaseHome = await temporaryHome(t);
  writeDaemonRecord(phaseHome, daemon());
  await listen(t, phaseHome, () => `${JSON.stringify(response({ idle: true }))}\n`);
  await assert.rejects(
    requestControl(phaseHome, 'stop-if-idle'),
    /did not enter the stopping phase/u,
  );

  const unexpectedHome = await temporaryHome(t);
  writeDaemonRecord(unexpectedHome, daemon());
  await listen(t, unexpectedHome, () => `${JSON.stringify(response({ idle: false }))}\n`);
  await assert.rejects(
    requestControl(unexpectedHome, 'ping'),
    /unexpected idle decision/u,
  );
});

test('control client rejects server failures, stale identity, oversized output, and timeout', async (t) => {
  const rejectedHome = await temporaryHome(t);
  writeDaemonRecord(rejectedHome, daemon());
  await listen(t, rejectedHome, () => `${JSON.stringify(response({
    ok: false,
    message: 'control authentication failed',
  }))}\n`);
  await assert.rejects(requestControl(rejectedHome, 'ping'), /authentication failed/u);

  const staleHome = await temporaryHome(t);
  writeDaemonRecord(staleHome, daemon());
  await listen(t, staleHome, () => `${JSON.stringify(response({ runId: 'other' }))}\n`);
  await assert.rejects(requestControl(staleHome, 'ping'), /identity does not match/u);

  const oversizedHome = await temporaryHome(t);
  writeDaemonRecord(oversizedHome, daemon());
  await listen(t, oversizedHome, () => `${'x'.repeat(4_097)}\n`);
  await assert.rejects(requestControl(oversizedHome, 'ping'), /exceeds 4096 bytes/u);

  const timeoutHome = await temporaryHome(t);
  writeDaemonRecord(timeoutHome, daemon());
  await listen(t, timeoutHome, () => undefined);
  await assert.rejects(requestControl(timeoutHome, 'ping', 20), /timed out/u);
});

test('metadata helpers reject invalid run identities and return null when absent', async (t) => {
  const home = await temporaryHome(t);
  assert.equal(readDaemonRecord(home), null);
  assert.throws(() => controlAddress(home, process.platform, 'not valid'));
});
