import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'vitest';
import type { TestContext } from 'vitest';

import type {
  AgentInput,
  HistoryInspection,
} from '../../src/agent/runtime.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { stableMessageKey, type CoreState } from '../../src/state/sqlite-store.ts';
import {
  SimulatedToolAgent,
  type SimulatedAgentCompletion,
  type SimulatedAgentRuntime,
  type SimulatedAgentSubmission,
} from '../support/executing-agent.ts';
import { withTestDatabase } from '../support/temp-sqlite.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

class RecoveryAgent implements SimulatedAgentRuntime {
  readonly inputs: AgentInput[] = [];
  noAction = false;
  replacementThreadId = '';
  pendingMemoryThreadId = '';
  inspection: HistoryInspection = {
    state: 'missing', turnId: '', foundClientInputIds: new Set(), artifacts: [],
  };

  async ensureThread(_conversationId: string, threadId: string): Promise<string> {
    return this.replacementThreadId || threadId || 'thread-recovery';
  }

  takePendingMemoryThread(): string {
    const threadId = this.pendingMemoryThreadId;
    this.pendingMemoryThreadId = '';
    return threadId;
  }

  activePrimary(): undefined { return undefined; }

  async inspectHistory(): Promise<HistoryInspection> { return this.inspection; }

  async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
    this.inputs.push(input);
    const completion: SimulatedAgentCompletion = this.noAction
      ? { decision: 'no_action' }
      : { replies: [{ type: 'text', content: '恢复后的最终回答' }] };
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: 'recovery-turn',
      threadId: input.threadId,
      completion: Promise.resolve(completion),
    };
  }

  async close() {}
  async abort() {}
}

async function harness(t: TestContext, sendMode: 'accepted' | 'uncertain' = 'accepted') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-reconcile-'));
  const databaseFile = path.join(directory, 'state.sqlite');
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  const rawAgent = new RecoveryAgent();
  const sends: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const channel = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage(input) {
        sends.push(structuredClone(input.payload));
        return sendMode === 'accepted' ? { msgid: `wx-${sends.length}` } : {};
      },
    },
    mediaGateway: {
      async upload() { return { media_id: 'unused' }; },
      async cloneForSend() { throw new Error('not expected'); },
      async getCardThumbnailMediaId() { throw new Error('not expected'); },
    },
    observeMs: 0,
    logger: { info() {}, error(message) { errors.push(message); } },
  });
  const processor = new ConversationProcessor({
    store,
    agent: new SimulatedToolAgent({ inner: rawAgent, tools: channel }),
    mediaGateway: { async resolveForCodex() { return []; } },
    channel,
    allowedUserIds: ['wm-recovery'],
    logger: { info() {}, error() {} },
  });
  t.onTestFinished(async () => {
    await processor.close();
    await channel.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { databaseFile, store, rawAgent, channel, processor, sends, errors };
}

function seed(
  store: CoreState,
  id: string,
  status: 'processing' | 'preparing' = 'preparing',
): string {
  const page = store.ingestSyncPage({
    accountKey: 'wk-recovery',
    nextCursor: `cursor-${id}`,
    messages: [testWecomMessage({
      id,
      openKfId: 'wk-recovery',
      externalUserId: 'wm-recovery',
      text: '原始问题',
    })],
  });
  const messageKey = page.insertedMessageKeys[0] ||
    stableMessageKey('wechat_kf', 'wk-recovery', id);
  store.claimInbound({ messageKey });
  if (status === 'preparing') store.markInboundPreparing(messageKey, 'old-turn');
  store.setConversationThread({
    channel: 'wechat_kf',
    accountKey: 'wk-recovery',
    peerId: 'wm-recovery',
    threadId: `thread-${id}`,
  });
  return messageKey;
}

test('processing input absent from history runs one Agent continuation and one MCP send', async (t) => {
  const active = await harness(t);
  const messageKey = seed(active.store, 'missing-history', 'processing');
  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();
  assert.equal(active.rawAgent.inputs.length, 1);
  assert.equal(active.rawAgent.inputs[0]?.clientInputId, `${messageKey}-recovery`);
  assert.deepEqual(active.sends, [{
    msgtype: 'text', text: { content: '恢复后的最终回答' },
  }]);
  assert.equal(active.store.getInbound(messageKey)?.status, 'completed');
});

test('unlinked startup messages stay independent even across one conversation', async (t) => {
  const active = await harness(t);
  const primary = seed(active.store, 'day-one-primary', 'processing');
  const page = active.store.ingestSyncPage({
    accountKey: 'wk-recovery',
    expectedCursor: active.store.getCursor('wk-recovery'),
    nextCursor: 'later-page',
    messages: [
      testWecomMessage({
        id: 'day-two-one', openKfId: 'wk-recovery',
        externalUserId: 'wm-recovery', text: '独立问题一',
      }),
      testWecomMessage({
        id: 'day-two-two', openKfId: 'wk-recovery',
        externalUserId: 'wm-recovery', text: '独立问题二',
      }),
      testWecomMessage({
        id: 'day-two-three', openKfId: 'wk-recovery',
        externalUserId: 'wm-recovery', text: '独立问题三',
      }),
    ],
  });
  const later = page.insertedMessageKeys;

  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();

  assert.equal(active.rawAgent.inputs.length, 4);
  assert.equal(active.sends.length, 4);
  assert.deepEqual({
    errors: active.errors,
    messages: [primary, ...later].map((messageKey) => ({
    status: active.store.getInbound(messageKey)?.status,
    error: active.store.getInbound(messageKey)?.errorMessage,
    primary: active.store.getInbound(messageKey)?.primaryMessageKey,
    attempts: active.store.listMessageAttempts(messageKey).length,
    })),
  }, {
    errors: [],
    messages: Array.from({ length: 4 }, () => ({
      status: 'completed', error: '', primary: '', attempts: 1,
    })),
  });
});

test('damaged recovery payload is quarantined without blocking later input', async (t) => {
  const active = await harness(t);
  const damaged = seed(active.store, 'damaged-primary', 'processing');
  withTestDatabase(active.databaseFile, (database) => {
    database.prepare(`
      UPDATE inbound_messages
      SET payload_json = json_set(payload_json, '$.conversation.channel', 'weixin_ilink')
      WHERE message_key = ?
    `).run(damaged);
  });
  const later = active.store.ingestSyncPage({
    accountKey: 'wk-recovery',
    expectedCursor: active.store.getCursor('wk-recovery'),
    nextCursor: 'after-damaged',
    messages: [testWecomMessage({
      id: 'after-damaged',
      openKfId: 'wk-recovery',
      externalUserId: 'wm-recovery',
      text: '继续处理正常消息',
    })],
  }).insertedMessageKeys[0]!;

  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();

  assert.equal(active.store.getInbound(damaged)?.status, 'suppressed');
  assert.equal(active.store.getInbound(later)?.status, 'completed');
  assert.equal(active.rawAgent.inputs.length, 1);
  assert.equal(active.sends.length, 1);
});

test('archived recovery exposes old ID to the new turn and clears it after completion', async (t) => {
  const active = await harness(t);
  const messageKey = seed(active.store, 'archived-memory', 'processing');
  const archived = '01900000-0000-7000-8000-000000000001';
  const replacement = '01900000-0000-7000-8000-000000000002';
  active.store.setConversationThread({
    channel: 'wechat_kf',
    accountKey: 'wk-recovery',
    peerId: 'wm-recovery',
    threadId: archived,
  });
  active.rawAgent.replacementThreadId = replacement;
  active.rawAgent.pendingMemoryThreadId = archived;

  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();

  assert.equal(active.rawAgent.inputs[0]?.threadId, replacement);
  assert.equal(active.rawAgent.inputs[0]?.archivedThreadId, archived);
  assert.equal(
    active.store.getConversation(
      'wechat_kf', 'wk-recovery', 'wm-recovery',
    )?.threadId,
    replacement,
  );
  assert.equal(
    active.store.getConversation(
      'wechat_kf', 'wk-recovery', 'wm-recovery',
    )?.memoryThreadId,
    '',
  );
  assert.equal(active.store.getInbound(messageKey)?.status, 'completed');
});

test('deleted thread recovery starts clean without advertising unavailable memory', async (t) => {
  const active = await harness(t);
  seed(active.store, 'deleted-thread', 'processing');
  active.rawAgent.replacementThreadId = '01900000-0000-7000-8000-000000000003';

  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();

  assert.equal(active.rawAgent.inputs[0]?.archivedThreadId, undefined);
  assert.equal(
    active.store.getConversation(
      'wechat_kf', 'wk-recovery', 'wm-recovery',
    )?.memoryThreadId,
    '',
  );
});

test('durable terminal MCP attempt finalizes recovery without replaying Agent input', async (t) => {
  const active = await harness(t);
  const messageKey = seed(active.store, 'durable-attempt');
  const session = active.store.createAgentSession({ messageKey });
  const first = await active.channel.execute('send_text', {
    session: session.token,
    content: '已经执行一',
  });
  const second = await active.channel.execute('send_text', {
    session: session.token,
    content: '已经执行二',
  });
  active.store.closeAgentSession(session.token);
  active.rawAgent.inspection = {
    state: 'completed',
    turnId: 'old-turn',
    foundClientInputIds: new Set([messageKey]),
    artifacts: [],
    executedAttemptIds: [first.attemptId, second.attemptId],
  };
  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();
  assert.equal(active.rawAgent.inputs.length, 0);
  assert.equal(active.store.getInbound(messageKey)?.status, 'completed');
  assert.deepEqual(active.store.listMessageAttempts(messageKey).map((attempt) =>
    attempt.attemptId), [first.attemptId, second.attemptId]);
});

test('failed primary is reclaimed before completed-history finalization on startup', async (t) => {
  const active = await harness(t);
  const messageKey = seed(active.store, 'failed-finalization');
  const session = active.store.createAgentSession({ messageKey });
  const receipt = await active.channel.execute('send_text', {
    session: session.token,
    content: '已经执行',
  });
  active.store.closeAgentSession(session.token);
  active.store.failInbound(messageKey, new Error('finalization interrupted'));
  active.rawAgent.inspection = {
    state: 'completed',
    turnId: 'old-turn',
    foundClientInputIds: new Set([messageKey]),
    artifacts: [],
    executedAttemptIds: [receipt.attemptId],
  };

  await active.processor.recover(active.store.recoverStartup().inbound);
  await active.processor.waitForIdle();

  assert.equal(active.rawAgent.inputs.length, 0);
  assert.equal(active.store.getInbound(messageKey)?.status, 'completed');
  assert.equal(active.store.listMessageAttempts(messageKey).length, 1);
});

describe.each(['accepted', 'uncertain'] as const)('%s recovery receipt', (status) => {
  test('recovery may auditably choose no additional send after accepted or uncertain', async (t) => {
      const active = await harness(t, status);
      const messageKey = seed(active.store, `no-action-${status}`);
      const session = active.store.createAgentSession({ messageKey });
      const receipt = await active.channel.execute('send_text', {
        session: session.token,
        content: '已经尝试发送',
      });
      assert.equal(receipt.status, status);
      active.store.closeAgentSession(session.token);
      active.store.failInbound(messageKey, new Error('turn ended before completion'));
      active.rawAgent.noAction = true;

      await active.processor.recover(active.store.recoverStartup().inbound);
      await active.processor.waitForIdle();

      assert.equal(active.rawAgent.inputs.length, 1);
      assert.equal(active.rawAgent.inputs[0]?.allowNoAction, true);
      assert.equal(active.sends.length, 1);
      assert.equal(active.store.getInbound(messageKey)?.status, 'completed');
    assert.equal(active.store.listMessageAttempts(messageKey).length, 1);
  });
});
