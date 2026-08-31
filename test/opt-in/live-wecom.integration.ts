import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { CodexAgent, createCodexAppServer } from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { createWechatKfMcpServer } from '../../src/mcp/wechat-kf-server.ts';
import {
  ConversationMemoryExecutor,
  createConversationMemoryMcpServer,
} from '../../src/mcp/conversation-memory-server.ts';
import { McpIpcHost } from '../../src/mcp/ipc-host.ts';
import { WecomMediaGateway } from '../../src/services/media-gateway.ts';
import { WecomApiClient } from '../../src/services/wecom-api.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';

const targetOpenKfId = process.env.LIVE_WECOM_OPEN_KFID || '';
const targetUserId = process.env.LIVE_WECOM_EXTERNAL_USER_ID || '';
const allowedTargets = new Set(
  String(process.env.LIVE_WECOM_ALLOWLIST || '').split(',').map((item) => item.trim()),
);
if (
  process.env.LIVE_WECOM_ACK !== 'SEND_REAL_MESSAGE' ||
  process.env.LIVE_SCENARIO !== 'text' ||
  !targetOpenKfId ||
  !targetUserId ||
  !allowedTargets.has(targetUserId)
) {
  throw new Error(
    'Live test requires explicit open_kfid, external_userid, allowlist, LIVE_SCENARIO=text, and LIVE_WECOM_ACK=SEND_REAL_MESSAGE',
  );
}

test('mock upstream sends one accepted text through real Codex and real WeChat', { timeout: 180_000 }, async (t) => {
  process.stdout.write(
    'LIVE target configured estimated=1/5 types=text\n',
  );
  const config = loadConfig();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-live-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  const apiClient = new WecomApiClient({
    corpId: config.wecom.api.corpId,
    kfSecret: config.wecom.api.kfSecret,
    timeoutMs: config.wecom.api.timeoutMs,
  });
  const mediaGateway = new WecomMediaGateway({ apiClient });
  const channel = new WechatKfToolExecutor({
    store,
    apiClient,
    mediaGateway,
    observeMs: config.wecom.api.observeMs,
  });
  let memoryExecutor: ConversationMemoryExecutor | undefined;
  const mcpHost = new McpIpcHost({
    instanceKey: path.join(directory, 'runtime.lock'),
    stateDirectory: directory,
    relayFile: path.resolve('mcp-relay.ts'),
    wechatKf: () => createWechatKfMcpServer(channel),
    memory: () => createConversationMemoryMcpServer({
      read(session) {
        if (!memoryExecutor) throw new Error('memory executor is not ready');
        return memoryExecutor.read(session);
      },
    }),
  });
  const codex = createCodexAppServer({ mcpLaunches: await mcpHost.start() });
  memoryExecutor = new ConversationMemoryExecutor({ store, threads: codex });
  const agent = new CodexAgent({
    codex,
    config: config.codex,
  });
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway,
    channel,
    allowedUserIds: [targetUserId],
    authorization: config.wecom.authorization,
  });
  const sourceMessageId = `live-${Date.now()}`;
  let syncCalls = 0;
  const sync = new WecomSync({
    store,
    processor,
    apiClient: {
      async syncMessages(input) {
        syncCalls += 1;
        assert.deepEqual(input, {
          cursor: '', callbackToken: 'mock-listener-token', openKfId: targetOpenKfId,
        });
        return {
          next_cursor: 'mock-complete',
          has_more: 0,
          msg_list: [{
            msgid: sourceMessageId,
            open_kfid: targetOpenKfId,
            external_userid: targetUserId,
            origin: 3,
            msgtype: 'text',
            text: { content: '请只使用一条 send_text 简短回复：全链路测试成功。' },
          }],
        };
      },
    },
  });
  t.onTestFinished(async () => {
    let deletionError: unknown;
    try {
      await sync.close();
      await processor.waitForIdle();
      await channel.waitForIdle();
      const threadId = store.getConversation(targetOpenKfId, targetUserId)?.threadId;
      if (threadId) {
        if (!codex.deleteThread) throw new Error('Codex thread deletion is unavailable');
        await codex.deleteThread(threadId);
      }
    } catch (error: unknown) {
      deletionError = error;
    } finally {
      await processor.close();
      await channel.close();
      await mcpHost.close();
      store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    if (deletionError) throw deletionError;
  });

  await sync.enqueue({
    callbackToken: 'mock-listener-token',
    openKfId: targetOpenKfId,
  });
  await processor.waitForIdle();
  await channel.waitForIdle();
  const messageKey = stableMessageKey(targetOpenKfId, sourceMessageId);
  const attempts = inspectAttempts(store.database, messageKey);
  assert.equal(syncCalls, 1);
  assert.equal(attempts.length, 1, 'live test refuses split or fallback sends');
  assert.equal(attempts[0]?.type, 'text');
  const exactText = attempts[0]?.payload?.text as
    | { content?: unknown }
    | undefined;
  assert.ok(
    typeof exactText?.content === 'string' &&
      Buffer.byteLength(exactText.content, 'utf8') <= 2048,
  );
  const attempt = attempts[0];
  assert.ok(attempt);
  assert.equal(attempt.status, 'accepted');
  process.stdout.write(
    `LIVE actual=${attempts.length}/5 status=accepted (not proof of client display)\n`,
  );
});
