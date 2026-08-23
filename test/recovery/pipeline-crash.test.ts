import assert from 'node:assert/strict';
import type { Serializable } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AgentCompletion,
  AgentInput,
  AgentSubmission,
  HistoryInspection,
} from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { DeliveryService } from '../../src/services/delivery-service.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import type { NormalizedMessage, PreparedAttempt } from '../../src/types.ts';
import { startTestChild, type TestChild } from '../support/child-process.ts';
import { inspectAttempt, inspectAttempts } from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const currentFile = fileURLToPath(import.meta.url);
const mode = process.argv[2] || '';
const typeStripExecArgv = ['--experimental-strip-types'] as const;

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
  const { openKfId } = message.conversation;
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
  const claimed = store.claimInbound({ messageKey: key }).message;
  return store.finalizeInboundBatch({
    messageKey: key,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: contents.map((content, sendIndex) => ({
      sendIndex,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content } },
    })),
  }).attempts.map((attempt) => attempt.attemptId);
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
    const preparing = ingest(store, normalized('preparing'));
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
  } else if (scenario === 'fallback') {
    const key = ingest(store, normalized('message-fallback'));
    keys.push(key);
    const claimed = store.claimInbound({ messageKey: key }).message;
    const finalized = store.finalizeInboundBatch({
      messageKey: key,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: [
        {
          sendIndex: 0,
          sentType: 'location',
          payload: {
            msgtype: 'location',
            location: {
              name: '地点', address: '地址', latitude: 39, longitude: 116,
            },
          },
        },
        {
          sendIndex: 1,
          sentType: 'text',
          payload: { msgtype: 'text', text: { content: '安全兜底' } },
          fallbackForIndex: 0,
          status: 'blocked',
        },
      ],
    });
    attempts.push(...finalized.attempts.map((attempt) => attempt.attemptId));
    const primary = store.beginNextSend();
    if (!primary) throw new Error('Expected fallback primary attempt');
    store.failSend(primary.attemptId, new Error('definitive failure'));
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
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
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
      execArgv: typeStripExecArgv,
    });
    const seeded = await child.waitForMessage(isSeeded);
    assert.deepEqual(await child.stop('SIGKILL'), {
      code: null,
      signal: 'SIGKILL',
    });
    return seeded;
  }

  class RecoveryAgent {
    submissions = 0;
    readonly #store: SqliteStore;
    constructor(store: SqliteStore) { this.#store = store; }
    async inspectHistory(): Promise<HistoryInspection> {
      return {
        state: 'missing', turnId: '', foundClientInputIds: new Set(), candidates: [],
      };
    }
    async submit(input: AgentInput): Promise<AgentSubmission> {
      this.submissions += 1;
      const claimed = this.#store.claimInbound({
        messageKey: input.message.messageKey,
        clientInputId: input.clientInputId || input.message.messageKey,
      });
      const completion: AgentCompletion = {
        candidates: [{ type: 'text', content: `recovered-${input.message.text}` }],
        mediaCatalog: [],
        expectedConversationEpoch: claimed.message.claimedConversationEpoch,
        expectedRuntimeEpoch: claimed.message.claimedRuntimeEpoch,
      };
      return {
        kind: 'started',
        primaryMessageKey: input.message.messageKey,
        turnId: `recovery-${this.submissions}`,
        completion: Promise.resolve(completion),
      };
    }
    async close(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  test('[R04] processing and preparing crash recover Codex once into one outbox each', async (t) => {
    const root = await workspace(t);
    const database = path.join(root, 'state.sqlite');
    const seeded = await crashSeed(t, database, 'codex');
    const store = new SqliteStore({ filePath: database });
    const agent = new RecoveryAgent(store);
    const processor = new ConversationProcessor({
      store,
      codexAgent: agent,
      mediaGateway: { resolveForCodex: async () => [] },
      outboundPreparer: {
        async prepare({ candidates }) {
          const attempts: PreparedAttempt[] = candidates.map((candidate, sendIndex) => ({
            sendIndex,
            sentType: 'text',
            payload: {
              msgtype: 'text',
              text: { content: 'content' in candidate ? String(candidate.content) : '' },
            },
          }));
          return { attempts, spoolPaths: [] };
        },
        async cleanup() {},
      },
      delivery: { kick: async () => {} },
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
    assert.equal(agent.submissions, 2, 'ready outbox must not start Codex again');
    await processor.close();
    store.close();
  });

  test('[R04] SIGKILL across turn outbox and delivery boundaries preserves Codex at-least-once and WeChat at-most-once semantics', async (t) => {
    for (const scenario of ['pending', 'sending', 'accepted', 'partial'] as const) {
      await t.test(`${scenario} crash`, async (subtest) => {
        const root = await workspace(subtest);
        const database = path.join(root, 'state.sqlite');
        const seeded = await crashSeed(subtest, database, scenario);
        const store = new SqliteStore({ filePath: database });
        const recovery = store.recoverStartup();
        const calls: Array<{ content: string; messageId: string }> = [];
        const delivery = new DeliveryService({
          store,
          apiClient: {
            async sendPreparedMessage(input) {
              const text = input.payload.text as { content?: unknown };
              calls.push({
                content: String(text.content || ''),
                messageId: String(input.messageId || ''),
              });
              return { msgid: `wx-${calls.length}` };
            },
          },
          logger: { info() {}, warn() {}, error() {} },
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
    }
  });

  test('[R08] same raw msgid across open_kfid remains isolated through crash recovery', async (t) => {
    const root = await workspace(t);
    const database = path.join(root, 'state.sqlite');
    const seeded = await crashSeed(t, database, 'isolation');
    assert.notEqual(seeded.keys[0], seeded.keys[1]);
    const store = new SqliteStore({ filePath: database });
    store.recoverStartup();
    const calls: Array<{ openKfId: string; messageId: string }> = [];
    const delivery = new DeliveryService({
      store,
      apiClient: {
        async sendPreparedMessage(input) {
          calls.push({
            openKfId: input.openKfId,
            messageId: String(input.messageId || ''),
          });
          return { msgid: `wx-${calls.length}` };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    await delivery.kick();
    assert.deepEqual(calls.map((call) => call.openKfId).sort(), ['wk-a', 'wk-b']);
    assert.equal(new Set(calls.map((call) => call.messageId)).size, 2);
    await delivery.close();
    store.close();
  });

  test('[O08] fallback state transition survives SIGKILL and sends exactly once', async (t) => {
    const root = await workspace(t);
    const database = path.join(root, 'state.sqlite');
    const seeded = await crashSeed(t, database, 'fallback');
    const store = new SqliteStore({ filePath: database });
    const recovery = store.recoverStartup();
    assert.equal(recovery.uncertainSends, 0);
    const calls: string[] = [];
    const delivery = new DeliveryService({
      store,
      apiClient: {
        async sendPreparedMessage(input) {
          const text = input.payload.text as { content?: unknown };
          calls.push(String(text.content || ''));
          return { msgid: 'wx-fallback' };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    await delivery.kick();
    await delivery.kick();
    assert.deepEqual(calls, ['安全兜底']);
    const attempts = inspectAttempts(store.database, seeded.keys[0]!);
    assert.deepEqual(attempts.map((attempt) => attempt.status), [
      'failed',
      'accepted',
    ]);
    await delivery.close();
    store.close();
  });
}
