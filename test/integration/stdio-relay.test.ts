import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { TestContext } from 'vitest';
import { test } from 'vitest';

import {
  MCP_HANDSHAKE_ERROR,
  MCP_HANDSHAKE_OK,
  createMcpGeneration,
  mcpIpcAddress,
  parseMcpHandshake,
  readSocketLine,
  writeMcpDescriptor,
  type McpIpcDescriptor,
} from '../../src/mcp/ipc-protocol.ts';
import {
  parseMcpRelayArgs,
  runMcpRelay,
} from '../../src/mcp/stdio-relay.ts';

class SlowCollector extends Writable {
  readonly chunks: Buffer[] = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    setImmediate(() => {
      this.chunks.push(Buffer.from(chunk));
      callback();
    });
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class BrokenOutput extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  }
}

async function relayFixture(
  t: TestContext,
  accept: (socket: Socket, descriptor: McpIpcDescriptor) => void,
): Promise<{
  readonly descriptorFile: string;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-mcp-relay-'));
  const generation = createMcpGeneration();
  const descriptor: McpIpcDescriptor = Object.freeze({
    version: 1,
    generation,
    address: mcpIpcAddress(directory, generation),
    token: randomBytes(32).toString('base64url'),
  });
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(descriptor.address), { recursive: true, mode: 0o700 });
  }
  const sockets = new Set<Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    accept(socket, descriptor);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(descriptor.address, resolve);
  });
  const descriptorFile = writeMcpDescriptor(directory, descriptor);
  t.onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      fs.rmSync(path.dirname(descriptor.address), { recursive: true, force: true });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { descriptorFile };
}

test('relay arguments expose exactly one descriptor and one allowlisted route', () => {
  const descriptorFile = path.resolve(
    os.tmpdir(),
    'mcp-runtime-abcdefghijklmnopqrstuvwx.json',
  );
  assert.deepEqual(
    parseMcpRelayArgs([
      '--descriptor',
      descriptorFile,
      '--route',
      'conversation_memory',
    ]),
    { descriptorFile, route: 'conversation_memory' },
  );
  for (const args of [
    [],
    ['--descriptor', descriptorFile, '--route', 'unknown'],
    ['--route', 'conversation_memory', '--descriptor', descriptorFile],
    ['--descriptor', 'relative.json', '--route', 'conversation_memory'],
    ['--descriptor', descriptorFile, '--route', 'conversation_memory', '--extra'],
  ]) assert.throws(() => parseMcpRelayArgs(args));
});

test('authenticated relay preserves early bytes, raw bytes, EOF, and backpressure', async (t) => {
  const early = Buffer.from('{"jsonrpc":"2.0","method":"notifications/ready"}\n');
  const payload = Buffer.alloc(512 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  let serverDoneResolve!: () => void;
  let serverDoneReject!: (error: unknown) => void;
  const serverDone = new Promise<void>((resolve, reject) => {
    serverDoneResolve = resolve;
    serverDoneReject = reject;
  });
  const fixture = await relayFixture(t, (socket, descriptor) => {
    void (async () => {
      const route = parseMcpHandshake(await readSocketLine(socket), descriptor);
      assert.equal(route, 'conversation_memory');
      socket.write(Buffer.concat([Buffer.from(`${MCP_HANDSHAKE_OK}\n`), early]));
      for await (const chunk of socket) {
        if (!socket.write(chunk)) await once(socket, 'drain');
      }
      socket.end();
      serverDoneResolve();
    })().catch(serverDoneReject);
  });
  // A one-byte high-water mark on the sink forces the relay to respect stdout
  // backpressure instead of buffering the entire server response itself.
  const source = new PassThrough();
  const output = new SlowCollector();
  const running = runMcpRelay([
    '--descriptor',
    fixture.descriptorFile,
    '--route',
    'conversation_memory',
  ], { input: source, output });
  source.end(payload);
  await running;
  await serverDone;
  assert.deepEqual(output.bytes(), Buffer.concat([early, payload]));
});

test('relay emits no MCP bytes and never retries when authentication fails', async (t) => {
  let connections = 0;
  const fixture = await relayFixture(t, (socket) => {
    connections += 1;
    void readSocketLine(socket).then(() => {
      socket.end(`${MCP_HANDSHAKE_ERROR}\nsecret-server-bytes`);
    });
  });
  const source = new PassThrough();
  const output = new SlowCollector();
  source.end('client-bytes');
  await assert.rejects(runMcpRelay([
    '--descriptor',
    fixture.descriptorFile,
    '--route',
    'wechat_kf',
  ], { input: source, output }));
  assert.equal(connections, 1);
  assert.equal(output.bytes().length, 0);
  output.destroy();
});

test('stdout EPIPE terminates both directions without reconnecting', async (t) => {
  let connections = 0;
  let peerClosedResolve!: () => void;
  const peerClosed = new Promise<void>((resolve) => { peerClosedResolve = resolve; });
  const fixture = await relayFixture(t, (socket) => {
    connections += 1;
    socket.once('close', peerClosedResolve);
    socket.once('end', () => socket.end());
    void readSocketLine(socket).then(() => {
      socket.write(`${MCP_HANDSHAKE_OK}\nserver-frame`);
      socket.resume();
    });
  });
  const source = new PassThrough();
  await assert.rejects(runMcpRelay([
    '--descriptor',
    fixture.descriptorFile,
    '--route',
    'conversation_memory',
  ], { input: source, output: new BrokenOutput() }));
  await peerClosed;
  assert.equal(connections, 1);
});

test('relay binds the private descriptor filename to its generation', async (t) => {
  let connections = 0;
  const fixture = await relayFixture(t, (socket) => {
    connections += 1;
    socket.destroy();
  });
  const copied = path.join(path.dirname(fixture.descriptorFile), 'copied.json');
  fs.copyFileSync(fixture.descriptorFile, copied);
  fs.chmodSync(copied, 0o600);
  const source = new PassThrough();
  const output = new SlowCollector();
  source.end();
  await assert.rejects(runMcpRelay([
    '--descriptor',
    copied,
    '--route',
    'conversation_memory',
  ], { input: source, output }));
  assert.equal(connections, 0);
  output.destroy();
});
