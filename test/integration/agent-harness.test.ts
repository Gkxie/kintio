import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import type {
  AgentInput,
  AgentSubmission,
} from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

test('the harness accepts delivery attempts from any Agent through the channel MCP', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-harness-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
  });
  const store = persistence.core;
  const processor = new ConversationProcessor({
    store,
    agent: {
      async ensureThread(_conversationId, threadId) {
        return threadId || 'thread-agent-neutral';
      },
      activePrimary() { return undefined; },
      async submit(input: AgentInput): Promise<AgentSubmission> {
        assert.equal(input.channel, 'wechat_kf');
        const attempt = store.reserveAgentSend({
          sessionToken: input.toolSessionToken,
          sentType: 'text',
          payload: { msgtype: 'text', text: { content: 'agent-neutral' } },
        });
        store.completeSend(attempt.attemptId, {
          providerMessageId: 'wx-neutral',
        });
        return {
          kind: 'started',
          primaryMessageKey: input.message.messageKey,
          turnId: 'agent-turn',
          threadId: input.threadId,
          completion: Promise.resolve({
            executedAttemptIds: [attempt.attemptId],
          }),
        };
      },
      async close() {},
      async abort() {},
    },
    mediaGateway: { async resolveForCodex() { return []; } },
    channel: {
      async kick(): Promise<never> {
        throw new Error('Harness must not send an MCP execution twice');
      },
    },
    allowedUserIds: ['wm-one'],
    logger: { info() {}, error() {} },
  });
  t.onTestFinished(async () => {
    await processor.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const page = store.ingestSyncPage({
    accountKey: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [normalizeWecomMessage({
      msgid: 'customer-one',
      open_kfid: 'wk-one',
      external_userid: 'wm-one',
      origin: 3,
      msgtype: 'text',
      text: { content: '测试 Harness' },
    }, 'wk-one')],
  });
  const messageKey = page.insertedMessageKeys[0];
  if (!messageKey) throw new Error('Missing inbound fixture');
  await processor.enqueue(messageKey);
  await processor.waitForIdle();

  assert.equal(store.getInbound(messageKey)?.status, 'completed');
  assert.deepEqual(store.listMessageAttempts(messageKey).map((attempt) => ({
    source: attempt.source,
    status: attempt.status,
    providerMessageId: attempt.providerMessageId,
  })), [{
    source: 'mcp_tool',
    status: 'accepted',
    providerMessageId: 'wx-neutral',
  }]);
});
