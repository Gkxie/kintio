import assert from 'node:assert/strict';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'vitest';

import { createConfig } from '../../src/config.ts';
import {
  findMcpDescriptorFile,
  operatorMcpInstanceKey,
} from '../../src/mcp/ipc-protocol.ts';
import { createRuntime } from '../../src/runtime.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

test('iLink enrollment stays available when the Codex adapter is disabled', async (t) => {
  const temp = await createTempSqlite(t, { prefix: 'ilink-login-no-agent-' });
  const config = createConfig({
    ILINK_ENABLED: 'true',
    ILINK_STORAGE_KEY: Buffer.alloc(32, 45).toString('base64url'),
    KINTIO_DB_FILE: temp.filePath,
    CODEX_ENABLED: 'false',
    CODEX_WORKING_DIRECTORY: path.join(temp.directory, 'agent-workspace'),
  }, temp.directory);
  const logs: string[] = [];
  const runtime = await createRuntime({
    config,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  t.onTestFinished(() => runtime.abort());
  await runtime.start();
  assert.equal(runtime.messageProcessor, null);
  assert.match(logs.join('\n'), /enrollment remains available/u);
  assert.throws(() => findMcpDescriptorFile(
    path.dirname(config.state.lockFile),
    config.state.lockFile,
  ), /not running/u);
  const descriptor = findMcpDescriptorFile(
    path.dirname(config.state.lockFile),
    operatorMcpInstanceKey(config.state.lockFile),
  );
  const client = new Client({ name: 'no-agent-login-test', version: '1.0.0' });
  t.onTestFinished(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve('mcp-relay.ts'),
      '--descriptor', descriptor,
      '--route', 'operator',
    ],
    stderr: 'pipe',
  }));
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    [
      'begin_login',
      'login_status',
      'cancel_login',
      'list_accounts',
      'start_account',
      'stop_account',
      'delete_account',
    ],
  );
  await client.close();
  await runtime.close();
});
