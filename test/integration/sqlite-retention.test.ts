import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import { IlinkLoginStore } from '../../src/ilink/login-store.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import { inspectAttempt } from '../support/sqlite-inspect.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

async function createStore(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-retention-'));
  const clock = { value: 1_000 };
  const store = new SqliteStore({
    filePath: path.join(directory, 'wecom.sqlite'),
    clock: () => clock.value,
  });
  t.onTestFinished(async () => {
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

test('media TTL cleanup is conversation scoped and preserves fresh media', async (t) => {
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

test('cleanup retains uncertain and expires accepted/failed audits', async (t) => {
  const { store, clock } = await createStore(t);
  let cursor = '';

  function reserve(msgid: string, attempts: Parameters<typeof seedPendingAttempts>[2]) {
    const key = ingest(store, 'wk-one', 'wm-one', msgid, cursor);
    cursor = `${cursor}-${msgid}`;
    store.claimInbound({ messageKey: key });
    return seedPendingAttempts(store, key, attempts);
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

  clock.value = 5_000;
  const result = store.cleanup({
    mediaMaxAgeMs: 10_000,
    payloadMaxAgeMs: 100,
    acceptedAuditMaxAgeMs: 100,
  });
  assert.equal(result.audits, 2);
  assert.equal(inspectAttempt(store.database, uncertain[0]!.attemptId)?.status, 'uncertain');
  assert.ok(inspectAttempt(store.database, uncertain[0]!.attemptId)?.payload);
  assert.equal(inspectAttempt(store.database, accepted[0]!.attemptId), undefined);
  assert.equal(inspectAttempt(store.database, failed[0]!.attemptId), undefined);
});

test('iLink login cleanup audits an expired offer before deleting its secret', async (t) => {
  const { store, clock } = await createStore(t);
  store.database.prepare(`
    INSERT INTO ilink_login_offers (
      offer_id, source_message_key, source_open_kfid, source_external_userid,
      secret_generation, nonce, ciphertext, auth_tag, api_base_url, status,
      expires_at, last_polled_at, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, 0, '', ?, ?)
  `).run(
    'qo_expired_cleanup',
    'source-expired-cleanup',
    'wk-expired-cleanup',
    'wm-expired-cleanup',
    1,
    'nonce',
    'ciphertext',
    'auth-tag',
    'https://ilinkai.weixin.qq.com/',
    1_500,
    1_000,
    1_000,
  );
  clock.value = 2_000;

  const offers = new IlinkLoginStore({
    store,
    secretBox: new IlinkSecretBox(Buffer.alloc(32, 7).toString('base64url')),
    clock: () => clock.value,
  });
  offers.cleanup();

  assert.equal(store.database.prepare(`
    SELECT 1 FROM ilink_login_offers WHERE offer_id = 'qo_expired_cleanup'
  `).get(), undefined);
  assert.deepEqual({ ...(store.database.prepare(`
    SELECT result, account_key, offered_at, completed_at
    FROM ilink_enrollment_audit WHERE offer_id = 'qo_expired_cleanup'
  `).get() as Record<string, unknown>) }, {
    result: 'expired',
    account_key: '',
    offered_at: 1_000,
    completed_at: 2_000,
  });
});
