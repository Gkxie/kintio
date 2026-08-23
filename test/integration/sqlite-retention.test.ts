import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.js';
import { inspectAttempt } from '../support/sqlite-inspect.js';
import { testWecomMessage } from '../support/wecom-message.js';

async function createStore(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-retention-'));
  const clock = { value: 1_000 };
  const store = new SqliteStore({
    filePath: path.join(directory, 'wecom.sqlite'),
    clock: () => clock.value,
  });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, clock };
}

function ingest(
  store: SqliteStore,
  openKfId: string,
  externalUserId: string,
  msgid: string,
  cursor: string,
) {
  store.ingestSyncPage({
    openKfId,
    expectedCursor: cursor,
    nextCursor: `${cursor}-${msgid}`,
    messages: [testWecomMessage({
      id: msgid, openKfId, externalUserId, type: 'image',
    })],
  });
  return stableMessageKey(openKfId, msgid);
}

test('[O06] media TTL cleanup is conversation scoped and preserves fresh media', async (t) => {
  const { store, clock } = await createStore(t);
  const oldA = ingest(store, 'wk-a', 'wm-a', 'old-a', '');
  const oldB = ingest(store, 'wk-b', 'wm-b', 'old-b', '');
  store.rememberInboundMedia({
    messageKey: oldA, sentAt: 1,
    attachments: [{ kind: 'image', mediaId: 'media-old-a' }],
  });
  store.rememberInboundMedia({
    messageKey: oldB, sentAt: 1,
    attachments: [{ kind: 'image', mediaId: 'media-old-b' }],
  });
  clock.value = 2_000;
  const freshA = ingest(store, 'wk-a', 'wm-a', 'fresh-a', '-old-a');
  store.rememberInboundMedia({
    messageKey: freshA, sentAt: 2,
    attachments: [{ kind: 'image', mediaId: 'media-fresh-a' }],
  });

  assert.deepEqual(
    store.listRecentMedia({ openKfId: 'wk-a', externalUserId: 'wm-a', maxAgeMs: 2_000 })
      .map((item) => item.mediaId),
    ['media-fresh-a', 'media-old-a'],
  );
  assert.deepEqual(
    store.listRecentMedia({ openKfId: 'wk-b', externalUserId: 'wm-b', maxAgeMs: 2_000 })
      .map((item) => item.mediaId),
    ['media-old-b'],
  );
  const cleaned = store.cleanup({
    mediaMaxAgeMs: 500,
    payloadMaxAgeMs: 10_000,
    acceptedAuditMaxAgeMs: 10_000,
  });
  assert.equal(cleaned.media, 2);
  assert.deepEqual(
    store.listRecentMedia({ openKfId: 'wk-a', externalUserId: 'wm-a' })
      .map((item) => item.mediaId),
    ['media-fresh-a'],
  );
  assert.deepEqual(
    store.listRecentMedia({ openKfId: 'wk-b', externalUserId: 'wm-b' }),
    [],
  );
});

test('[R01][R07] cleanup retains uncertain, deletes expired blocked fallbacks, and expires accepted/failed audits', async (t) => {
  const { store, clock } = await createStore(t);
  let cursor = '';

  function reserve(msgid: string, attempts: Parameters<SqliteStore['finalizeInboundBatch']>[0]['attempts']) {
    const key = ingest(store, 'wk-one', 'wm-one', msgid, cursor);
    cursor = `${cursor}-${msgid}`;
    const claimed = store.claimInbound({ messageKey: key }).message;
    return store.finalizeInboundBatch({
      messageKey: key,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts,
    });
  }

  const accepted = reserve('accepted', [{
    sendIndex: 0, sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'accepted' } },
  }]);
  const acceptedSending = store.beginNextSend();
  if (!acceptedSending) throw new Error('Expected accepted send');
  store.completeSend(acceptedSending.attemptId, { wecomMsgId: 'accepted-id' });

  const failed = reserve('failed', [{
    sendIndex: 0, sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'failed' } },
  }]);
  const failedSending = store.beginNextSend();
  if (!failedSending) throw new Error('Expected failed send');
  store.failSend(failedSending.attemptId, new Error('definitive'));

  const uncertain = reserve('uncertain', [{
    sendIndex: 0, sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'uncertain' } },
  }]);
  const uncertainSending = store.beginNextSend();
  if (!uncertainSending) throw new Error('Expected uncertain send');
  store.markSendUncertain(uncertainSending.attemptId, new Error('network'));

  const blocked = reserve('blocked', [
    {
      sendIndex: 0, sentType: 'location',
      payload: { msgtype: 'location', location: { name: 'place' } },
    },
    {
      sendIndex: 1, sentType: 'text', status: 'blocked', fallbackForIndex: 0,
      payload: { msgtype: 'text', text: { content: 'fallback' } },
    },
  ]);
  const blockedPrimary = store.beginNextSend();
  if (!blockedPrimary) throw new Error('Expected blocked primary');
  store.completeSend(blockedPrimary.attemptId, { wecomMsgId: 'blocked-primary' });

  clock.value = 5_000;
  const result = store.cleanup({
    mediaMaxAgeMs: 10_000,
    payloadMaxAgeMs: 100,
    acceptedAuditMaxAgeMs: 100,
  });
  assert.equal(result.blockedFallbacks, 1);
  assert.equal(result.audits, 3);
  assert.equal(inspectAttempt(store.database, uncertain.attempts[0]!.attemptId)?.status, 'uncertain');
  assert.ok(inspectAttempt(store.database, uncertain.attempts[0]!.attemptId)?.payload);
  assert.equal(inspectAttempt(store.database, accepted.attempts[0]!.attemptId), undefined);
  assert.equal(inspectAttempt(store.database, failed.attempts[0]!.attemptId), undefined);
  assert.equal(inspectAttempt(store.database, blocked.attempts[1]!.attemptId), undefined);
});
