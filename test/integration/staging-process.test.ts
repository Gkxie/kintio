import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('[S03][R04][SEC05] staging MCP stays connected across three tool calls', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      path.resolve('src/mcp/staging-server.ts'),
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'staging-process-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);

  for (let index = 1; index <= 3; index += 1) {
    const result = await client.callTool({
      name: 'send_text',
      arguments: { content: `candidate-${index}` },
    });
    assert.deepEqual(result.structuredContent, {
      staged: true,
      candidate: { type: 'text', content: `candidate-${index}` },
    });
  }
});
