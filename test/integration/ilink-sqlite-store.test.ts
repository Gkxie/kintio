import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  IlinkSqliteStoreError,
  type IlinkPollPageEntry,
} from '../../src/ilink/sqlite-store.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
  type IlinkMessage,
} from '../../src/ilink/protocol/types.ts';
import {
  normalizeIlinkInboundMessage,
  type IlinkNormalizedInbound,
} from '../../src/ilink/message.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import {
  stableClientMessageId,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

const botId = 'bot@im.bot';
const ownerPeerId = 'owner@im.wechat';
const accountKey = createIlinkAccountKey(botId);
const baseUrl = 'https://ilinkai.weixin.qq.com/';
const configuredSecretKey = Buffer.alloc(32, 7).toString('base64url');

function errorCode(error: unknown, code: string): boolean {
  return error instanceof IlinkSqliteStoreError && error.code === code;
}

function botToken(box: IlinkSecretBox, generation = 1) {
  return box.seal('bot-token', {
    secretKind: 'bot_token',
    accountId: accountKey,
    peerId: ownerPeerId,
    generation,
  });
}

function rawMessage({
  id,
  seq,
  createdAt,
  contextToken,
  text,
}: {
  id: number;
  seq: number;
  createdAt: number;
  contextToken: string;
  text: string;
}): IlinkMessage {
  return {
    message_id: id,
    seq,
    from_user_id: ownerPeerId,
    to_user_id: botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: createdAt,
    context_token: contextToken,
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text },
    }],
  };
}

function candidate(
  message: IlinkMessage,
  cursor: string,
  index: number,
): IlinkNormalizedInbound {
  const result = normalizeIlinkInboundMessage(
    message,
    { accountKey, botId, ownerUserId: ownerPeerId },
    { cursor, index },
  );
  assert.ok(result);
  return result;
}

function pageEntry(
  box: IlinkSecretBox,
  value: IlinkNormalizedInbound,
  secretGeneration: number,
  sync = value.message.sync,
): IlinkPollPageEntry {
  return {
    message: sync === value.message.sync
      ? value.message
      : { ...value.message, sync },
    ...(value.facts.providerSeq === undefined
      ? {}
      : { providerSeq: value.facts.providerSeq }),
    secretGeneration,
    sealedContextToken: box.seal(value.facts.contextToken, {
      secretKind: 'context_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation: secretGeneration,
    }),
  };
}

async function fixture(testContext: Parameters<typeof createTempSqlite>[0]) {
  const temp = await createTempSqlite(testContext, {
    prefix: 'kintio-ilink-store-',
  });
  let now = 1_800_000_000_000;
  const clock = () => now;
  const persistence = temp.openInjectedPersistenceForTest({ clock });
  const store = persistence.core;
  const ilink = persistence.createIlinkStore({ clock });
  const box = new IlinkSecretBox(configuredSecretKey);
  const advance = (milliseconds = 1) => {
    now += milliseconds;
    return now;
  };
  return {
    store,
    ilink,
    database: persistence.database,
    box,
    advance,
    now: () => now,
  };
}

test('registers one-to-one encrypted accounts and fences cursor generations', async (t) => {
  const { store, ilink, box, advance, now } = await fixture(t);
  const registered = ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  assert.equal(registered.accountKey, accountKey);
  assert.equal(registered.generation, 1);
  assert.equal(registered.runtimeEnabled, false);
  assert.deepEqual(ilink.listActiveAccounts(), [registered]);

  const stored = ilink.getAccountWithSecret(accountKey);
  assert.ok(stored);
  assert.equal(
    box.open(stored.secret.sealedBotToken, {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation: stored.secret.accountGeneration,
    }),
    'bot-token',
  );
  assert.equal(ilink.listActiveAccountsWithSecrets().length, 1);
  const missingKey = createIlinkAccountKey('missing@im.bot');
  assert.equal(ilink.getAccount(missingKey), undefined);
  assert.equal(ilink.getAccountSecret(missingKey), undefined);
  assert.equal(ilink.getAccountWithSecret(missingKey), undefined);
  assert.equal(ilink.getReplyWindow(999), undefined);
  assert.throws(
    () => ilink.registerAccount({
      providerAccountId: botId,
      ownerPeerId,
      baseUrl,
      encryptedBotToken: botToken(box),
      now: advance(),
    }),
    (error: unknown) => errorCode(error, 'account_exists'),
  );

  assert.deepEqual(ilink.compareAndSetCursor({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-0',
    now: advance(),
  }), {
    accountKey,
    accountGeneration: 1,
    cursor: 'cursor-0',
    updatedAt: now(),
  });
  assert.throws(
    () => ilink.compareAndSetCursor({
      accountKey,
      expectedGeneration: 1,
      expectedCursor: '',
      nextCursor: 'stale-write',
      now: advance(),
    }),
    (error: unknown) => errorCode(error, 'cursor_conflict'),
  );

  const rotated = ilink.rotateAccount({
    accountKey,
    expectedGeneration: 1,
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box, 2),
    now: advance(),
  });
  assert.equal(rotated.generation, 2);
  assert.equal(ilink.getCursor(accountKey)?.cursor, 'cursor-0');
  assert.equal(ilink.getAccountSecret(accountKey)?.accountGeneration, 2);
  assert.throws(
    () => ilink.compareAndSetCursor({
      accountKey,
      expectedGeneration: 1,
      expectedCursor: 'cursor-0',
      nextCursor: 'old-listener',
      now: advance(),
    }),
    (error: unknown) => errorCode(error, 'generation_conflict'),
  );

  assert.throws(
    () => ilink.registerAccount({
      providerAccountId: 'other-bot@im.bot',
      ownerPeerId,
      baseUrl,
      encryptedBotToken: botToken(box, 1),
      now: advance(),
    }),
    (error: unknown) => errorCode(error, 'owner_conflict'),
  );
  const reactivated = ilink.rotateAccount({
    accountKey,
    expectedGeneration: 2,
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box, 3),
    now: advance(),
  });
  assert.equal(reactivated.status, 'active');
  assert.equal(reactivated.generation, 3);
  assert.equal(reactivated.runtimeEnabled, false);
  assert.ok(ilink.getAccountSecret(accountKey));
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('login starts no listener; standalone selection is exclusive and runtime start is additive', async (t) => {
  const { ilink, box, now, advance } = await fixture(t);
  const first = ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const secondBotId = 'second-bot@im.bot';
  const secondOwner = 'second-owner@im.wechat';
  const secondKey = createIlinkAccountKey(secondBotId);
  const second = ilink.registerAccount({
    providerAccountId: secondBotId,
    ownerPeerId: secondOwner,
    baseUrl,
    encryptedBotToken: box.seal('second-token', {
      secretKind: 'bot_token',
      accountId: secondKey,
      peerId: secondOwner,
      generation: 1,
    }),
    now: advance(),
  });
  assert.equal(first.runtimeEnabled, false);
  assert.equal(second.runtimeEnabled, false);
  assert.deepEqual(ilink.listRuntimeAccountsWithSecrets(), []);

  ilink.selectRuntimeAccount(secondKey, advance());
  assert.deepEqual(
    ilink.listRuntimeAccountsWithSecrets().map(({ account }) => account.accountKey),
    [secondKey],
  );
  ilink.setRuntimeEnabled(accountKey, true, advance());
  assert.deepEqual(
    ilink.listRuntimeAccountsWithSecrets().map(({ account }) => account.accountKey),
    [accountKey, secondKey],
  );
  ilink.setRuntimeEnabled(secondKey, false, advance());
  assert.deepEqual(
    ilink.listRuntimeAccountsWithSecrets().map(({ account }) => account.accountKey),
    [accountKey],
  );
});

test('deleting an account purges every account-scoped Kintio row atomically', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const otherBotId = 'preserved-bot@im.bot';
  const otherOwner = 'preserved-owner@im.wechat';
  const otherKey = createIlinkAccountKey(otherBotId);
  ilink.registerAccount({
    providerAccountId: otherBotId,
    ownerPeerId: otherOwner,
    baseUrl,
    encryptedBotToken: box.seal('preserved-token', {
      secretKind: 'bot_token', accountId: otherKey,
      peerId: otherOwner, generation: 1,
    }),
    now: now() + 1,
  });
  database.prepare(`
    INSERT INTO sync_cursors (open_kfid, cursor, updated_at)
    VALUES (?, 'cross-channel-cursor', ?)
  `).run(accountKey, now());
  database.prepare(`
    INSERT INTO conversations (
      channel, open_kfid, external_userid, thread_id, memory_thread_id, updated_at
    ) VALUES ('wechat_kf', ?, 'cross-channel-user', 'cross-channel-thread', '', ?)
  `).run(accountKey, now());
  const inbound = candidate(rawMessage({
    id: 71,
    seq: 71,
    createdAt: now(),
    contextToken: 'delete-context',
    text: 'delete everything',
  }), '', 0);
  const committed = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'delete-cursor',
    messages: [pageEntry(box, inbound, 71)],
  });
  const messageKey = committed.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey });
  store.setConversationThread({
    channel: 'weixin_ilink',
    accountKey,
    peerId: ownerPeerId,
    threadId: 'thread-to-delete',
  });
  store.rememberInboundMedia({
    messageKey,
    attachments: [{ kind: 'image', mediaId: 'ilink:0', filename: 'input.png' }],
  });
  const session = store.createAgentSession({ messageKey });
  store.registerAgentArtifact({
    sessionToken: session.token,
    bytes: Buffer.from('89504e470d0a1a0a0909090a', 'hex'),
    filename: 'output.png',
    contentType: 'image/png',
  });
  const attempt = ilink.reserveReplyAttempt({
    sessionToken: session.token,
    sentType: 'text',
    payload: { text: 'pending send' },
  });
  database.prepare(`
    INSERT INTO delivery_failures (
      wecom_msgid, fail_type, observed_at, matched_attempt_key, matched_at
    ) VALUES ('purged-failure', 13, ?, ?, ?)
  `).run(now(), attempt.attemptId, now());
  database.prepare(`
    INSERT INTO ilink_enrollment_audit (
      offer_id, initiator_kind, source_channel, source_message_key,
      source_account_id, source_peer_id, account_key, result,
      offered_at, completed_at
    ) VALUES (?, 'local_operator', 'terminal', '', 'local', 'operator', ?,
      'confirmed', ?, ?)
  `).run(`qo_${'d'.repeat(20)}`, accountKey, now(), now());
  database.prepare(`
    INSERT INTO ilink_enrollment_audit (
      offer_id, initiator_kind, source_channel, source_message_key,
      source_account_id, source_peer_id, account_key, result,
      offered_at, completed_at
    ) VALUES (?, 'remote_adapter', 'wechat_kf', '', ?, 'cross-channel-user', ?,
      'confirmed', ?, ?)
  `).run(`qo_${'f'.repeat(20)}`, accountKey, otherKey, now(), now());
  database.prepare(`
    INSERT INTO ilink_login_offers (
      offer_id, initiator_kind, source_channel, source_message_key,
      source_account_id, source_peer_id, candidate_account_keys_json,
      secret_generation, nonce, ciphertext, auth_tag, api_base_url,
      status, expires_at, created_at, updated_at
    ) VALUES (?, 'remote_adapter', 'wechat_kf', '', ?, 'cross-channel-user', ?,
      1, 'nonce', 'ciphertext', 'tag', ?, 'waiting', ?, ?, ?)
  `).run(
    `qo_${'e'.repeat(20)}`,
    accountKey,
    JSON.stringify([accountKey, otherKey]),
    baseUrl,
    now() + 300_000,
    now(),
    now(),
  );

  const deleted = ilink.deleteAccountCompletely(accountKey, now() + 2);
  assert.equal(deleted.status, 'revoked');
  assert.equal(deleted.runtimeEnabled, false);
  assert.equal(ilink.getAccount(accountKey), undefined);
  assert.ok(ilink.getAccountWithSecret(otherKey));
  for (const [table, predicate] of [
    ['ilink_accounts', 'account_key = ?'],
    ['ilink_account_secrets', 'account_key = ?'],
    ['ilink_reply_windows', 'account_key = ?'],
    ['ilink_inbound_images', 'account_key = ?'],
    ['inbound_messages', "channel = 'weixin_ilink' AND open_kfid = ?"],
    ['inbound_media', "channel = 'weixin_ilink' AND open_kfid = ?"],
    ['agent_sessions', "channel = 'weixin_ilink' AND open_kfid = ?"],
    ['send_attempts', "channel = 'weixin_ilink' AND open_kfid = ?"],
    ['conversations', "channel = 'weixin_ilink' AND open_kfid = ?"],
    ['ilink_enrollment_audit', 'account_key = ?'],
  ] as const) {
    const count = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}
    `).get(accountKey) as { count: number }).count);
    assert.equal(count, 0, `${table} retained account-scoped rows`);
  }
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM agent_artifacts
  `).get() as { count: number }).count), 0);
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM delivery_failures
    WHERE matched_attempt_key = ?
  `).get(attempt.attemptId) as { count: number }).count), 0);
  const candidates = String((database.prepare(`
    SELECT candidate_account_keys_json FROM ilink_login_offers
  `).get() as { candidate_account_keys_json: string }).candidate_account_keys_json);
  assert.deepEqual(JSON.parse(candidates), [otherKey]);
  assert.equal(String((database.prepare(`
    SELECT cursor FROM sync_cursors WHERE open_kfid = ?
  `).get(accountKey) as { cursor: string }).cursor), 'cross-channel-cursor');
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM conversations
    WHERE channel = 'wechat_kf' AND open_kfid = ?
  `).get(accountKey) as { count: number }).count), 1);
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM ilink_enrollment_audit WHERE account_key = ?
  `).get(otherKey) as { count: number }).count), 1);
  assert.deepEqual(store.foreignKeyCheck(), []);
  assert.throws(
    () => ilink.deleteAccountCompletely(accountKey),
    (error: unknown) => errorCode(error, 'account_not_found'),
  );
});

test('commits cursor, inbox, encrypted windows, and out-of-order ordering atomically', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  ilink.compareAndSetCursor({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-0',
  });
  const newerRaw = rawMessage({
    id: 20,
    seq: 20,
    createdAt: now() - 10_000,
    contextToken: 'context-new',
    text: 'new',
  });
  newerRaw.item_list?.push({
    type: IlinkMessageItemType.IMAGE,
    image_item: {
      media: {
        full_url:
          'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=newest',
        aes_key: Buffer.alloc(16, 9).toString('base64'),
      },
    },
  });
  const newer = candidate(newerRaw, 'cursor-0', 0);
  const olderRaw = rawMessage({
    id: 10,
    seq: 10,
    createdAt: now() - 20_000,
    contextToken: 'context-old',
    text: 'old',
  });
  for (let index = 0; index < 4; index += 1) {
    olderRaw.item_list?.push({
      type: IlinkMessageItemType.IMAGE,
      image_item: {
        media: {
          full_url:
            `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=older-${index}`,
          aes_key: Buffer.alloc(16, index + 1).toString('base64'),
        },
      },
    });
  }
  const older = candidate(olderRaw, 'cursor-0', 1);

  const committed = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-0',
    nextCursor: 'cursor-1',
    messages: [
      {
        ...pageEntry(box, newer, 20),
        sealedImages: newer.facts.images.map((image) => ({
          position: image.position,
          secretGeneration: 2_020 + image.position,
          sealedLocator: box.seal(JSON.stringify({
            downloadUrl: image.downloadUrl,
            aesKey: image.aesKey,
          }), {
            secretKind: 'media_locator', accountId: accountKey,
            peerId: ownerPeerId, generation: 2_020 + image.position,
          }),
        })),
      },
      {
        ...pageEntry(box, older, 10),
        sealedImages: older.facts.images.map((image) => ({
          position: image.position,
          secretGeneration: 1_010 + image.position,
          sealedLocator: box.seal(JSON.stringify({
            downloadUrl: image.downloadUrl,
            aesKey: image.aesKey,
          }), {
            secretKind: 'media_locator', accountId: accountKey,
            peerId: ownerPeerId, generation: 1_010 + image.position,
          }),
        })),
      },
    ],
  });
  assert.equal(committed.insertedMessageKeys.length, 1);
  assert.equal(committed.replyWindowIds.length, 2);
  assert.equal(committed.cursor, 'cursor-1');

  const inbox = database.prepare(`
    SELECT message_key, open_kfid, external_userid, channel, status, payload_json
    FROM inbound_messages ORDER BY inbox_seq
  `).all() as Array<{
    message_key: string;
    open_kfid: string;
    external_userid: string;
    channel: string;
    status: string;
    payload_json: string | null;
  }>;
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every((row) =>
    row.open_kfid === accountKey &&
    row.external_userid === ownerPeerId &&
    row.channel === 'weixin_ilink'));
  assert.ok(inbox.every((row) => !String(row.payload_json).includes('context-')));
  assert.deepEqual(inbox.map((row) => row.status).sort(), ['absorbed', 'received']);
  const received = inbox.find((row) => row.status === 'received');
  assert.ok(received?.payload_json);
  const receivedPayload = JSON.parse(received.payload_json);
  assert.match(receivedPayload.summary, /old[\s\S]*new[\s\S]*attached the latest 4 of 5/u);
  assert.equal(receivedPayload.attachments.length, 4);
  assert.equal(receivedPayload.attachments[0].mediaId, 'ilink:0');
  const newestImage = ilink.getInboundImageSecret(received.message_key, 0);
  assert.ok(newestImage);
  const newestLocator = JSON.parse(box.open(newestImage.sealedLocator, {
    secretKind: 'media_locator', accountId: accountKey,
    peerId: ownerPeerId, generation: newestImage.secretGeneration,
  }));
  assert.match(newestLocator.downloadUrl, /newest/u);

  const windows = database.prepare(`
    SELECT reply_window_id, source_message_key, provider_seq, state
    FROM ilink_reply_windows ORDER BY provider_seq DESC
  `).all() as Array<{
    source_message_key: string;
    reply_window_id: number;
    provider_seq: number;
    state: string;
  }>;
  assert.deepEqual(windows.map((window) => [window.provider_seq, window.state]), [
    [20, 'open'],
    [10, 'superseded'],
  ]);
  assert.equal(ilink.getReplyWindowSecret(windows[1]!.reply_window_id), undefined);
  const open = windows[0];
  assert.ok(open);
  const openWindowId = Number((database.prepare(`
    SELECT reply_window_id FROM ilink_reply_windows
    WHERE source_message_key = ?
  `).get(open.source_message_key) as { reply_window_id: number }).reply_window_id);
  const secret = ilink.getReplyWindowSecret(openWindowId);
  assert.ok(secret);
  assert.equal(secret.secretGeneration, 20);
  assert.equal(
    box.open(secret.sealedContextToken, {
      secretKind: 'context_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation: secret.secretGeneration,
    }),
    'context-new',
  );
  const newestMessageKey = committed.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey: newestMessageKey });
  const newestSession = store.createAgentSession({ messageKey: newestMessageKey });
  assert.equal(store.getAgentSession(newestSession.token).replyWindowId, openWindowId);

  const duplicate = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-1',
    nextCursor: 'cursor-2',
    messages: [{
      ...pageEntry(box, newer, 20, { cursor: 'cursor-1', index: 0 }),
      sealedImages: newer.facts.images.map((image) => ({
        position: image.position,
        secretGeneration: 2_020 + image.position,
        sealedLocator: box.seal(JSON.stringify({
          downloadUrl: image.downloadUrl,
          aesKey: image.aesKey,
        }), {
          secretKind: 'media_locator', accountId: accountKey,
          peerId: ownerPeerId, generation: 2_020 + image.position,
        }),
      })),
    }],
  });
  assert.deepEqual(duplicate.insertedMessageKeys, []);
  assert.deepEqual(duplicate.replyWindowIds, []);
  assert.equal(ilink.getCursor(accountKey)?.cursor, 'cursor-2');
  const lateOlder = candidate(rawMessage({
    id: 5,
    seq: 5,
    createdAt: now() - 30_000,
    contextToken: 'context-late-old',
    text: 'late old',
  }), 'cursor-2', 0);
  const late = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-2',
    nextCursor: 'cursor-3',
    messages: [pageEntry(box, lateOlder, 5)],
  });
  assert.deepEqual(late.insertedMessageKeys, []);
  assert.equal(store.getAgentSession(newestSession.token).replyWindowId, openWindowId);
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM ilink_reply_windows
  `).get() as { count: number }).count), 3);
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('pair or generation failures roll back cursor, inbox, and reply windows', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  ilink.compareAndSetCursor({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-0',
  });
  const valid = candidate(rawMessage({
    id: 1,
    seq: 1,
    createdAt: now(),
    contextToken: 'context-1',
    text: 'hello',
  }), 'cursor-0', 0);
  const wrongPeer = {
    ...valid,
    message: {
      ...valid.message,
      conversation: {
        ...valid.message.conversation,
        peerId: 'other@im.wechat',
      },
    },
  };
  assert.throws(
    () => ilink.commitPollPage({
      accountKey,
      expectedGeneration: 1,
      expectedCursor: 'cursor-0',
      nextCursor: 'cursor-1',
      messages: [pageEntry(box, wrongPeer, 1)],
    }),
    (error: unknown) => errorCode(error, 'pair_mismatch'),
  );
  assert.equal(ilink.getCursor(accountKey)?.cursor, 'cursor-0');
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM inbound_messages
  `).get() as { count: number }).count), 0);
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM ilink_reply_windows
  `).get() as { count: number }).count), 0);

  assert.throws(
    () => ilink.commitPollPage({
      accountKey,
      expectedGeneration: 2,
      expectedCursor: 'cursor-0',
      nextCursor: 'cursor-1',
      messages: [pageEntry(box, valid, 1)],
    }),
    (error: unknown) => errorCode(error, 'generation_conflict'),
  );
  assert.equal(ilink.getCursor(accountKey)?.cursor, 'cursor-0');
  const future = candidate(rawMessage({
    id: 2,
    seq: 2,
    createdAt: now() + 6 * 60 * 1_000,
    contextToken: 'future-context',
    text: 'future',
  }), 'cursor-0', 0);
  assert.throws(
    () => ilink.commitPollPage({
      accountKey,
      expectedGeneration: 1,
      expectedCursor: 'cursor-0',
      nextCursor: 'future-cursor',
      messages: [pageEntry(box, future, 2)],
    }),
    (error: unknown) => errorCode(error, 'invalid_input'),
  );
  assert.equal(ilink.getCursor(accountKey)?.cursor, 'cursor-0');
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM inbound_messages
  `).get() as { count: number }).count), 0);
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM ilink_reply_windows
  `).get() as { count: number }).count), 0);
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('same-millisecond client IDs use delivery order when upstream seq is absent', async (t) => {
  const { ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId, ownerPeerId, baseUrl,
    encryptedBotToken: botToken(box), now: now(),
  });
  const withoutSequence = (clientId: string, text: string): IlinkMessage => {
    const message = rawMessage({
      id: 1, seq: 1, createdAt: now(), contextToken: `context-${clientId}`, text,
    });
    delete message.message_id;
    delete message.seq;
    message.client_id = clientId;
    return message;
  };
  const first = candidate(withoutSequence('client-a', 'first'), '', 0);
  const second = candidate(withoutSequence('client-b', 'second'), '', 1);
  ilink.commitPollPage({
    accountKey, expectedGeneration: 1, expectedCursor: '', nextCursor: 'same-ms',
    messages: [
      pageEntry(box, first, 1),
      pageEntry(box, second, 2),
    ],
  });
  const open = database.prepare(`
    SELECT inbound.msgid FROM ilink_reply_windows AS window
    JOIN inbound_messages AS inbound ON inbound.message_key = window.source_message_key
    WHERE window.state = 'open'
  `).get() as { msgid: string };
  assert.equal(open.msgid, second.message.providerMessageId);

  const late = candidate(withoutSequence('client-late', 'late'), 'same-ms', 0);
  ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'same-ms',
    nextCursor: 'same-ms-late',
    messages: [pageEntry(box, late, 3)],
  });
  const stillOpen = database.prepare(`
    SELECT inbound.msgid FROM ilink_reply_windows AS window
    JOIN inbound_messages AS inbound ON inbound.message_key = window.source_message_key
    WHERE window.state = 'open'
  `).get() as { msgid: string };
  assert.equal(stillOpen.msgid, second.message.providerMessageId);

  const incomparable = candidate(rawMessage({
    id: 99,
    seq: 99,
    createdAt: now(),
    contextToken: 'context-incomparable-seq',
    text: 'late sequence without a comparable predecessor',
  }), 'same-ms-late', 0);
  ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'same-ms-late',
    nextCursor: 'same-ms-incomparable',
    messages: [pageEntry(box, incomparable, 4)],
  });
  const finalOpen = database.prepare(`
    SELECT inbound.msgid FROM ilink_reply_windows AS window
    JOIN inbound_messages AS inbound ON inbound.message_key = window.source_message_key
    WHERE window.state = 'open'
  `).get() as { msgid: string };
  assert.equal(finalOpen.msgid, second.message.providerMessageId);
});

test('startup backlog stays deferred and is absorbed into the next live direction', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const old = candidate(rawMessage({
    id: 30,
    seq: 30,
    createdAt: now() - 10_000,
    contextToken: 'context-old-backlog',
    text: 'old backlog',
  }), '', 0);
  const backlog = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'after-backlog',
    deferredBefore: now(),
    messages: [pageEntry(box, old, 30)],
  });
  assert.deepEqual(backlog.insertedMessageKeys, []);
  assert.equal(backlog.deferredMessageCount, 1);
  assert.equal(Number((database.prepare(`
    SELECT deferred FROM inbound_messages WHERE msgid = 'message:30'
  `).get() as { deferred: number }).deferred), 1);

  const newerBacklog = candidate(rawMessage({
    id: 31,
    seq: 31,
    createdAt: now() - 5_000,
    contextToken: 'context-newer-backlog',
    text: 'newer backlog',
  }), 'after-backlog', 0);
  const mergedBacklog = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'after-backlog',
    nextCursor: 'after-second-backlog',
    deferredBefore: now(),
    messages: [pageEntry(box, newerBacklog, 31)],
  });
  assert.deepEqual(mergedBacklog.insertedMessageKeys, []);
  assert.equal(mergedBacklog.deferredMessageCount, 1);
  assert.equal(
    store.getInbound(stableMessageKey('weixin_ilink', accountKey, 'message:30'))?.status,
    'absorbed',
  );

  const live = candidate(rawMessage({
    id: 32,
    seq: 32,
    createdAt: now(),
    contextToken: 'context-live',
    text: 'live direction',
  }), 'after-second-backlog', 0);
  const promoted = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'after-second-backlog',
    nextCursor: 'after-live',
    deferredBefore: now(),
    messages: [pageEntry(box, live, 32)],
  });
  assert.equal(promoted.insertedMessageKeys.length, 1);
  const rows = database.prepare(`
    SELECT msgid, status, deferred, payload_json
    FROM inbound_messages ORDER BY inbox_seq
  `).all() as Array<{
    msgid: string; status: string; deferred: number; payload_json: string | null;
  }>;
  assert.deepEqual(rows.map(({ msgid, status, deferred }) => ({ msgid, status, deferred })), [
    { msgid: 'message:30', status: 'absorbed', deferred: 0 },
    { msgid: 'message:31', status: 'absorbed', deferred: 0 },
    { msgid: 'message:32', status: 'received', deferred: 0 },
  ]);
  assert.equal(
    JSON.parse(rows[2]!.payload_json!).summary,
    'old backlog\nnewer backlog\nlive direction',
  );
});

test('iLink image locators are encrypted and retained while their inbox is actionable', async (t) => {
  const { store, ilink, database, box, now, advance } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const aesKey = Buffer.alloc(16, 8);
  const raw = rawMessage({
    id: 40, seq: 40, createdAt: now(), contextToken: 'context-image', text: '',
  });
  raw.item_list = [{
    type: IlinkMessageItemType.IMAGE,
    image_item: {
      media: {
        full_url:
          'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=image',
        aes_key: aesKey.toString('base64'),
      },
    },
  }];
  const image = candidate(raw, '', 0);
  assert.equal(image.facts.images.length, 1);
  const imageGeneration = 4_040;
  const committed = ilink.commitPollPage({
    accountKey, expectedGeneration: 1, expectedCursor: '', nextCursor: 'image-cursor',
    messages: [{
      ...pageEntry(box, image, 40),
      sealedImages: [{
        position: 0,
        secretGeneration: imageGeneration,
        sealedLocator: box.seal(JSON.stringify({
          downloadUrl: image.facts.images[0]!.downloadUrl,
          aesKey: image.facts.images[0]!.aesKey,
        }), {
          secretKind: 'media_locator',
          accountId: accountKey,
          peerId: ownerPeerId,
          generation: imageGeneration,
        }),
      }],
    }],
  });
  const messageKey = committed.insertedMessageKeys[0]!;
  const payload = String((database.prepare(`
    SELECT payload_json FROM inbound_messages WHERE message_key = ?
  `).get(messageKey) as { payload_json: string }).payload_json);
  for (const secret of [
    'novac2c', 'encrypted_query_param', aesKey.toString('base64url'),
  ]) {
    assert.equal(payload.includes(secret), false);
  }
  assert.match(payload, /ilink:0/u);
  const stored = ilink.getInboundImageSecret(messageKey, 0);
  assert.ok(stored);
  assert.deepEqual(
    JSON.parse(box.open(stored.sealedLocator, {
      secretKind: 'media_locator', accountId: accountKey,
      peerId: ownerPeerId, generation: imageGeneration,
    })),
    {
      downloadUrl: image.facts.images[0]!.downloadUrl,
      aesKey: image.facts.images[0]!.aesKey,
    },
  );
  const followup = candidate(rawMessage({
    id: 41,
    seq: 41,
    createdAt: now() + 1,
    contextToken: 'context-after-image',
    text: 'use the earlier image',
  }), 'image-cursor', 0);
  const merged = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'image-cursor',
    nextCursor: 'after-image-cursor',
    messages: [pageEntry(box, followup, 41)],
  });
  const mergedKey = merged.insertedMessageKeys[0]!;
  assert.equal(store.getInbound(messageKey)?.status, 'absorbed');
  assert.equal(ilink.getInboundImageSecret(messageKey, 0), undefined);
  assert.ok(ilink.getInboundImageSecret(mergedKey, 0));
  assert.match(JSON.stringify(store.getInbound(mergedKey)?.payload), /ilink:0/u);
  advance(4 * 24 * 60 * 60 * 1_000);
  store.cleanup({ mediaMaxAgeMs: 3 * 24 * 60 * 60 * 1_000 });
  assert.ok(ilink.getInboundImageSecret(mergedKey, 0));
  store.markInboundIgnored(mergedKey);
  store.cleanup({ mediaMaxAgeMs: 3 * 24 * 60 * 60 * 1_000 });
  assert.equal(ilink.getInboundImageSecret(mergedKey, 0), undefined);
});

test('reply reservations atomically enforce quota and one in-flight send', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  ilink.compareAndSetCursor({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'cursor-0',
  });
  const inbound = candidate(rawMessage({
    id: 7,
    seq: 7,
    createdAt: now(),
    contextToken: 'context-7',
    text: 'hello',
  }), 'cursor-0', 0);
  ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-0',
    nextCursor: 'cursor-1',
    messages: [pageEntry(box, inbound, 7)],
  });
  const source = database.prepare(`
    SELECT message_key FROM inbound_messages LIMIT 1
  `).get() as { message_key: string };
  store.claimInbound({ messageKey: source.message_key });
  const session = store.createAgentSession({ messageKey: source.message_key });

  const first = ilink.reserveReplyAttempt({
    sessionToken: session.token,
    sentType: 'text',
    payload: { msg: { text: 'one' } },
  });
  const second = ilink.reserveReplyAttempt({
    sessionToken: session.token,
    sentType: 'text',
    payload: { msg: { text: 'two' } },
  });
  assert.equal(first.sendIndex, 0);
  assert.equal(second.sendIndex, 1);
  assert.equal(ilink.startReplyAttempt({
    sessionToken: session.token,
    attemptId: first.attemptId,
  }).status, 'sending');
  assert.throws(
    () => ilink.startReplyAttempt({
      sessionToken: session.token,
      attemptId: second.attemptId,
    }),
    (error: unknown) => errorCode(error, 'send_in_progress'),
  );
  store.markSendUncertain(first.attemptId, new Error('network outcome unknown'));
  assert.equal(ilink.startReplyAttempt({
    sessionToken: session.token,
    attemptId: second.attemptId,
  }).status, 'sending');

  for (let index = 2; index < 10; index += 1) {
    const attempt = ilink.reserveReplyAttempt({
      sessionToken: session.token,
      sentType: 'text',
      payload: { msg: { text: String(index) } },
    });
    assert.equal(attempt.sendIndex, index);
  }
  assert.throws(
    () => ilink.reserveReplyAttempt({
      sessionToken: session.token,
      sentType: 'text',
      payload: { msg: { text: 'eleven' } },
    }),
    (error: unknown) => errorCode(error, 'reply_quota_exhausted'),
  );
  const window = ilink.getReplyWindow(session.replyWindowId);
  assert.ok(window);
  assert.equal(window.reservedSendCount, 8);
  assert.equal(window.transmittedSendCount, 2);
  assert.equal(window.nextSendIndex, 10);
  assert.equal(ilink.recoverPendingAttempts(), 8);
  const recovered = ilink.getReplyWindow(session.replyWindowId);
  assert.equal(recovered?.reservedSendCount, 0);
  assert.equal(recovered?.transmittedSendCount, 2);
  assert.equal(recovered?.nextSendIndex, 10);
  const afterRecovery = ilink.reserveReplyAttempt({
    sessionToken: session.token,
    sentType: 'text',
    payload: { msg: { text: 'after recovery' } },
  });
  assert.equal(afterRecovery.sendIndex, 10);
  assert.equal(ilink.getReplyWindow(session.replyWindowId)?.nextSendIndex, 11);
  store.markSendUncertain(second.attemptId, new Error('second outcome unknown'));
  assert.equal(ilink.releasePendingAttempt(afterRecovery.attemptId), true);
  const allAttempts = store.listMessageAttempts(source.message_key);
  assert.equal(allAttempts.length, 11);
  assert.equal(store.finalizeAgentExecution({
    messageKey: source.message_key,
    attemptIds: allAttempts.map((attempt) => attempt.attemptId),
  }).status, 'completed');
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('one primary can finalize attempts from separate ten-send token generations', async (t) => {
  const { store, ilink, database, box, now } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const first = candidate(rawMessage({
    id: 50, seq: 50, createdAt: now() - 1_000,
    contextToken: 'context-50', text: 'first',
  }), '', 0);
  const firstPage = ilink.commitPollPage({
    accountKey, expectedGeneration: 1, expectedCursor: '', nextCursor: 'cursor-50',
    messages: [pageEntry(box, first, 50)],
  });
  const primary = firstPage.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey: primary });
  const second = candidate(rawMessage({
    id: 51, seq: 51, createdAt: now(),
    contextToken: 'context-51', text: 'second',
  }), 'cursor-50', 0);
  const secondPage = ilink.commitPollPage({
    accountKey, expectedGeneration: 1, expectedCursor: 'cursor-50',
    nextCursor: 'cursor-51', messages: [pageEntry(box, second, 51)],
  });
  const followup = secondPage.insertedMessageKeys[0]!;
  store.beginInboundSteering({
    messageKey: followup,
    primaryMessageKey: primary,
    clientInputId: followup,
  });
  store.confirmInboundSteered(followup, { codexTurnId: 'turn-51' });
  const windows = database.prepare(`
    SELECT reply_window_id FROM ilink_reply_windows ORDER BY source_inbox_seq
  `).all() as Array<{ reply_window_id: number }>;
  assert.equal(windows.length, 2);
  const attemptIds: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const attemptId = `sa_cross_window_${index}`;
    attemptIds.push(attemptId);
    database.prepare(`
      INSERT INTO send_attempts (
        attempt_key, source_message_key, open_kfid, external_userid,
        channel, reply_window_id, send_index, source, sent_type,
        fingerprint, client_message_id, status, wecom_msgid,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'weixin_ilink', ?, ?, 'mcp_tool', 'text',
                ?, ?, 'accepted', ?, ?, ?)
    `).run(
      attemptId,
      primary,
      accountKey,
      ownerPeerId,
      index === 0 ? windows[0]!.reply_window_id : windows[1]!.reply_window_id,
      index,
      `fingerprint-${index}`,
      stableClientMessageId(primary, index),
      `ilink-provider-${index}`,
      now(),
      now(),
    );
  }
  const finalized = store.finalizeAgentExecution({
    messageKey: primary,
    steeringMessageKeys: [followup],
    attemptIds,
  });
  assert.equal(finalized.status, 'completed');
  assert.equal(store.getInbound(followup)?.status, 'absorbed');
});

test('expired reply-window keeps its audit row until the recoverable inbound terminates', async (t) => {
  const { store, ilink, box, now, advance } = await fixture(t);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId,
    baseUrl,
    encryptedBotToken: botToken(box),
    now: now(),
  });
  const inbound = candidate(rawMessage({
    id: 60, seq: 60, createdAt: now(), contextToken: 'context-60', text: 'expire',
  }), '', 0);
  const committed = ilink.commitPollPage({
    accountKey, expectedGeneration: 1, expectedCursor: '', nextCursor: 'cursor-60',
    messages: [pageEntry(box, inbound, 60)],
  });
  const windowId = committed.replyWindowIds[0]!;
  assert.ok(ilink.getReplyWindowSecret(windowId));
  const messageKey = committed.insertedMessageKeys[0]!;
  const window = ilink.getReplyWindow(windowId)!;
  advance(window.expiresAt - now());
  assert.throws(
    () => ilink.reserveStartedSystemAttempt({
      messageKey,
      sentType: 'text',
      payload: { content: 'expired' },
      source: 'expiry-test',
    }),
    (error: unknown) => errorCode(error, 'reply_window_expired'),
  );
  store.cleanup({ acceptedAuditMaxAgeMs: 1 });
  assert.equal(ilink.getReplyWindowSecret(windowId), undefined);
  assert.equal(ilink.getReplyWindow(windowId)?.state, 'open');
  store.suppressInbound(messageKey, 'reply_window_expired');
  store.cleanup({ acceptedAuditMaxAgeMs: 1 });
  assert.equal(ilink.getReplyWindow(windowId)?.state, 'closed');
  advance(2);
  assert.equal(store.cleanup({ acceptedAuditMaxAgeMs: 1 }).ilinkReplyWindows, 1);
  assert.equal(ilink.getReplyWindow(windowId), undefined);
});
