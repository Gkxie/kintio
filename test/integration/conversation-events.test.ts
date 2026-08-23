import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';

async function createHarness(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-events-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  let cursor = '';
  let kicks = 0;
  const processor = new ConversationProcessor({
    store,
    codexAgent: {
      async submit() { throw new Error('events must not invoke Codex'); },
      async close() {},
      async abort() {},
    },
    mediaGateway: { async resolveForCodex() { return []; } },
    outboundPreparer: {
      async prepare() { throw new Error('events must not prepare replies'); },
      async cleanup() {},
    },
    delivery: {
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

  t.after(async () => {
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

test('[H01] origin=5 enters human mode and is retained as held context', async (t) => {
  const harness = await createHarness(t);
  const key = harness.ingest({
    msgid: 'human-one', open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 5, servicer_userid: 'admin-one', msgtype: 'text',
    text: { content: '批准' },
  });
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getConversation('wk-one', 'wm-one')?.mode, 'human');
  assert.equal(harness.store.getInbound(key)?.status, 'held');
  assert.equal(harness.store.getInbound(key)?.contextStatus, 'pending');
  assert.equal(harness.store.getAuthorization('wm-one'), undefined);
});

test('[SEC02] persisted inbox identity overrides and rejects a mismatched payload identity', async (t) => {
  const harness = await createHarness(t);
  const key = harness.ingest({
    msgid: 'identity-mismatch', open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 3, msgtype: 'text', text: { content: '不要串到其他客服' },
  });
  harness.store.database.prepare(`
    UPDATE inbound_messages
    SET payload_json = json_set(
      payload_json,
      '$.conversation.openKfId', 'wk-payload',
      '$.conversation.externalUserId', 'wm-payload'
    )
    WHERE message_key = ?
  `).run(key);
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'ignored');
  assert.equal(harness.store.getConversation('wk-payload', 'wm-payload'), undefined);
  assert.equal(harness.store.getConversation('wk-one', 'wm-one')?.threadId, '');
});

test('[H02] session change types 1/2/4 enter human mode and type 3 ends it', async (t) => {
  const harness = await createHarness(t);
  for (const changeType of [1, 2, 4, 3]) {
    const key = harness.ingest(event(`change-${changeType}`, {
      event_type: 'session_status_change',
      change_type: changeType,
      new_servicer_userid: 'admin-one',
    }));
    await harness.processor.enqueue(key);
    assert.equal(
      harness.store.getConversation('wk-one', 'wm-one')?.mode,
      changeType === 3 ? 'ended' : 'human',
    );
    assert.equal(harness.store.getInbound(key)?.status, 'completed');
  }
});

test('[R03] msg_send_fail marks accepted send failed and activates its blocked fallback', async (t) => {
  const harness = await createHarness(t);
  const sourceKey = harness.ingest({
    msgid: 'source', open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 3, msgtype: 'text', text: { content: 'source' },
  });
  assert.equal(sourceKey, stableMessageKey('wk-one', 'source'));
  const claimed = harness.store.claimInbound({ messageKey: sourceKey }).message;
  const finalized = harness.store.finalizeInboundBatch({
    messageKey: sourceKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0, sentType: 'location',
        payload: { msgtype: 'location', location: { name: '地点' } },
      },
      {
        sendIndex: 1, sentType: 'text', status: 'blocked', fallbackForIndex: 0,
        payload: { msgtype: 'text', text: { content: '地点' } },
      },
    ],
  });
  const sending = harness.store.beginNextSend();
  if (!sending) throw new Error('Expected pending primary attempt');
  harness.store.completeSend(sending.attemptId, { wecomMsgId: 'wecom-failed' });

  const failureKey = harness.ingest(event('failure-event', {
    event_type: 'msg_send_fail', fail_msgid: 'wecom-failed', fail_type: 13,
  }));
  await harness.processor.enqueue(failureKey);
  const attempts = inspectAttempts(harness.store.database, sourceKey);
  assert.deepEqual(attempts.map((item) => item.status), ['failed', 'pending']);
  assert.equal(attempts[0]?.failType, 13);
  assert.equal(harness.kicks(), 1);
  assert.equal(finalized.attempts.length, 2);
});

test('[G05] unknown system event is ignored without delivery', async (t) => {
  const harness = await createHarness(t);
  const key = harness.ingest(event('unknown-event', { event_type: 'future_event' }));
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'ignored');
  assert.equal(harness.kicks(), 0);
});
