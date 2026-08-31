import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, test, type TestContext } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import {
  ConversationMemoryExecutor,
  createConversationMemoryMcpServer,
} from '../../src/mcp/conversation-memory-server.ts';
import {
  type AgentSessionRecord,
} from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

async function harness(t: TestContext, memoryThreadId = '01900000-0000-7000-8000-000000000001') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-memory-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
  });
  const store = persistence.core;
  const page = store.ingestSyncPage({
    openKfId: 'wk-memory',
    nextCursor: 'memory-one',
    messages: [normalizeWecomMessage({
      msgid: 'memory-message',
      open_kfid: 'wk-memory',
      external_userid: 'wm-memory',
      origin: 3,
      msgtype: 'text',
      text: { content: '当前问题' },
    }, 'wk-memory')],
  });
  const messageKey = page.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey });
  store.setConversationThread({
    openKfId: 'wk-memory',
    externalUserId: 'wm-memory',
    threadId: '01900000-0000-7000-8000-000000000002',
    memoryThreadId,
  });
  const session = store.createAgentSession({ messageKey });
  const reads: string[] = [];
  const executor = new ConversationMemoryExecutor({
    store,
    threads: {
      async readThread(threadId) {
        reads.push(threadId);
        return {
          thread: {
            turns: [{
              items: [
                {
                  type: 'userMessage',
                  content: [
                    {
                      type: 'text',
                      text: `<wechat_tool_session>ws_${'x'.repeat(32)}</wechat_tool_session>\n<conversation_context>之前问过北京天气</conversation_context>`,
                    },
                    { type: 'localImage', path: '/root/private/input.png' },
                  ],
                },
                {
                  type: 'agentMessage',
                  text: '未通过渠道发送的内部文字',
                },
                {
                  type: 'mcpToolCall',
                  server: 'wechat_kf',
                  tool: 'send_text',
                  status: 'completed',
                  arguments: {
                    session: `ws_${'y'.repeat(32)}`,
                    content: '北京今天晴朗',
                  },
                  result: { structuredContent: { status: 'accepted' } },
                },
                {
                  type: 'commandExecution',
                  command: 'read secret',
                  cwd: '/www/private',
                },
              ],
            }],
          },
        };
      },
    },
  });
  const server = createConversationMemoryMcpServer(executor);
  const client = new Client({ name: 'memory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.onTestFinished(async () => {
    await client.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { client, executor, reads, session };
}

describe('archived channel delivery facts', () => {
  it('keeps iLink accepted, failed, and uncertain facts without mixing WeChat tools', async () => {
    const sessionToken = `ws_${'i'.repeat(32)}`;
    const session: AgentSessionRecord = {
      token: sessionToken,
      messageKey: 'im_ilink_memory',
      openKfId: 'ia_ilink_memory',
      externalUserId: 'peer-ilink-memory',
      channel: 'weixin_ilink',
      replyWindowId: 17,
      boundaryInboxSeq: 1,
      memoryThreadId: '01900000-0000-7000-8000-000000000017',
      mediaCatalog: [],
      expiresAt: Date.now() + 60_000,
      closedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const executor = new ConversationMemoryExecutor({
      store: {
        getAgentSession(token) {
          assert.equal(token, sessionToken);
          return session;
        },
      },
      threads: {
        async readThread() {
          return {
            thread: {
              turns: [{
                items: [
                  {
                    type: 'userMessage',
                    content: [{
                      type: 'text',
                      text: '<conversation_context>之前通过 iLink 对话</conversation_context>',
                    }],
                  },
                  {
                    type: 'mcpToolCall',
                    server: 'weixin_ilink',
                    tool: 'send_text',
                    status: 'completed',
                    arguments: { session: sessionToken, content: 'iLink 已发送文本' },
                    result: { structuredContent: { status: 'accepted' } },
                  },
                  {
                    type: 'mcpToolCall',
                    server: 'weixin_ilink',
                    tool: 'send_text',
                    status: 'failed',
                    arguments: { session: sessionToken, content: 'iLink 发送失败文本' },
                    result: {
                      structuredContent: {
                        status: 'failed',
                        error: { kind: 'reply_quota_exhausted' },
                      },
                    },
                  },
                  {
                    type: 'mcpToolCall',
                    server: 'weixin_ilink',
                    tool: 'send_image',
                    status: 'completed',
                    arguments: { session: sessionToken, mediaRef: 'artifact:0' },
                    result: { structuredContent: { status: 'uncertain' } },
                  },
                  {
                    type: 'mcpToolCall',
                    server: 'wechat_kf',
                    tool: 'send_text',
                    status: 'completed',
                    arguments: { session: sessionToken, content: '不得混入的微信客服回复' },
                    result: { structuredContent: { status: 'accepted' } },
                  },
                ],
              }],
            },
          };
        },
      },
    });

    const result = await executor.read(sessionToken);
    assert.match(result.memory, /之前通过 iLink 对话/u);
    assert.match(result.memory, /iLink API accepted.*iLink 已发送文本/su);
    assert.match(result.memory, /iLink API delivery failed.*iLink 发送失败文本/su);
    assert.match(result.memory, /iLink API result uncertain.*\[image\]/su);
    assert.doesNotMatch(result.memory, /不得混入的微信客服回复/u);
  });
});

test('memory MCP binds one archived thread and returns sanitized channel history', async (t) => {
  const created = await harness(t);
  const tools = await created.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['read_archived_thread']);
  const schema = JSON.stringify(tools.tools[0]?.inputSchema);
  assert.match(schema, /session/u);
  assert.doesNotMatch(schema, /threadId|thread_id/iu);

  const result = await created.client.callTool({
    name: 'read_archived_thread',
    arguments: { session: created.session.token },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const memory = String((result.structuredContent as { memory?: unknown })?.memory || '');
  assert.match(memory, /之前问过北京天气/u);
  assert.match(memory, /北京今天晴朗/u);
  assert.match(memory, /historical message included an image/u);
  assert.doesNotMatch(memory, /ws_[A-Za-z0-9_-]{32}|\/root\/|\/www\/|内部文字|read secret/u);
  assert.deepEqual(created.reads, ['01900000-0000-7000-8000-000000000001']);
});

test('memory MCP rejects an unbound session without reading any thread', async (t) => {
  const created = await harness(t, '');
  const result = await created.client.callTool({
    name: 'read_archived_thread',
    arguments: { session: created.session.token },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /archived_memory_unavailable/u);
  assert.deepEqual(created.reads, []);
});

test('memory MCP does not expose unexpected thread reader errors', async (t) => {
  const server = createConversationMemoryMcpServer({
    async read() {
      throw new Error('token=secret-value path=/root/private-thread');
    },
  });
  const client = new Client({ name: 'memory-error-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.onTestFinished(() => client.close());

  const result = await client.callTool({
    name: 'read_archived_thread',
    arguments: { session: `ws_${'e'.repeat(32)}` },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: 'failed',
    error: {
      kind: 'archived_memory_error',
      message: 'Archived conversation memory is unavailable.',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private-thread|\/root/u);
});
