import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { test } from 'vitest';
import { z } from 'zod';

import { handleMcpHttpRequest } from '../../src/mcp/http.ts';
import { LocalMcpHost } from '../../src/mcp/local-host.ts';

function memoryHandler(
  authorizationHeaders: Array<string | null>,
): (request: Request) => Promise<Response> {
  return (request) => {
    authorizationHeaders.push(request.headers.get('authorization'));
    return handleMcpHttpRequest({
      request,
      createServer() {
        const server = new McpServer(
          { name: 'local-mcp-test', version: '1.0.0' },
        );
        server.registerTool(
          'echo',
          { inputSchema: { text: z.string() } },
          ({ text }) => Promise.resolve({
            content: [{ type: 'text', text }],
            structuredContent: { text },
          }),
        );
        return server;
      },
    });
  };
}

test('local MCP is loopback-only, interoperable, optional, and releases its port', async (t) => {
  const authorizationHeaders: Array<string | null> = [];
  const host = new LocalMcpHost({
    memory: memoryHandler(authorizationHeaders),
  });
  t.onTestFinished(() => host.close());

  const endpoints = await host.start();
  const endpoint = new URL(endpoints.memory);
  const port = Number(endpoint.port);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(endpoints.wechatKf, undefined);
  assert.equal(endpoints.ilink, undefined);
  assert.equal((await fetch(new URL('/mcp', endpoint))).status, 404);
  assert.equal((await fetch(new URL('/mcp/ilink', endpoint))).status, 404);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(endpoint, {
      method: 'POST',
      headers: { host: 'attacker.example' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end('{}');
  });
  assert.equal(foreignHost, 403);
  const otherPort = port === 65_535 ? port - 1 : port + 1;
  for (const host of [`127.0.0.1:${otherPort}`, '127.0.0.1']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(endpoint, {
        method: 'POST',
        headers: { host },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once('error', reject);
      request.end('{}');
    });
    assert.equal(status, 403, host);
  }
  assert.equal((await fetch(endpoint, {
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    body: '{}',
  })).status, 403);
  const declaredOversize = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(endpoint, {
      method: 'POST',
      headers: { 'content-length': String(300 * 1024) },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end('x');
  });
  assert.equal(declaredOversize, 413);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200 * 1024));
      controller.enqueue(new Uint8Array(100 * 1024));
      controller.close();
    },
  });
  assert.equal((await fetch(endpoint, {
    method: 'POST',
    body: oversized,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })).status, 413);

  const client = new Client({ name: 'local-mcp-client', version: '1.0.0' });
  t.onTestFinished(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(endpoint) as unknown as
      Parameters<Client['connect']>[0],
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['echo'],
  );
  const result = await client.callTool({
    name: 'echo',
    arguments: { text: 'hello from loopback' },
  });
  assert.deepEqual(result.structuredContent, { text: 'hello from loopback' });
  assert.ok(authorizationHeaders.length > 0);
  assert.deepEqual(new Set(authorizationHeaders), new Set([null]));

  await client.close();
  await host.close();
  const afterClose = new Client({ name: 'closed-local-mcp', version: '1.0.0' });
  await assert.rejects(afterClose.connect(
    new StreamableHTTPClientTransport(endpoint) as unknown as
      Parameters<Client['connect']>[0],
  ));
  await afterClose.close().catch(() => undefined);

  const rebound = net.createServer();
  await new Promise<void>((resolve, reject) => {
    rebound.once('error', reject);
    rebound.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    rebound.close((error) => error ? reject(error) : resolve());
  });

  const unopened = new LocalMcpHost({ memory: memoryHandler([]) });
  await unopened.close();
  await assert.rejects(unopened.start(), /closed/u);
});

test('graceful close waits for an active JSON tool call', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const host = new LocalMcpHost({
    memory: (request) => handleMcpHttpRequest({
      request,
      createServer() {
        const server = new McpServer({ name: 'slow-local-mcp', version: '1.0.0' });
        server.registerTool('slow', {}, async () => {
          entered();
          await blocked;
          return { content: [{ type: 'text', text: 'done' }] };
        });
        return server;
      },
    }),
  });
  t.onTestFinished(async () => {
    release();
    await host.close(true).catch(() => undefined);
  });
  const client = new Client({ name: 'slow-local-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL((await host.start()).memory),
  ) as unknown as Parameters<Client['connect']>[0]);
  const call = client.callTool({ name: 'slow', arguments: {} });
  await started;
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  const result = await call as { content?: Array<{ type?: unknown }> };
  assert.equal(result.content?.[0]?.type, 'text');
  await closing;
  await client.close().catch(() => undefined);
});

test('forced close upgrades an active graceful close without waiting for its handler', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const host = new LocalMcpHost({
    memory: async () => {
      entered();
      await blocked;
      return Response.json({ late: true });
    },
  });
  const request = fetch((await host.start()).memory, { method: 'POST', body: '{}' });
  await started;
  const graceful = host.close();
  const forced = host.close(true);
  assert.equal(graceful, forced);
  await forced;
  release();
  await assert.rejects(request);
});
