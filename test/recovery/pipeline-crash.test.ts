import assert from 'node:assert/strict';
import type { Serializable } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'vitest';
import { fileURLToPath } from 'node:url';

import type {
  AgentInput,
  HistoryInspection,
} from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import type { NormalizedMessage } from '../../src/types.ts';
import { startTestChild, type TestChild } from '../support/child-process.ts';
import {
  SimulatedToolAgent,
  type SimulatedAgentCompletion,
  type SimulatedAgentRuntime,
  type SimulatedAgentSubmission,
} from '../support/executing-agent.ts';
import { inspectAttempt, inspectAttempts } from '../support/sqlite-inspect.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const currentFile = fileURLToPath(import.meta.url);
const mode = process.argv[2] || '';

interface SeedMessage extends Record<string, Serializable> {
  type: 'seeded';
  scenario: string;
  keys: string[];
  attempts: string[];
}

function normalized(
  id: string,
  openKfId = 'wk-crash',
  externalUserId = 'wm-crash',
): NormalizedMessage {
  return testWecomMessage({
    id,
    openKfId,
    externalUserId,
  });
}

function ingest(
  store: SqliteStore,
  message: NormalizedMessage,
): string {
  const openKfId = message.conversation.accountKey;
  const [key] = store.ingestSyncPage({
    openKfId,
    expectedCursor: store.getCursor(openKfId),
    nextCursor: `${store.getCursor(openKfId)}-${message.id}`,
    messages: [message],
  }).insertedMessageKeys;
  if (!key) throw new Error('Expected inserted message key');
  return key;
}

function reserve(
  store: SqliteStore,
  key: string,
  contents: readonly string[],
): string[] {
  store.claimInbound({ messageKey: key });
  return seedPendingAttempts(store, key, contents.map((content, sendIndex) => ({
      sendIndex,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content } },
    }))).map((attempt) => attempt.attemptId);
}

function sendParent(message: SeedMessage): void {
  if (!process.send) throw new Error('Crash worker requires IPC');
  process.send(message);
}

async function seedWorker(databaseFile: string, scenario: string): Promise<void> {
  const store = new SqliteStore({ filePath: databaseFile });
  const keys: string[] = [];
  const attempts: string[] = [];
  if (scenario === 'codex') {
    const processing = ingest(store, normalized('processing'));
    const preparing = ingest(store, normalized('preparing', 'wk-crash', 'wm-crash-two'));
    store.claimInbound({ messageKey: processing });
    store.claimInbound({ messageKey: preparing });
    store.markInboundPreparing(preparing, 'crashed-turn');
    keys.push(processing, preparing);
  } else if (scenario === 'isolation') {
    for (const openKfId of ['wk-a', 'wk-b']) {
      const key = ingest(store, normalized('same-msgid', openKfId, 'wm-same'));
      keys.push(key);
      attempts.push(...reserve(store, key, [openKfId]));
    }
  } else {
    const key = ingest(store, normalized(`message-${scenario}`));
    keys.push(key);
    const ids = reserve(store, key, scenario === 'partial' ? ['first', 'second'] : ['only']);
    attempts.push(...ids);
    if (scenario === 'sending') {
      store.beginNextSend();
    } else if (scenario === 'accepted') {
      const attempt = store.beginNextSend();
      if (!attempt) throw new Error('Expected accepted attempt');
      store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-accepted' });
    } else if (scenario === 'partial') {
      const attempt = store.beginNextSend();
      if (!attempt) throw new Error('Expected partial attempt');
      store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-first' });
    }
  }
  sendParent({ type: 'seeded', scenario, keys, attempts });
  process.on('message', () => store.close());
}

if (mode === '--seed') {
  await seedWorker(process.argv[3] || '', process.argv[4] || '');
} else {
  async function workspace(t: TestContext): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-crash-'));
    t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
  }

  function isSeeded(message: Serializable): message is SeedMessage {
    return typeof message === 'object' && message !== null &&
      'type' in message && message.type === 'seeded';
  }

  async function crashSeed(
    t: TestContext,
    databaseFile: string,
    scenario: string,
  ): Promise<SeedMessage> {
    const child: TestChild = startTestChild(t, currentFile, {
      args: ['--seed', databaseFile, scenario],
    });
    const seeded = await child.waitForMessage(isSeeded);
    assert.deepEqual(await child.stop('SIGKILL'), {
      code: null,
      signal: 'SIGKILL',
    });
    return seeded;
  }

  class RecoveryAgent implements SimulatedAgentRuntime {
    submissions = 0;
    async ensureThread(conversationId: string, threadId: string): Promise<string> {
      return threadId || `thread-recovery-${conversationId}`;
    }
    activePrimary(): undefined { return undefined; }
    async inspectHistory(): Promise<HistoryInspection> {
      return {
        state: 'missing', turnId: '', foundClientInputIds: new Set(), artifacts: [],
      };
    }
    async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
      this.submissions += 1;
      const completion: SimulatedAgentCompletion = {
        replies: [{ type: 'text', content: `recovered-${input.message.text}` }],
      };
      return {
        kind: 'started',
        primaryMessageKey: input.message.messageKey,
        turnId: `recovery-${this.submissions}`,
        threadId: input.threadId,
        completion: Promise.resolve(completion),
      };
    }
    async close(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  function channel(
    store: SqliteStore,
    sendPreparedMessage: (input: Parameters<
      import('../../src/services/wecom-api.ts').WecomApiClient['sendPreparedMessage']
    >[0]) => Promise<Record<string, unknown>>,
  ): WechatKfToolExecutor {
    return new WechatKfToolExecutor({
      store,
      apiClient: { sendPreparedMessage },
      mediaGateway: {
        async upload() { return { media_id: 'unused' }; },
        async cloneForSend() { throw new Error('not expected'); },
        async getCardThumbnailMediaId() { throw new Error('not expected'); },
      },
      observeMs: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
  }

  test('processing and preparing crash recover Codex once into one MCP attempt each', async (t) => {
    const root = await workspace(t);
    const database = path.join(root, 'state.sqlite');
    const seeded = await crashSeed(t, database, 'codex');
    const store = new SqliteStore({ filePath: database });
    const agent = new RecoveryAgent();
    const activeChannel = channel(store, async () => ({ msgid: 'wx-recovered' }));
    const processor = new ConversationProcessor({
      store,
      agent: new SimulatedToolAgent({ inner: agent, tools: activeChannel }),
      mediaGateway: { resolveForCodex: async () => [] },
      channel: activeChannel,
      allowedUserIds: ['wm-crash'],
      logger: { info() {}, warn() {}, error() {} },
    });
    await processor.recover(store.recoverStartup().inbound);
    await processor.waitForIdle();
    assert.equal(agent.submissions, 2);
    for (const key of seeded.keys) {
      assert.equal(inspectAttempts(store.database, key).length, 1);
    }
    await processor.recover(store.recoverStartup().inbound);
    await processor.waitForIdle();
    assert.equal(agent.submissions, 2, 'terminal attempts must not start Codex again');
    await processor.close();
    await activeChannel.close();
    store.close();
  });

  describe.each(['pending', 'sending', 'accepted', 'partial'] as const)(
    '%s crash boundary',
    (scenario) => {
      test('SIGKILL after persisted Agent/MCP boundary states preserves at-least-once input and at-most-once attempts', async (t) => {
        const root = await workspace(t);
        const database = path.join(root, 'state.sqlite');
        const seeded = await crashSeed(t, database, scenario);
        const store = new SqliteStore({ filePath: database });
        const recovery = store.recoverStartup();
        const calls: Array<{ content: string; messageId: string }> = [];
        const delivery = channel(store,
            async (input) => {
              const text = input.payload.text as { content?: unknown };
              calls.push({
                content: String(text.content || ''),
                messageId: String(input.messageId || ''),
              });
              return { msgid: `wx-${calls.length}` };
            });
        await delivery.kick();
        if (scenario === 'pending') assert.equal(calls.length, 1);
        if (scenario === 'sending') {
          assert.equal(recovery.uncertainSends, 1);
          assert.equal(calls.length, 0);
          assert.equal(
            inspectAttempt(store.database, seeded.attempts[0]!)?.status,
            'uncertain',
          );
        }
        if (scenario === 'accepted') assert.equal(calls.length, 0);
        if (scenario === 'partial') {
          assert.deepEqual(calls.map((call) => call.content), ['second']);
          assert.equal(
            inspectAttempt(store.database, seeded.attempts[0]!)?.status,
            'accepted',
          );
        }
        await delivery.close();
        store.close();
      });
    },
  );

  test('same raw msgid across open_kfid remains isolated through crash recovery', async (t) => {
    const root = await workspace(t);
    const database = path.join(root, 'state.sqlite');
    const seeded = await crashSeed(t, database, 'isolation');
    assert.notEqual(seeded.keys[0], seeded.keys[1]);
    const store = new SqliteStore({ filePath: database });
    store.recoverStartup();
    const calls: Array<{ openKfId: string; messageId: string }> = [];
    const delivery = channel(store,
        async (input) => {
          calls.push({
            openKfId: input.openKfId,
            messageId: String(input.messageId || ''),
          });
          return { msgid: `wx-${calls.length}` };
        });
    await delivery.kick();
    assert.deepEqual(calls.map((call) => call.openKfId).sort(), ['wk-a', 'wk-b']);
    assert.equal(new Set(calls.map((call) => call.messageId)).size, 2);
    await delivery.close();
    store.close();
  });
}
