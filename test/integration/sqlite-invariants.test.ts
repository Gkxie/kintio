import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  SqliteStore,
  type InboundStatus,
} from '../../src/state/sqlite-store.js';
import type { ImageAttachment, NormalizedMessage } from '../../src/types.js';
import { inspectAttempt } from '../support/sqlite-inspect.js';
import { testWecomMessage } from '../support/wecom-message.js';

function message(id: string, externalUserId = 'wm-one'): NormalizedMessage {
  return testWecomMessage({
    id,
    openKfId: 'wk-one',
    externalUserId,
  });
}

function harness(t: TestContext): { store: SqliteStore; filePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-invariant-'));
  const filePath = path.join(directory, 'state.sqlite');
  const store = new SqliteStore({ filePath });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

function ingest(store: SqliteStore, values: readonly NormalizedMessage[]): string[] {
  return store.ingestSyncPage({
    openKfId: 'wk-one',
    expectedCursor: store.getCursor('wk-one'),
    nextCursor: `cursor-${values.map((item) => item.id).join('-')}`,
    messages: values,
  }).insertedMessageKeys;
}

function reserveText(store: SqliteStore, id: string): string {
  const [messageKey] = ingest(store, [message(id)]);
  assert.ok(messageKey);
  const claimed = store.claimInbound({ messageKey }).message;
  store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [{
      sendIndex: 0,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: id } },
    }],
  });
  return messageKey;
}

test('[D01] invalid journal mode and newer schema fail before runtime use', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => new SqliteStore({
      filePath: path.join(directory, 'bad-mode.sqlite'),
      journalMode: 'MEMORY' as unknown as 'WAL',
    }),
    /Unsupported SQLite journal mode/u,
  );
  const futurePath = path.join(directory, 'future.sqlite');
  const future = new DatabaseSync(futurePath);
  future.exec('PRAGMA user_version = 999');
  future.close();
  assert.throws(
    () => new SqliteStore({ filePath: futurePath }),
    /newer than supported/u,
  );
});

test('[R05][SEC02] status CHECK rejects invalid rows and filters remain parameterized', (t) => {
  const { store } = harness(t);
  assert.throws(() =>
    store.database.prepare(`
      INSERT INTO inbound_messages (
        message_key, open_kfid, msgid, origin, msg_type, status,
        created_at, updated_at
      ) VALUES ('bad', 'wk-one', 'bad', 'customer', 'text', 'bogus', 1, 1)
    `).run(),
  /CHECK constraint/u);
  const malicious = "received') OR 1=1 --" as unknown as InboundStatus;
  assert.deepEqual(store.listPendingInbound({ statuses: [malicious] }), []);
  assert.throws(
    () => store.checkpoint('INVALID' as unknown as 'FULL'),
    /Unsupported checkpoint mode/u,
  );
});

test('[S07] steering rejects cross-conversation and non-steerable primaries', (t) => {
  const { store } = harness(t);
  const [primary, other] = ingest(store, [message('primary'), message('other', 'wm-two')]);
  assert.ok(primary && other);
  store.claimInbound({ messageKey: primary });
  assert.throws(() => store.beginInboundSteering({
    messageKey: other,
    primaryMessageKey: primary,
  }), /belong.*conversation/u);
  store.markInboundCompleted(primary);
  const [follow] = ingest(store, [message('follow')]);
  assert.ok(follow);
  assert.throws(() => store.beginInboundSteering({
    messageKey: follow,
    primaryMessageKey: primary,
  }), /not steerable/u);
});

test('[R04] illegal inbound transitions and unknown records fail closed', (t) => {
  const { store } = harness(t);
  const [primary, steer] = ingest(store, [message('primary'), message('steer')]);
  assert.ok(primary && steer);
  assert.throws(() => store.markInboundPreparing(primary), /Cannot mark/u);
  assert.throws(() => store.confirmInboundSteered(steer), /Cannot confirm/u);
  store.claimInbound({ messageKey: primary });
  store.beginInboundSteering({ messageKey: steer, primaryMessageKey: primary });
  assert.throws(
    () => store.requeueInboundSteering(steer, 'wrong-primary'),
    /Cannot requeue/u,
  );
  assert.throws(() => store.markInboundHeld(primary), /Cannot hold/u);
  assert.throws(() => store.claimInbound({ messageKey: 'missing' }), /Unknown/u);
});

test('[R04][A05][H03] late failures cannot overwrite held suppressed ready or completed states', (t) => {
  const { store } = harness(t);
  const [suppressed, held, ready, completed] = ingest(store, [
    message('terminal-suppressed'), message('terminal-held'),
    message('terminal-ready'), message('terminal-completed'),
  ]);
  assert.ok(suppressed && held && ready && completed);

  store.claimInbound({ messageKey: suppressed });
  store.suppressInbound(suppressed, 'authorization_revoked');
  store.failInbound(suppressed, new Error('late turn failure'));
  assert.equal(store.getInbound(suppressed)?.status, 'suppressed');
  assert.match(store.getInbound(suppressed)?.errorMessage || '', /authorization_revoked/u);

  store.markInboundHeld(held);
  store.failInbound(held, new Error('late turn failure'));
  assert.equal(store.getInbound(held)?.status, 'held');
  assert.throws(() => store.markInboundIgnored(held), /Cannot ignore/u);

  const claim = store.claimInbound({ messageKey: ready }).message;
  store.finalizeInboundBatch({
    messageKey: ready,
    expectedConversationEpoch: claim.claimedConversationEpoch,
    expectedRuntimeEpoch: claim.claimedRuntimeEpoch,
    attempts: [{
      sendIndex: 0, sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'ready' } },
    }],
  });
  store.failInbound(ready, new Error('late turn failure'));
  assert.equal(store.getInbound(ready)?.status, 'ready');

  store.markInboundCompleted(completed);
  store.failInbound(completed, new Error('late turn failure'));
  assert.equal(store.getInbound(completed)?.status, 'completed');
});

test('[O07][R06] final batch rejects empty oversized duplicate indexes and changed payload', (t) => {
  const { store } = harness(t);
  const [messageKey] = ingest(store, [message('batch')]);
  assert.ok(messageKey);
  const claimed = store.claimInbound({ messageKey }).message;
  const base = {
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
  };
  assert.throws(
    () => store.finalizeInboundBatch({ ...base, attempts: [] }),
    /1 to 5/u,
  );
  assert.throws(
    () => store.finalizeInboundBatch({
      ...base,
      attempts: Array.from({ length: 6 }, (_, sendIndex) => ({
        sendIndex,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: String(sendIndex) } },
      })),
    }),
    /1 to 5/u,
  );
  assert.throws(
    () => store.finalizeInboundBatch({
      ...base,
      attempts: [0, 0].map((sendIndex) => ({
        sendIndex,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: 'duplicate' } },
      })),
    }),
    /duplicate send indexes/u,
  );
  store.finalizeInboundBatch({
    ...base,
    attempts: [{
      sendIndex: 0,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'original' } },
    }],
  });
  assert.throws(
    () => store.finalizeInboundBatch({
      ...base,
      attempts: [{
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: 'changed' } },
      }],
    }),
    /invariant conflict/u,
  );
});

test('[R01][R07] send terminal states cannot reverse and unknown attempts reject', (t) => {
  const { store } = harness(t);
  assert.throws(() => store.completeSend('missing', { wecomMsgId: 'wx' }), /Unknown/u);
  assert.throws(() => store.failSend('missing', new Error('x')), /Unknown/u);
  assert.throws(() => store.markSendUncertain('missing', new Error('x')), /Unknown/u);
  assert.equal(inspectAttempt(store.database, 'missing'), undefined);

  const messageKey = reserveText(store, 'terminal');
  const attempt = store.beginNextSend();
  assert.ok(attempt);
  store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-terminal' });
  assert.equal(store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-terminal' }).status, 'accepted');
  assert.throws(() => store.failSend(attempt.attemptId, new Error('late')), /status accepted/u);
  assert.throws(
    () => store.markSendUncertain(attempt.attemptId, new Error('late')),
    /status accepted/u,
  );
  assert.equal(store.markSendMsgFailed({ wecomMsgId: '', failType: 1 }), false);
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
});

test('[C06][O06] media writes validate owner attachment and expiry inputs', (t) => {
  const { store } = harness(t);
  const [messageKey] = ingest(store, [message('media')]);
  assert.ok(messageKey);
  assert.throws(() => store.rememberInboundMedia({
    messageKey: 'missing',
    attachments: [],
  }), /Unknown/u);
  assert.throws(() => store.rememberInboundMedia({
    messageKey,
    attachments: null as unknown as readonly ImageAttachment[],
  }), /attachments must be an array/u);
  assert.throws(() => store.rememberInboundMedia({
    messageKey,
    attachments: [{ kind: 'image', mediaId: '' }],
  }), /mediaId is required/u);
  const remembered = store.rememberInboundMedia({
    messageKey,
    attachments: [{ kind: 'image', mediaId: 'media-id', filename: 'x.png' }],
  });
  assert.equal(remembered[0]?.mediaId, 'media-id');
  assert.deepEqual(store.listRecentMedia({
    openKfId: 'wk-one', externalUserId: 'wm-one', maxAgeMs: -1,
  }), []);
});

test('[C01][SEC02] one nonempty Codex thread belongs to exactly one conversation', (t) => {
  const { store } = harness(t);
  store.setConversationThread({
    openKfId: 'wk-one', externalUserId: 'wm-one', threadId: 'thread-shared',
  });
  assert.throws(
    () => store.setConversationThread({
      openKfId: 'wk-two', externalUserId: 'wm-two', threadId: 'thread-shared',
    }),
    /UNIQUE constraint failed/u,
  );
  assert.equal(
    store.getConversation('wk-two', 'wm-two')?.threadId,
    undefined,
  );
});
