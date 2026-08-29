import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';

async function createHarness(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-events-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  let cursor = '';
  let kicks = 0;
  const processor = new ConversationProcessor({
    store,
    agent: {
      async ensureThread(_conversationId, threadId) {
        return threadId || 'thread-events';
      },
      activePrimary() { return undefined; },
      async submit() { throw new Error('events must not invoke Codex'); },
      async close() {},
      async abort() {},
    },
    mediaGateway: { async resolveForCodex() { return []; } },
    channel: {
      async kick() { kicks += 1; },
    },
    allowedUserIds: ['wm-one'],
    logger: { info() {}, error() {} },
  });

  function ingest(raw: Record<string, unknown>): string {
    const nextCursor = `cursor-${String(raw.msgid)}`;
    const result = store.ingestSyncPage({
      openKfId: 'wk-one',
      expectedCursor: cursor,
      nextCursor,
      messages: [normalizeWecomMessage(raw, 'wk-one', { cursor, index: 0 })],
    });
    cursor = nextCursor;
    const key = result.insertedMessageKeys[0];
    if (!key) throw new Error('Expected event insertion');
    return key;
  }

  t.onTestFinished(async () => {
    await processor.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, processor, ingest, kicks: () => kicks };
}

function event(msgid: string, attributes: Record<string, unknown>) {
  return {
    msgid,
    origin: 4,
    msgtype: 'event',
    event: {
      open_kfid: 'wk-one',
      external_userid: 'wm-one',
      ...attributes,
    },
  };
}

test('persisted inbox identity overrides and rejects a mismatched payload identity', async (t) => {
  const harness = await createHarness(t);
  const key = harness.ingest({
    msgid: 'identity-mismatch', open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 3, msgtype: 'text', text: { content: '不要串到其他客服' },
  });
  harness.store.database.prepare(`
    UPDATE inbound_messages
    SET payload_json = json_set(
      payload_json,
      '$.conversation.accountKey', 'wk-payload',
      '$.conversation.peerId', 'wm-payload'
    )
    WHERE message_key = ?
  `).run(key);
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'ignored');
  assert.equal(harness.store.getConversation('wk-payload', 'wm-payload'), undefined);
  assert.equal(harness.store.getConversation('wk-one', 'wm-one')?.threadId, '');
});

test('msg_send_fail reports the failed fact without automatic resend', async (t) => {
  const harness = await createHarness(t);
  const sourceKey = harness.ingest({
    msgid: 'source', open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 3, msgtype: 'text', text: { content: 'source' },
  });
  assert.equal(sourceKey, stableMessageKey('wk-one', 'source'));
  harness.store.claimInbound({ messageKey: sourceKey });
  const finalized = seedPendingAttempts(harness.store, sourceKey, [{
      sendIndex: 0, sentType: 'location',
      payload: { msgtype: 'location', location: { name: '地点' } },
    }]);
  const sending = harness.store.beginNextSend();
  if (!sending) throw new Error('Expected pending primary attempt');
  harness.store.completeSend(sending.attemptId, { wecomMsgId: 'wecom-failed' });

  const failureKey = harness.ingest(event('failure-event', {
    event_type: 'msg_send_fail', fail_msgid: 'wecom-failed', fail_type: 13,
  }));
  await harness.processor.enqueue(failureKey);
  const attempts = inspectAttempts(harness.store.database, sourceKey);
  assert.deepEqual(attempts.map((item) => item.status), ['failed']);
  assert.equal(attempts[0]?.failType, 13);
  assert.match(attempts[0]?.errorMessage || '', /fail_type=13/u);
  assert.equal(harness.kicks(), 0);
  assert.equal(finalized.length, 1);
});

test('unknown system event is ignored without delivery', async (t) => {
  const harness = await createHarness(t);
  const key = harness.ingest(event('unknown-event', { event_type: 'future_event' }));
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'ignored');
  assert.equal(harness.kicks(), 0);
});
