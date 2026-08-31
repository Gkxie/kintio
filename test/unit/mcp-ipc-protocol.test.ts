import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { test, type TestContext } from 'vitest';

import {
  createMcpGeneration,
  mcpDescriptorPath,
  mcpHandshake,
  mcpInstanceId,
  mcpIpcAddress,
  parseMcpHandshake,
  readMcpDescriptor,
  readSocketLine,
  writeMcpDescriptor,
  type McpIpcDescriptor,
} from '../../src/mcp/ipc-protocol.ts';

async function privateDirectory(t: TestContext): Promise<string> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'kintio-mcp-protocol-'));
  t.onTestFinished(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return directory;
}

function descriptor(instanceKey: string, generation = createMcpGeneration()): McpIpcDescriptor {
  return {
    version: 1,
    generation,
    address: mcpIpcAddress(instanceKey, generation),
    token: 't'.repeat(43),
  };
}

async function socketPair(t: TestContext): Promise<{
  readonly listener: Server;
  readonly client: Socket;
  readonly peer: Socket;
}> {
  const generation = createMcpGeneration();
  const address = mcpIpcAddress(`protocol-test-${generation}`, generation);
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(address), { recursive: true, mode: 0o700 });
    fs.rmSync(address, { force: true });
  }
  const listener = createServer();
  const accepted = new Promise<Socket>((resolve, reject) => {
    listener.once('connection', resolve);
    listener.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(address, resolve);
  });
  const client = createConnection(address);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  const peer = await accepted;
  t.onTestFinished(async () => {
    client.destroy();
    peer.destroy();
    if (listener.listening) {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      fs.rmSync(path.dirname(address), { recursive: true, force: true });
    }
  });
  return { listener, client, peer };
}

test('MCP IPC addresses are platform-native and never TCP endpoints', () => {
  const generation = 'a'.repeat(24);
  const windows = mcpIpcAddress('instance', generation, 'win32');
  assert.equal(windows.startsWith('\\\\.\\pipe\\kintio-mcp-'), true);
  assert.equal(windows.endsWith(`-${generation}`), true);
  for (const platform of ['linux', 'darwin'] as const) {
    const address = mcpIpcAddress('instance', generation, platform);
    assert.equal(address.startsWith('/tmp/kintio-mcp-'), true);
    assert.equal(address.endsWith(`/${generation}.sock`), true);
    assert.doesNotMatch(address, /https?:|:\d+$/u);
  }
});

test('instance identity follows filesystem aliases instead of creating duplicate runtime state', async (t) => {
  const directory = await privateDirectory(t);
  const target = path.join(directory, 'instance');
  const alias = path.join(directory, 'instance-alias');
  await fsPromises.mkdir(target);
  await fsPromises.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(
    mcpInstanceId(path.join(target, 'kintio.lock')),
    mcpInstanceId(path.join(alias, 'kintio.lock')),
  );
});

test('descriptor round-trip requires its private directory, owner, mode, and exact name', async (t) => {
  const directory = await privateDirectory(t);
  const expected = descriptor(directory);
  const filePath = writeMcpDescriptor(directory, expected);
  assert.deepEqual(readMcpDescriptor(filePath), expected);
  assert.equal(filePath, mcpDescriptorPath(directory, expected.generation));
  assert.throws(() => writeMcpDescriptor(directory, expected), /EEXIST/u);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    fs.chmodSync(filePath, 0o640);
    assert.throws(() => readMcpDescriptor(filePath), /Unsafe MCP descriptor/u);
    fs.chmodSync(filePath, 0o600);
  }

  const wrongGeneration = createMcpGeneration();
  const wrongName = mcpDescriptorPath(directory, wrongGeneration);
  fs.renameSync(filePath, wrongName);
  assert.throws(() => readMcpDescriptor(wrongName), /Unsafe MCP descriptor/u);
});

test('descriptor parsing rejects generation/address mismatch and unsafe storage', async (t) => {
  const directory = await privateDirectory(t);
  const first = descriptor(directory);
  const mismatched: McpIpcDescriptor = {
    ...first,
    generation: createMcpGeneration(),
  };
  assert.throws(() => writeMcpDescriptor(directory, mismatched), /Invalid MCP descriptor/u);

  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o755);
    assert.throws(() => writeMcpDescriptor(directory, first), /Unsafe MCP state directory/u);
    fs.chmodSync(directory, 0o700);
  }

  const oversizedPath = mcpDescriptorPath(directory, first.generation);
  fs.writeFileSync(oversizedPath, 'x'.repeat(4 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => readMcpDescriptor(oversizedPath), /Unsafe MCP descriptor/u);
});

test('descriptor reader refuses symbolic links instead of following them', async (t) => {
  const directory = await privateDirectory(t);
  const expected = descriptor(directory);
  const realPath = writeMcpDescriptor(directory, expected);
  if (process.platform === 'win32') {
    assert.deepEqual(readMcpDescriptor(realPath), expected);
    return;
  }
  const linkedGeneration = createMcpGeneration();
  const linkedPath = mcpDescriptorPath(directory, linkedGeneration);
  fs.symlinkSync(realPath, linkedPath);
  assert.throws(() => readMcpDescriptor(linkedPath), /Unsafe MCP descriptor/u);
});

test('handshake is exact and token comparison rejects malformed capabilities', () => {
  const expected = descriptor('/tmp/handshake');
  const source = mcpHandshake(expected, 'conversation_memory');
  assert.equal(parseMcpHandshake(source, expected), 'conversation_memory');
  const parsed = JSON.parse(source) as Record<string, unknown>;
  assert.equal(parseMcpHandshake(JSON.stringify({ ...parsed, token: 'x'.repeat(43) }), expected), undefined);
  assert.equal(parseMcpHandshake(JSON.stringify({ ...parsed, generation: createMcpGeneration() }), expected), undefined);
  assert.equal(parseMcpHandshake(JSON.stringify({ ...parsed, route: 'unknown' }), expected), undefined);
  assert.equal(parseMcpHandshake(JSON.stringify({ ...parsed, extra: true }), expected), undefined);
  assert.equal(parseMcpHandshake('not-json', expected), undefined);
});

test('handshake reader preserves bytes after the first line while paused', async (t) => {
  const { client, peer } = await socketPair(t);
  const line = readSocketLine(peer);
  client.write('hello\r\nfirst-mcp-frame\n');
  assert.equal(await line, 'hello');
  assert.equal(peer.isPaused(), true);
  assert.equal(peer.read()?.toString('utf8'), 'first-mcp-frame\n');
});

test('handshake reader accepts 512 bytes and rejects 513 bytes', async (t) => {
  const accepted = await socketPair(t);
  const acceptedLine = readSocketLine(accepted.peer);
  accepted.client.write(`${'a'.repeat(512)}\n`);
  assert.equal((await acceptedLine).length, 512);

  const rejected = await socketPair(t);
  const rejectedLine = readSocketLine(rejected.peer);
  rejected.client.write(`${'a'.repeat(513)}\n`);
  await assert.rejects(rejectedLine, /handshake too large/u);
});

test('handshake reader fails closed after two seconds without input', async (t) => {
  const { peer } = await socketPair(t);
  const startedAt = Date.now();
  await assert.rejects(readSocketLine(peer), /handshake timed out/u);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1_800, `timeout fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 4_000, `timeout fired too late: ${elapsed}ms`);
});

test('handshake reader fails closed on stream error, end, and close', async (t) => {
  const errored = await socketPair(t);
  const erroredLine = readSocketLine(errored.peer);
  errored.peer.destroy(new Error('synthetic transport failure'));
  await assert.rejects(erroredLine, /handshake failed/u);

  const ended = await socketPair(t);
  const endedLine = readSocketLine(ended.peer);
  ended.client.end();
  await assert.rejects(endedLine, /handshake ended/u);

  const closed = await socketPair(t);
  const closedLine = readSocketLine(closed.peer);
  closed.peer.destroy();
  await assert.rejects(closedLine, /handshake closed/u);
});
