import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createConnection, createServer as createNetServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { test, type TestContext } from 'vitest';
import { z } from 'zod';

import { createConversationMemoryMcpServer } from '../../src/mcp/conversation-memory-server.ts';
import { McpIpcHost } from '../../src/mcp/ipc-host.ts';
import { createIlinkMcpServer } from '../../src/mcp/ilink-server.ts';
import { createWechatKfMcpServer } from '../../src/mcp/wechat-kf-server.ts';
import {
  MCP_HANDSHAKE_ERROR,
  MCP_HANDSHAKE_OK,
  MCP_FRAME_MAX_BYTES,
  findMcpDescriptorFile,
  mcpHandshake,
  mcpInstanceId,
  mcpIpcAddress,
  readMcpDescriptor,
  readSocketLine,
  type McpRoute,
} from '../../src/mcp/ipc-protocol.ts';

async function stateDirectory(t: TestContext): Promise<string> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'kintio-mcp-host-'));
  t.onTestFinished(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return directory;
}

function createRouteServer(route: McpRoute): McpServer {
  const server = new McpServer({ name: `ipc-host-test-${route}`, version: '1.0.0' });
  server.registerTool(
    `echo_${route}`,
    { inputSchema: { text: z.string() } },
    ({ text }) => Promise.resolve({
      content: [{ type: 'text', text: `${route}:${text}` }],
      structuredContent: { route, text },
    }),
  );
  return server;
}

function createRelayStub(directory: string): string {
  const relayFile = path.join(directory, 'mcp-relay.js');
  fs.writeFileSync(relayFile, '');
  return relayFile;
}

async function createOrphanSocket(staging: string, target: string): Promise<void> {
  fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(staging, resolve);
  });
  fs.renameSync(staging, target);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function connect(address: string): Promise<Socket> {
  const socket = createConnection(address);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function descriptorArgument(args: readonly string[]): string {
  const index = args.indexOf('--descriptor');
  assert.ok(index >= 0);
  const value = args[index + 1];
  assert.ok(value);
  return value;
}

function instanceStateDirectory(parent: string, instanceKey: string): string {
  return path.join(parent, '.kintio-mcp', mcpInstanceId(instanceKey));
}

test('host exposes authenticated MCP over a pipe without a TCP listener or token arguments', async (t) => {
  const directory = await stateDirectory(t);
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o755);
  const instanceKey = path.join(directory, 'instance');
  const orphanAddress = mcpIpcAddress(instanceKey, 'z'.repeat(24));
  if (process.platform !== 'win32') {
    const stagingAddress = mcpIpcAddress(instanceKey, 'y'.repeat(24));
    await createOrphanSocket(stagingAddress, orphanAddress);
    t.onTestFinished(() => fsPromises.rm(orphanAddress, { force: true }));
  }
  const errors: string[] = [];
  const host = new McpIpcHost({
    instanceKey,
    stateDirectory: directory,
    relayFile: createRelayStub(directory),
    memory: () => createRouteServer('conversation_memory'),
    logger: { error: (message) => errors.push(message) },
  });
  t.onTestFinished(() => host.close(true));

  const launches = await host.start();
  if (process.platform !== 'win32') assert.equal(fs.existsSync(orphanAddress), false);
  assert.equal(launches.wechatKf, undefined);
  assert.equal(launches.ilink, undefined);
  assert.equal(launches.memory.command, process.execPath);
  assert.deepEqual(launches.memory.args.slice(-2), ['--route', 'conversation_memory']);
  assert.doesNotMatch(launches.memory.args.join(' '), /https?:|127\.0\.0\.1|localhost/u);

  const descriptorFile = descriptorArgument(launches.memory.args);
  const descriptor = readMcpDescriptor(descriptorFile);
  assert.equal(
    findMcpDescriptorFile(directory, instanceKey),
    descriptorFile,
  );
  assert.equal(path.dirname(descriptorFile), instanceStateDirectory(directory, instanceKey));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(descriptorFile)).mode & 0o777, 0o700);
  }
  assert.equal(launches.memory.args.includes(descriptor.token), false);
  assert.equal(descriptor.address, mcpIpcAddress(instanceKey, descriptor.generation));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(descriptor.address).isSocket(), true);
    assert.equal(fs.statSync(descriptor.address).mode & 0o777, 0o600);
  }

  const rejected = await connect(descriptor.address);
  rejected.write(mcpHandshake({ ...descriptor, token: 'x'.repeat(43) }, 'conversation_memory'));
  assert.equal(await readSocketLine(rejected), MCP_HANDSHAKE_ERROR);
  rejected.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);

  const accepted = await connect(descriptor.address);
  const acceptedClosed = new Promise<void>((resolve) => accepted.once('close', () => resolve()));
  accepted.write(mcpHandshake(descriptor, 'conversation_memory'));
  assert.equal(await readSocketLine(accepted), MCP_HANDSHAKE_OK);
  await new Promise<void>((resolve) => setImmediate(resolve));

  let closed = false;
  const graceful = host.close();
  void graceful.then(() => { closed = true; });
  assert.equal(fs.existsSync(descriptorFile), false);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(descriptor.address), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  const forced = host.close(true);
  assert.equal(forced, graceful);
  await forced;
  await acceptedClosed;
  assert.equal(accepted.destroyed, true);
  assert.deepEqual(errors, []);
});

test('close racing start rejects the unpublished launch and leaves no descriptor or socket', async (t) => {
  const directory = await stateDirectory(t);
  const instanceKey = path.join(directory, 'racing-instance');
  const host = new McpIpcHost({
    instanceKey,
    stateDirectory: directory,
    relayFile: createRelayStub(directory),
    memory: () => createRouteServer('conversation_memory'),
    logger: { error() {} },
  });

  const starting = host.start();
  const closing = host.close();
  await assert.rejects(starting, /MCP IPC host is closed/u);
  await closing;
  assert.deepEqual(
    fs.readdirSync(instanceStateDirectory(directory, instanceKey))
      .filter((name) => /^mcp-runtime-.*\.json$/u.test(name)),
    [],
  );
  if (process.platform !== 'win32') {
    const socketDirectory = path.dirname(mcpIpcAddress(instanceKey, 'a'.repeat(24)));
    assert.deepEqual(
      fs.existsSync(socketDirectory)
        ? fs.readdirSync(socketDirectory).filter((name) => name.endsWith('.sock'))
        : [],
      [],
    );
  }
  await assert.rejects(host.start(), /MCP IPC host is closed/u);
});

test('one IPC listener routes three Agent MCP clients independently', async (t) => {
  const directory = await stateDirectory(t);
  const calls: string[] = [];
  const host = new McpIpcHost({
    instanceKey: path.join(directory, 'three-routes'),
    stateDirectory: directory,
    relayFile: path.resolve('mcp-relay.ts'),
    wechatKf: () => createWechatKfMcpServer({
      execute(name) {
        calls.push(`wechat_kf:${name}`);
        return Promise.resolve({
          status: 'accepted', attemptId: 'sa_wechat', sendIndex: 0,
          type: 'text', providerMessageId: 'wechat-message',
        });
      },
    }),
    ilink: () => createIlinkMcpServer({
      execute(name) {
        calls.push(`weixin_ilink:${name}`);
        return Promise.resolve({
          status: 'accepted', attemptId: 'sa_ilink', sendIndex: 0,
          type: 'text', providerMessageId: 'ilink-message',
        });
      },
    }),
    memory: () => createConversationMemoryMcpServer({
      read() {
        calls.push('conversation_memory:read_archived_thread');
        return Promise.resolve({
          status: 'available', memory: 'archived context', truncated: false,
        });
      },
    }),
  });
  t.onTestFinished(() => host.close(true));
  const launches = await host.start();
  const clients: Client[] = [];
  t.onTestFinished(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });

  const routes = [
    {
      route: 'wechat_kf',
      launch: launches.wechatKf,
      tools: [
        'send_text', 'send_image',
        'send_link', 'send_miniprogram', 'send_location',
      ],
      call: { name: 'send_text', arguments: { session: `ws_${'a'.repeat(32)}`, content: 'hi' } },
      expected: { status: 'accepted', attemptId: 'sa_wechat', sendIndex: 0,
        type: 'text', providerMessageId: 'wechat-message' },
    },
    {
      route: 'weixin_ilink',
      launch: launches.ilink,
      tools: ['send_text', 'send_image'],
      call: { name: 'send_text', arguments: { session: `ws_${'b'.repeat(32)}`, content: 'hi' } },
      expected: { status: 'accepted', attemptId: 'sa_ilink', sendIndex: 0,
        type: 'text', providerMessageId: 'ilink-message' },
    },
    {
      route: 'conversation_memory',
      launch: launches.memory,
      tools: ['read_archived_thread'],
      call: { name: 'read_archived_thread', arguments: { session: `ws_${'c'.repeat(32)}` } },
      expected: { status: 'available', memory: 'archived context', truncated: false },
    },
  ] as const;
  await Promise.all(routes.map(async ({ route, launch, tools, call, expected }) => {
    assert.ok(launch);
    const client = new Client({ name: `stdio-client-${route}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      cwd: path.resolve('.'),
      stderr: 'pipe',
    }));
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      tools,
    );
    const result = await client.callTool(call);
    assert.deepEqual(result.structuredContent, expected);
  }));
  assert.deepEqual(new Set(calls), new Set([
    'wechat_kf:send_text',
    'weixin_ilink:send_text',
    'conversation_memory:read_archived_thread',
  ]));

  await Promise.all(clients.map((client) => client.close()));
  await host.close();
});

test('host fails before publishing IPC state when the relay entry is missing', async (t) => {
  const directory = await stateDirectory(t);
  const host = new McpIpcHost({
    instanceKey: path.join(directory, 'missing-relay'),
    stateDirectory: directory,
    relayFile: path.join(directory, 'missing-relay.js'),
    memory: () => createRouteServer('conversation_memory'),
  });
  await assert.rejects(host.start(), /MCP relay entry is unavailable/u);
  assert.equal(fs.existsSync(path.join(directory, '.kintio-mcp')), false);
  await host.close();
});

test('stale cleanup is isolated when two instances share one state parent', async (t) => {
  const directory = await stateDirectory(t);
  const firstKey = path.join(directory, 'first.lock');
  const secondKey = path.join(directory, 'second.lock');
  const relayFile = createRelayStub(directory);
  const first = new McpIpcHost({
    instanceKey: firstKey,
    stateDirectory: directory,
    relayFile,
    memory: () => createRouteServer('conversation_memory'),
  });
  const second = new McpIpcHost({
    instanceKey: secondKey,
    stateDirectory: directory,
    relayFile,
    memory: () => createRouteServer('conversation_memory'),
  });
  t.onTestFinished(async () => {
    await Promise.allSettled([first.close(true), second.close(true)]);
  });

  const firstDescriptor = descriptorArgument((await first.start()).memory.args);
  const secondDescriptor = descriptorArgument((await second.start()).memory.args);
  assert.equal(fs.existsSync(firstDescriptor), true);
  assert.equal(fs.existsSync(secondDescriptor), true);
  assert.notEqual(path.dirname(firstDescriptor), path.dirname(secondDescriptor));

  await Promise.all([first.close(), second.close()]);
});

test('an authenticated route factory failure closes the connection with one generic log', async (t) => {
  const directory = await stateDirectory(t);
  const errors: string[] = [];
  const host = new McpIpcHost({
    instanceKey: path.join(directory, 'factory-failure'),
    stateDirectory: directory,
    relayFile: createRelayStub(directory),
    memory() {
      throw new Error('private factory detail');
    },
    logger: { error: (message) => errors.push(message) },
  });
  t.onTestFinished(() => host.close(true));
  const launch = (await host.start()).memory;
  const descriptor = readMcpDescriptor(descriptorArgument(launch.args));
  const socket = await connect(descriptor.address);
  socket.write(mcpHandshake(descriptor, 'conversation_memory'));
  await assert.rejects(readSocketLine(socket), /handshake (?:ended|closed)/u);
  assert.deepEqual(errors, ['[mcp] authenticated IPC connection failed']);
});

test('an authenticated MCP frame over 256 KiB is disconnected before dispatch', async (t) => {
  const directory = await stateDirectory(t);
  const host = new McpIpcHost({
    instanceKey: path.join(directory, 'oversized-frame'),
    stateDirectory: directory,
    relayFile: createRelayStub(directory),
    memory: () => createRouteServer('conversation_memory'),
  });
  t.onTestFinished(() => host.close(true));
  const launch = (await host.start()).memory;
  const descriptor = readMcpDescriptor(descriptorArgument(launch.args));
  const socket = await connect(descriptor.address);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(mcpHandshake(descriptor, 'conversation_memory'));
  assert.equal(await readSocketLine(socket), MCP_HANDSHAKE_OK);
  socket.write(Buffer.alloc(MCP_FRAME_MAX_BYTES + 1, 0x20));

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('oversized MCP frame remained connected')),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

test('closing an unopened host is idempotent and force can upgrade graceful shutdown', async (t) => {
  const directory = await stateDirectory(t);
  const host = new McpIpcHost({
    instanceKey: path.join(directory, 'unopened'),
    stateDirectory: directory,
    relayFile: path.join(directory, 'mcp-relay.js'),
    memory: () => createRouteServer('conversation_memory'),
  });
  const graceful = host.close();
  assert.equal(host.close(true), graceful);
  await graceful;
  await assert.rejects(host.start(), /MCP IPC host is closed/u);
});
