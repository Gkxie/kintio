import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createStagingMcpServer,
} from '../../src/mcp/staging-server.ts';
import { prepareSendBatch } from '../../src/domain/send-contract.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createHarness(t: TestContext): Promise<Client> {
  const server = createStagingMcpServer();
  const client = new Client({ name: 'staging-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(() => client.close());
  return client;
}

test('[O02][SEC05] exposes only five content tools without recipient or credential fields', async (t) => {
  const client = await createHarness(t);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      'send_image',
      'send_link',
      'send_location',
      'send_miniprogram',
      'send_text',
    ],
  );

  const serialized = JSON.stringify(listed.tools);
  for (const forbidden of [
    'toUser',
    'externalUserId',
    'openKfId',
    'corpId',
    'secret',
    'mediaId',
    'filePath',
    'database',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('[S02] returns a fixed staged candidate without performing delivery', async (t) => {
  const client = await createHarness(t);
  const result = await client.callTool({
    name: 'send_location',
    arguments: {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });

  assert.equal(result.isError, undefined);
  const structured = result.structuredContent;
  assert.ok(isRecord(structured));
  assert.deepEqual(structured, {
    staged: true,
    candidate: {
      type: 'location',
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });
  assert.deepEqual(Object.keys(structured).sort(), [
    'candidate',
    'staged',
  ]);
});

test('[S06] staging calls do not consume the host final five-message budget', async (t) => {
  const client = await createHarness(t);
  for (let index = 0; index < 10; index += 1) {
    const result = await client.callTool({
      name: 'send_text',
      arguments: { content: `草稿${index}` },
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent;
    assert.ok(isRecord(structured));
    assert.equal(structured.staged, true);
    assert.ok(isRecord(structured.candidate));
    assert.equal(structured.candidate.content, `草稿${index}`);
  }
});

test('[O06][SEC05] image staging validates syntax and host enforces ownership', async (t) => {
  const client = await createHarness(t);
  const accepted = await client.callTool({
    name: 'send_image',
    arguments: { mediaRef: 'media:0' },
  });
  assert.ok(isRecord(accepted.structuredContent));
  assert.deepEqual(accepted.structuredContent, {
    staged: true,
    candidate: { type: 'image', mediaRef: 'media:0' },
  });

  const second = await client.callTool({
    name: 'send_image',
    arguments: { mediaRef: 'media:1' },
  });
  assert.equal(second.isError, undefined);
  assert.throws(
    () => prepareSendBatch(
      [{ type: 'image', mediaRef: 'media:1' }],
      { mediaCatalog: [{ ref: 'media:0', kind: 'image' }] },
    ),
    /not available/u,
  );

  const rejected = await client.callTool({
    name: 'send_image',
    arguments: { mediaRef: 'not-media' },
  });
  assert.equal(rejected.isError, true);
  assert.ok(Array.isArray(rejected.content));
  const firstContent = rejected.content[0];
  assert.ok(isRecord(firstContent));
  assert.equal(firstContent.type, 'text');
  const errorText = firstContent.text;
  if (typeof errorText !== 'string') assert.fail('tool error content must be text');
  assert.match(errorText, /media|pattern/u);
});
