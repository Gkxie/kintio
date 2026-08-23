import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  AgentCompletion,
  AgentInput,
  AgentSubmission,
  HistoryInspection,
  StagedCandidate,
} from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import type { PreparedAttempt } from '../../src/types.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

function textCandidate(content: string): StagedCandidate {
  return { type: 'text', content };
}

interface InspectionOptions {
  readonly state?: HistoryInspection['state'];
  readonly foundIds?: readonly string[];
  readonly historicalText?: string;
  readonly turnId?: string;
}

class FakeCodexAgent {
  readonly submitCalls: AgentInput[] = [];
  readonly inspectCalls: Array<{
    threadId: string;
    clientInputIds: readonly string[];
    latestClientInputId: string;
  }> = [];
  readonly #store: SqliteStore;
  readonly #inspection: InspectionOptions;
  readonly #continuationText: string;

  constructor(
    store: SqliteStore,
    inspection: InspectionOptions = {},
    continuationText = '恢复后的最终回答',
  ) {
    this.#store = store;
    this.#inspection = inspection;
    this.#continuationText = continuationText;
  }

  async inspectHistory(
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
  ): Promise<HistoryInspection> {
    this.inspectCalls.push({ threadId, clientInputIds, latestClientInputId });
    return {
      state: this.#inspection.state || 'missing',
      turnId: this.#inspection.turnId || 'historical-turn',
      foundClientInputIds: new Set(this.#inspection.foundIds || []),
      candidates: this.#inspection.historicalText
        ? [textCandidate(this.#inspection.historicalText)]
        : [],
    };
  }

  async submit(input: AgentInput): Promise<AgentSubmission> {
    this.submitCalls.push(input);
    const claimed = this.#store.claimInbound({
      messageKey: input.message.messageKey,
      clientInputId: input.clientInputId || input.message.messageKey,
      consumeHeldContext: Boolean(input.consumeHeldContext),
    });
    const completion: AgentCompletion = {
      candidates: [textCandidate(this.#continuationText)],
      mediaCatalog: input.mediaCatalog || [],
      expectedConversationEpoch: claimed.message.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.message.claimedRuntimeEpoch,
    };
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `continuation-${this.submitCalls.length}`,
      completion: Promise.resolve(completion),
    };
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

interface PreparedObservation {
  readonly messageKey: string;
  readonly candidates: AgentCompletion['candidates'];
}

interface Harness {
  readonly store: SqliteStore;
  readonly codex: FakeCodexAgent;
  readonly processor: ConversationProcessor;
  readonly prepared: PreparedObservation[];
}

function candidateContent(candidate: AgentCompletion['candidates'][number]): string {
  return 'content' in candidate ? String(candidate.content || '') : '';
}

function createHarness(
  t: TestContext,
  inspection: InspectionOptions = {},
  continuationText = '恢复后的最终回答',
): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reconcile-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  const codex = new FakeCodexAgent(store, inspection, continuationText);
  const prepared: PreparedObservation[] = [];
  const processor = new ConversationProcessor({
    store,
    codexAgent: codex,
    mediaGateway: { resolveForCodex: async () => [] },
    outboundPreparer: {
      async prepare({ messageKey, candidates }) {
        prepared.push({ messageKey, candidates: [...candidates] });
        const attempts: PreparedAttempt[] = candidates.map(
          (candidate, sendIndex) => ({
            sendIndex,
            source: 'codex_tool',
            sentType: 'text',
            payload: {
              msgtype: 'text',
              text: { content: candidateContent(candidate) },
            },
          }),
        );
        return { attempts, spoolPaths: [] };
      },
      async cleanup() {},
    },
    delivery: { kick: async () => {} },
    allowedUserIds: ['wm-recovery'],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    await processor.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, codex, processor, prepared };
}

function inbound(msgid: string, summary = msgid) {
  return testWecomMessage({
    id: msgid,
    sentAt: 100,
    openKfId: 'wk-recovery',
    externalUserId: 'wm-recovery',
    text: summary,
  });
}

interface SeedOptions {
  readonly primaryId?: string;
  readonly primaryStatus?: 'processing' | 'preparing';
  readonly steerId?: string;
  readonly steerStatus?: 'steering' | 'steered';
}

function seedGroup(
  store: SqliteStore,
  {
    primaryId = 'primary',
    primaryStatus = 'processing',
    steerId,
    steerStatus,
  }: SeedOptions = {},
): { primaryKey: string; steerKey: string } {
  const messages = [inbound(primaryId, '原始问题')];
  if (steerId) messages.push(inbound(steerId, '最新调整'));
  store.ingestSyncPage({
    openKfId: 'wk-recovery',
    nextCursor: 'cursor-1',
    messages,
  });
  const primaryKey = stableMessageKey('wk-recovery', primaryId);
  store.setConversationThread({
    openKfId: 'wk-recovery',
    externalUserId: 'wm-recovery',
    threadId: 'thread-recovery',
  });
  store.claimInbound({ messageKey: primaryKey, clientInputId: primaryKey });
  if (primaryStatus === 'preparing') store.markInboundPreparing(primaryKey, 'old-turn');
  const steerKey = steerId ? stableMessageKey('wk-recovery', steerId) : '';
  if (steerKey) {
    store.beginInboundSteering({
      messageKey: steerKey,
      primaryMessageKey: primaryKey,
      clientInputId: steerKey,
    });
    if (steerStatus === 'steered') {
      store.confirmInboundSteered(steerKey, { codexTurnId: 'old-turn' });
    }
  }
  return { primaryKey, steerKey };
}

async function recoverAll(harness: Harness): Promise<void> {
  await harness.processor.recover(harness.store.recoverStartup().inbound);
  await harness.processor.waitForIdle();
}

function onlyAttempt(store: SqliteStore, messageKey: string) {
  const attempt = inspectAttempts(store.database, messageKey)[0];
  assert.ok(attempt?.payload);
  return attempt;
}

function attemptText(store: SqliteStore, messageKey: string): string {
  const payload = onlyAttempt(store, messageKey).payload;
  const text = payload?.text;
  return text && typeof text === 'object' && !Array.isArray(text)
    ? String(text.content || '')
    : '';
}

test('processing input absent from history starts one recovery continuation and one outbox batch', async (t) => {
  const harness = createHarness(t);
  const { primaryKey } = seedGroup(harness.store);
  await recoverAll(harness);
  assert.equal(harness.codex.submitCalls.length, 1);
  assert.equal(harness.codex.submitCalls[0]?.clientInputId, `${primaryKey}-recovery`);
  assert.equal(harness.prepared.length, 1);
  assert.equal(candidateContent(harness.prepared[0]!.candidates[0]!), '恢复后的最终回答');
  assert.equal(attemptText(harness.store, primaryKey), '恢复后的最终回答');
});

test('completed history finalizes only the latest-steer candidate without submit', async (t) => {
  const primaryId = 'primary-history';
  const steerId = 'steer-history';
  const primaryKey = stableMessageKey('wk-recovery', primaryId);
  const steerKey = stableMessageKey('wk-recovery', steerId);
  const harness = createHarness(t, {
    state: 'completed',
    foundIds: [primaryKey, steerKey],
    historicalText: '历史中的最新回答',
  });
  seedGroup(harness.store, {
    primaryId,
    primaryStatus: 'preparing',
    steerId,
    steerStatus: 'steered',
  });
  await recoverAll(harness);
  assert.equal(harness.codex.submitCalls.length, 0);
  assert.equal(harness.codex.inspectCalls.length, 1);
  assert.equal(harness.codex.inspectCalls[0]?.latestClientInputId, steerKey);
  assert.equal(harness.store.getInbound(steerKey)?.status, 'absorbed');
  assert.equal(candidateContent(harness.prepared[0]!.candidates[0]!), '历史中的最新回答');
});

test('durable steering found in history is confirmed before historical finalization', async (t) => {
  const primaryId = 'primary-confirm';
  const steerId = 'steer-confirm';
  const primaryKey = stableMessageKey('wk-recovery', primaryId);
  const steerKey = stableMessageKey('wk-recovery', steerId);
  const harness = createHarness(t, {
    state: 'completed',
    foundIds: [primaryKey, steerKey],
    historicalText: '已确认 steering 的回答',
  });
  seedGroup(harness.store, {
    primaryId,
    primaryStatus: 'preparing',
    steerId,
    steerStatus: 'steering',
  });
  await recoverAll(harness);
  assert.equal(harness.codex.submitCalls.length, 0);
  assert.equal(harness.codex.inspectCalls.length, 1);
  assert.equal(harness.store.getInbound(steerKey)?.status, 'absorbed');
  assert.equal(candidateContent(harness.prepared[0]!.candidates[0]!), '已确认 steering 的回答');
});

test('missing steering is merged into one continuation instead of stale history', async (t) => {
  const primaryId = 'primary-missing';
  const steerId = 'missing-steer';
  const primaryKey = stableMessageKey('wk-recovery', primaryId);
  const harness = createHarness(t, {
    state: 'completed',
    foundIds: [primaryKey],
    historicalText: '不应直接使用的旧回答',
  }, '合并缺失 steering 后的回答');
  const { steerKey } = seedGroup(harness.store, {
    primaryId,
    primaryStatus: 'preparing',
    steerId,
    steerStatus: 'steering',
  });
  await recoverAll(harness);
  assert.equal(harness.codex.submitCalls.length, 1);
  assert.match(harness.codex.submitCalls[0]?.contextText || '', /原始问题/u);
  assert.match(harness.codex.submitCalls[0]?.contextText || '', /最新调整/u);
  assert.equal(harness.store.getInbound(steerKey)?.status, 'absorbed');
  assert.equal(candidateContent(harness.prepared[0]!.candidates[0]!), '合并缺失 steering 后的回答');
});

test('[H03] human takeover and pause suppress recovery without Codex activity', async (t) => {
  for (const mode of ['human', 'paused'] as const) {
    await t.test(mode, async (t) => {
      const harness = createHarness(t);
      const { primaryKey } = seedGroup(harness.store, {
        primaryId: `primary-${mode}`,
        primaryStatus: 'preparing',
      });
      if (mode === 'human') {
        harness.store.setConversationMode({
          openKfId: 'wk-recovery',
          externalUserId: 'wm-recovery',
          mode: 'human',
        });
      } else {
        harness.store.setRuntimePaused(true);
      }
      await recoverAll(harness);
      assert.equal(harness.store.getInbound(primaryKey)?.status, 'suppressed');
      assert.equal(inspectAttempts(harness.store.database, primaryKey).length, 0);
      assert.equal(harness.codex.inspectCalls.length, 0);
      assert.equal(harness.codex.submitCalls.length, 0);
    });
  }
});
