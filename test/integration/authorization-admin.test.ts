import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.js';
import { SqliteStore } from '../../src/state/sqlite-store.js';
import { inspectAttempts } from '../support/sqlite-inspect.js';

test('[A05] revocation is global and resets authorization progress', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-admin-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  let confirmationKey = '';
  for (let index = 1; index <= 3; index += 1) {
    const message = normalizeWecomMessage({
      msgid: `trigger-${index}`,
      open_kfid: 'wk-a',
      external_userid: 'wm-global',
      origin: 3,
      msgtype: 'text',
      text: { content: '发车' },
    });
    const { insertedMessageKeys } = store.ingestSyncPage({
      openKfId: 'wk-a',
      expectedCursor: index === 1 ? '' : `cursor-${index - 1}`,
      nextCursor: `cursor-${index}`,
      messages: [message],
    });
    store.evaluateAuthorization({
      messageKey: insertedMessageKeys[0]!,
      openKfId: 'wk-a',
      externalUserId: 'wm-global',
      isTrigger: true,
      requiredConsecutive: 3,
    });
    if (index === 3) confirmationKey = insertedMessageKeys[0]!;
  }
  assert.equal(store.getAuthorization('wm-global')?.authorized, true);
  const epoch = store.getConversation('wk-a', 'wm-global')?.automationEpoch;

  const revoked = store.revokeAuthorization('wm-global');
  assert.equal(revoked.authorized, false);
  assert.equal(revoked.consecutiveMatches, 0);
  assert.equal(revoked.lastOpenKfId, '');
  assert.equal(store.getAuthorization('wm-global')?.authorized, false);
  assert.equal(
    store.getConversation('wk-a', 'wm-global')?.automationEpoch,
    Number(epoch) + 1,
  );
  assert.deepEqual(
    inspectAttempts(store.database, confirmationKey).map((attempt) => [
      attempt.status,
      attempt.errorCode,
    ]),
    [['failed', 'authorization_revoked']],
  );
  assert.equal(store.beginNextSend(), undefined);

  const message = normalizeWecomMessage({
    msgid: 'wk-b-trigger',
    open_kfid: 'wk-b',
    external_userid: 'wm-global',
    origin: 3,
    msgtype: 'text',
    text: { content: '发车' },
  });
  const { insertedMessageKeys } = store.ingestSyncPage({
    openKfId: 'wk-b',
    nextCursor: 'cursor-b',
    messages: [message],
  });
  const restarted = store.evaluateAuthorization({
    messageKey: insertedMessageKeys[0]!,
    openKfId: 'wk-b',
    externalUserId: 'wm-global',
    isTrigger: true,
    requiredConsecutive: 3,
  });
  assert.equal(restarted.newlyAuthorized, false);
  assert.equal(restarted.consecutiveMatches, 1);
});
