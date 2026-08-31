import assert from 'node:assert/strict';
import { test, type TestContext } from 'vitest';

import {
  normalizeIlinkInboundMessage,
  type IlinkNormalizedInbound,
} from '../../src/ilink/message.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import {
  IlinkSqliteStore,
  IlinkSqliteStoreError,
  type IlinkPollPageEntry,
} from '../../src/ilink/sqlite-store.ts';
import {
  ILINK_REPLY_WINDOW_LIFETIME_MS,
  createIlinkAccountKey,
  type IlinkAccountKey,
} from '../../src/ilink/store-types.ts';
import {
  stableMessageKey,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const baseUrl = 'https://ilinkai.weixin.qq.com/';
const configuredSecretKey = Buffer.alloc(32, 29).toString('base64url');

interface AccountFixture {
  readonly accountKey: IlinkAccountKey;
  readonly botId: string;
  readonly peerId: string;
}

interface StoreFixture {
  readonly store: CoreState;
  readonly ilink: IlinkSqliteStore;
  readonly box: IlinkSecretBox;
  now(): number;
  advance(milliseconds?: number): number;
}

async function fixture(t: TestContext): Promise<StoreFixture> {
  const temp = await createTempSqlite(t, {
    prefix: 'kintio-ilink-channel-invariants-',
  });
  let currentTime = 1_900_000_000_000;
  const clock = () => currentTime;
  const persistence = temp.openPersistence({ clock });
  const store = persistence.core;
  const ilink = persistence.createIlinkStore({ clock });
  const box = new IlinkSecretBox(configuredSecretKey);
  return {
    store,
    ilink,
    box,
    now: clock,
    advance(milliseconds = 1) {
      currentTime += milliseconds;
      return currentTime;
    },
  };
}

function registerAccount(
  created: StoreFixture,
  botId: string,
  peerId: string,
): AccountFixture {
  const accountKey = createIlinkAccountKey(botId);
  created.ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId: peerId,
    baseUrl,
    encryptedBotToken: created.box.seal(`bot-token:${botId}`, {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId,
      generation: 1,
    }),
    now: created.now(),
  });
  return { accountKey, botId, peerId };
}

function inboundCandidate({
  account,
  providerMessageId,
  seq = providerMessageId,
  createdAt,
  cursor,
  index = 0,
  text = `message-${providerMessageId}`,
}: {
  account: AccountFixture;
  providerMessageId: number;
  seq?: number;
  createdAt: number;
  cursor: string;
  index?: number;
  text?: string;
}): IlinkNormalizedInbound {
  const normalized = normalizeIlinkInboundMessage({
    message_id: providerMessageId,
    seq,
    from_user_id: account.peerId,
    to_user_id: account.botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: createdAt,
    context_token: `context:${account.botId}:${providerMessageId}`,
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text },
    }],
  }, {
    accountKey: account.accountKey,
    botId: account.botId,
    ownerUserId: account.peerId,
  }, {
    cursor,
    index,
  });
  assert.ok(normalized);
  return normalized;
}

function pageEntry(
  created: StoreFixture,
  account: AccountFixture,
  normalized: IlinkNormalizedInbound,
  secretGeneration: number,
): IlinkPollPageEntry {
  return {
    message: normalized.message,
    ...(normalized.facts.providerSeq === undefined
      ? {}
      : { providerSeq: normalized.facts.providerSeq }),
    secretGeneration,
    sealedContextToken: created.box.seal(normalized.facts.contextToken, {
      secretKind: 'context_token',
      accountId: account.accountKey,
      peerId: account.peerId,
      generation: secretGeneration,
    }),
  };
}

function commitMessage(
  created: StoreFixture,
  account: AccountFixture,
  {
    providerMessageId,
    seq = providerMessageId,
    createdAt = created.now(),
    expectedCursor = created.ilink.getCursor(account.accountKey)?.cursor || '',
    nextCursor = `cursor:${account.botId}:${providerMessageId}`,
    text,
  }: {
    providerMessageId: number;
    seq?: number;
    createdAt?: number;
    expectedCursor?: string;
    nextCursor?: string;
    text?: string;
  },
) {
  const normalized = inboundCandidate({
    account,
    providerMessageId,
    seq,
    createdAt,
    cursor: expectedCursor,
    ...(text === undefined ? {} : { text }),
  });
  return created.ilink.commitPollPage({
    accountKey: account.accountKey,
    expectedGeneration: 1,
    expectedCursor,
    nextCursor,
    messages: [pageEntry(created, account, normalized, providerMessageId)],
  });
}

function isIlinkError(error: unknown, code: string): boolean {
  return error instanceof IlinkSqliteStoreError && error.code === code;
}

test('reply-window expiry is absolute from the upstream timestamp', async (t) => {
  const created = await fixture(t);
  const account = registerAccount(
    created,
    'absolute-expiry-bot@im.bot',
    'absolute-expiry-owner@im.wechat',
  );
  const providerCreatedAt = created.now() - 6 * 60 * 60 * 1_000;
  const committed = commitMessage(created, account, {
    providerMessageId: 101,
    createdAt: providerCreatedAt,
  });
  const messageKey = committed.insertedMessageKeys[0]!;
  const window = created.ilink.getReplyWindow(committed.replyWindowIds[0]!);
  assert.ok(window);

  assert.equal(window.issuedAt, providerCreatedAt);
  assert.equal(
    window.expiresAt,
    providerCreatedAt + ILINK_REPLY_WINDOW_LIFETIME_MS,
  );
  assert.equal(
    window.expiresAt < created.now() + ILINK_REPLY_WINDOW_LIFETIME_MS,
    true,
  );

  created.advance(window.expiresAt - created.now() - 1);
  const beforeBoundary = created.ilink.reserveStartedSystemAttempt({
    messageKey,
    sentType: 'text',
    payload: { content: 'last safe millisecond' },
    source: 'absolute-expiry-test',
  });
  assert.equal(beforeBoundary.status, 'sending');

  created.advance(1);
  assert.throws(
    () => created.ilink.reserveStartedSystemAttempt({
      messageKey,
      sentType: 'text',
      payload: { content: 'must not slide the deadline' },
      source: 'absolute-expiry-test',
    }),
    (error: unknown) => isIlinkError(error, 'reply_window_expired'),
  );
  assert.equal(
    created.ilink.getReplyWindow(window.replyWindowId)?.expiresAt,
    providerCreatedAt + ILINK_REPLY_WINDOW_LIFETIME_MS,
  );
});

test('a new token owns fresh quota while an old-window send is in flight', async (t) => {
  const created = await fixture(t);
  const account = registerAccount(
    created,
    'quota-rotation-bot@im.bot',
    'quota-rotation-owner@im.wechat',
  );
  const firstPage = commitMessage(created, account, {
    providerMessageId: 201,
    seq: 201,
    createdAt: created.now() - 1_000,
  });
  const firstMessageKey = firstPage.insertedMessageKeys[0]!;
  const firstWindowId = firstPage.replyWindowIds[0]!;
  created.store.claimInbound({ messageKey: firstMessageKey });
  const firstSession = created.store.createAgentSession({
    messageKey: firstMessageKey,
  });
  const oldSending = created.ilink.reserveReplyAttempt({
    sessionToken: firstSession.token,
    sentType: 'text',
    payload: { content: 'old request already crossing the network' },
  });
  created.ilink.startReplyAttempt({
    sessionToken: firstSession.token,
    attemptId: oldSending.attemptId,
  });
  const oldPending = created.ilink.reserveReplyAttempt({
    sessionToken: firstSession.token,
    sentType: 'text',
    payload: { content: 'old request not transmitted' },
  });

  created.advance(1_000);
  const secondPage = commitMessage(created, account, {
    providerMessageId: 202,
    seq: 202,
    createdAt: created.now(),
  });
  const secondMessageKey = secondPage.insertedMessageKeys[0]!;
  const secondWindowId = secondPage.replyWindowIds[0]!;
  assert.notEqual(secondWindowId, firstWindowId);
  const retiredWindow = created.ilink.getReplyWindow(firstWindowId);
  assert.ok(retiredWindow);
  assert.deepEqual(
    {
      state: retiredWindow.state,
      reservedSendCount: retiredWindow.reservedSendCount,
      transmittedSendCount: retiredWindow.transmittedSendCount,
    },
    {
      state: 'superseded',
      reservedSendCount: 0,
      transmittedSendCount: 1,
    },
  );
  assert.equal(created.store.getAttempt(oldSending.attemptId)?.status, 'sending');
  assert.deepEqual(
    {
      status: created.store.getAttempt(oldPending.attemptId)?.status,
      errorCode: created.store.getAttempt(oldPending.attemptId)?.errorCode,
    },
    {
      status: 'failed',
      errorCode: 'superseded_by_newer_ilink_message',
    },
  );
  assert.throws(
    () => created.store.getAgentSession(firstSession.token),
    /closed/u,
  );

  created.store.claimInbound({ messageKey: secondMessageKey });
  const secondSession = created.store.createAgentSession({
    messageKey: secondMessageKey,
  });
  const newAttempts = Array.from({ length: 10 }, (_, index) =>
    created.ilink.reserveReplyAttempt({
      sessionToken: secondSession.token,
      sentType: 'text',
      payload: { content: `new-window-${index}` },
    })
  );
  const fullNewWindow = created.ilink.getReplyWindow(secondWindowId);
  assert.ok(fullNewWindow);
  assert.deepEqual(
    {
      nextSendIndex: fullNewWindow.nextSendIndex,
      reservedSendCount: fullNewWindow.reservedSendCount,
      transmittedSendCount: fullNewWindow.transmittedSendCount,
    },
    {
      nextSendIndex: 10,
      reservedSendCount: 10,
      transmittedSendCount: 0,
    },
  );
  assert.throws(
    () => created.ilink.reserveReplyAttempt({
      sessionToken: secondSession.token,
      sentType: 'text',
      payload: { content: 'eleventh new-window send' },
    }),
    (error: unknown) => isIlinkError(error, 'reply_quota_exhausted'),
  );
  assert.throws(
    () => created.ilink.startReplyAttempt({
      sessionToken: secondSession.token,
      attemptId: newAttempts[0]!.attemptId,
    }),
    (error: unknown) => isIlinkError(error, 'send_in_progress'),
  );

  const newWindowBeforeOldResult = created.ilink.getReplyWindow(secondWindowId);
  created.store.completeSend(oldSending.attemptId, {
    providerMessageId: 'provider-result-from-old-window',
  });
  assert.deepEqual(
    created.ilink.getReplyWindow(secondWindowId),
    newWindowBeforeOldResult,
  );
  assert.equal(
    created.ilink.getReplyWindow(firstWindowId)?.transmittedSendCount,
    1,
  );

  created.ilink.startReplyAttempt({
    sessionToken: secondSession.token,
    attemptId: newAttempts[0]!.attemptId,
  });
  assert.deepEqual(
    {
      reservedSendCount:
        created.ilink.getReplyWindow(secondWindowId)?.reservedSendCount,
      transmittedSendCount:
        created.ilink.getReplyWindow(secondWindowId)?.transmittedSendCount,
    },
    { reservedSendCount: 9, transmittedSendCount: 1 },
  );
});

test('identical provider message IDs stay isolated across iLink accounts', async (t) => {
  const created = await fixture(t);
  const accountA = registerAccount(
    created,
    'collision-bot-a@im.bot',
    'collision-owner-a@im.wechat',
  );
  const accountB = registerAccount(
    created,
    'collision-bot-b@im.bot',
    'collision-owner-b@im.wechat',
  );
  const providerMessageId = 303;
  const pageA = commitMessage(created, accountA, {
    providerMessageId,
    nextCursor: 'cursor-account-a',
  });
  const pageB = commitMessage(created, accountB, {
    providerMessageId,
    nextCursor: 'cursor-account-b',
  });
  const messageA = pageA.insertedMessageKeys[0]!;
  const messageB = pageB.insertedMessageKeys[0]!;
  const windowA = created.ilink.getReplyWindow(pageA.replyWindowIds[0]!);
  const windowB = created.ilink.getReplyWindow(pageB.replyWindowIds[0]!);
  assert.ok(windowA);
  assert.ok(windowB);

  assert.notEqual(messageA, messageB);
  assert.equal(messageA, stableMessageKey('weixin_ilink', accountA.accountKey, 'message:303'));
  assert.equal(messageB, stableMessageKey('weixin_ilink', accountB.accountKey, 'message:303'));
  assert.deepEqual(
    [
      created.ilink.getCursor(accountA.accountKey)?.cursor,
      created.ilink.getCursor(accountB.accountKey)?.cursor,
    ],
    ['cursor-account-a', 'cursor-account-b'],
  );
  assert.notEqual(windowA.replyWindowId, windowB.replyWindowId);
  assert.deepEqual(
    [
      [windowA.accountKey, windowA.peerId, windowA.sourceMessageKey],
      [windowB.accountKey, windowB.peerId, windowB.sourceMessageKey],
    ],
    [
      [accountA.accountKey, accountA.peerId, messageA],
      [accountB.accountKey, accountB.peerId, messageB],
    ],
  );

  created.store.setConversationThread({
    channel: 'weixin_ilink',
    accountKey: accountA.accountKey,
    peerId: accountA.peerId,
    threadId: '01900000-0000-7000-8000-00000000030a',
    memoryThreadId: '01900000-0000-7000-8000-00000000031a',
  });
  created.store.setConversationThread({
    channel: 'weixin_ilink',
    accountKey: accountB.accountKey,
    peerId: accountB.peerId,
    threadId: '01900000-0000-7000-8000-00000000030b',
    memoryThreadId: '01900000-0000-7000-8000-00000000031b',
  });
  assert.deepEqual(
    [
      created.store.getConversation('weixin_ilink', accountA.accountKey, accountA.peerId)
        ?.threadId,
      created.store.getConversation('weixin_ilink', accountB.accountKey, accountB.peerId)
        ?.threadId,
    ],
    [
      '01900000-0000-7000-8000-00000000030a',
      '01900000-0000-7000-8000-00000000030b',
    ],
  );
  created.store.claimInbound({ messageKey: messageA });
  created.store.claimInbound({ messageKey: messageB });
  const sessionA = created.store.createAgentSession({ messageKey: messageA });
  const sessionB = created.store.createAgentSession({ messageKey: messageB });
  assert.notEqual(sessionA.token, sessionB.token);
  assert.deepEqual(
    [
      [sessionA.accountKey, sessionA.peerId, sessionA.replyWindowId,
        sessionA.memoryThreadId],
      [sessionB.accountKey, sessionB.peerId, sessionB.replyWindowId,
        sessionB.memoryThreadId],
    ],
    [
      [accountA.accountKey, accountA.peerId, windowA.replyWindowId,
        '01900000-0000-7000-8000-00000000031a'],
      [accountB.accountKey, accountB.peerId, windowB.replyWindowId,
        '01900000-0000-7000-8000-00000000031b'],
    ],
  );
  assert.equal(created.store.getAgentSession(sessionA.token).token, sessionA.token);

  const attemptA = created.ilink.reserveReplyAttempt({
    sessionToken: sessionA.token,
    sentType: 'text',
    payload: { content: 'account A' },
  });
  const attemptB = created.ilink.reserveReplyAttempt({
    sessionToken: sessionB.token,
    sentType: 'text',
    payload: { content: 'account B' },
  });
  assert.equal(attemptA.sendIndex, 0);
  assert.equal(attemptB.sendIndex, 0);
  assert.notEqual(attemptA.attemptId, attemptB.attemptId);
  assert.notEqual(attemptA.clientMessageId, attemptB.clientMessageId);
  assert.deepEqual(
    [
      [attemptA.accountKey, attemptA.peerId, attemptA.replyWindowId],
      [attemptB.accountKey, attemptB.peerId, attemptB.replyWindowId],
    ],
    [
      [accountA.accountKey, accountA.peerId, windowA.replyWindowId],
      [accountB.accountKey, accountB.peerId, windowB.replyWindowId],
    ],
  );
  assert.throws(
    () => created.ilink.startReplyAttempt({
      sessionToken: sessionA.token,
      attemptId: attemptB.attemptId,
    }),
    (error: unknown) => isIlinkError(error, 'attempt_conflict'),
  );
  created.ilink.startReplyAttempt({
    sessionToken: sessionA.token,
    attemptId: attemptA.attemptId,
  });
  created.ilink.startReplyAttempt({
    sessionToken: sessionB.token,
    attemptId: attemptB.attemptId,
  });
  created.store.completeSend(attemptA.attemptId, {
    providerMessageId: 'provider-send-account-a',
  });
  created.store.completeSend(attemptB.attemptId, {
    providerMessageId: 'provider-send-account-b',
  });
  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'weixin_ilink',
      accountKey: accountA.accountKey,
      peerId: accountA.peerId,
    }).map((attempt) => attempt.attemptId),
    [attemptA.attemptId],
  );
  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'weixin_ilink',
      accountKey: accountB.accountKey,
      peerId: accountB.peerId,
    }).map((attempt) => attempt.attemptId),
    [attemptB.attemptId],
  );

  created.ilink.compareAndSetCursor({
    accountKey: accountA.accountKey,
    expectedGeneration: 1,
    expectedCursor: 'cursor-account-a',
    nextCursor: 'cursor-account-a-next',
  });
  assert.equal(
    created.ilink.getCursor(accountB.accountKey)?.cursor,
    'cursor-account-b',
  );
  assert.deepEqual(created.store.foreignKeyCheck(), []);
});

test('the same account, peer, and provider ID stay isolated across channels', async (t) => {
  const created = await fixture(t);
  const account = registerAccount(
    created,
    'cross-channel-collision@im.bot',
    'cross-channel-collision@im.wechat',
  );
  const providerMessageId = 'message:404';
  const wecom = created.store.ingestSyncPage({
    accountKey: account.accountKey,
    nextCursor: 'wechat-cursor',
    messages: [testWecomMessage({
      id: providerMessageId,
      openKfId: account.accountKey,
      externalUserId: account.peerId,
      sentAt: created.now(),
      text: 'wechat copy',
    })],
  });
  const ilink = commitMessage(created, account, {
    providerMessageId: 404,
    text: 'iLink copy',
  });
  const wecomKey = wecom.insertedMessageKeys[0]!;
  const ilinkKey = ilink.insertedMessageKeys[0]!;

  assert.equal(
    wecomKey,
    stableMessageKey(
      'wechat_kf',
      account.accountKey,
      providerMessageId,
    ),
  );
  assert.equal(
    ilinkKey,
    stableMessageKey(
      'weixin_ilink',
      account.accountKey,
      providerMessageId,
    ),
  );
  assert.notEqual(wecomKey, ilinkKey);
  assert.deepEqual(
    created.store.listPendingInbound({
      channel: 'wechat_kf',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ messageKey }) => messageKey),
    [wecomKey],
  );
  assert.deepEqual(
    created.store.listPendingInbound({
      channel: 'weixin_ilink',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ messageKey }) => messageKey),
    [ilinkKey],
  );

  created.store.setConversationThread({
    channel: 'wechat_kf',
    accountKey: account.accountKey,
    peerId: account.peerId,
    threadId: '01900000-0000-7000-8000-00000000040c',
  });
  created.store.setConversationThread({
    channel: 'weixin_ilink',
    accountKey: account.accountKey,
    peerId: account.peerId,
    threadId: '01900000-0000-7000-8000-00000000040d',
  });
  assert.deepEqual(
    [
      created.store.getConversation(
        'wechat_kf',
        account.accountKey,
        account.peerId,
      )?.threadId,
      created.store.getConversation(
        'weixin_ilink',
        account.accountKey,
        account.peerId,
      )?.threadId,
    ],
    [
      '01900000-0000-7000-8000-00000000040c',
      '01900000-0000-7000-8000-00000000040d',
    ],
  );

  created.store.rememberInboundMedia({
    messageKey: wecomKey,
    attachments: [{ kind: 'image', mediaId: 'wechat-collision-image' }],
  });
  created.store.rememberInboundMedia({
    messageKey: ilinkKey,
    attachments: [{ kind: 'image', mediaId: 'ilink-collision-image' }],
  });
  assert.deepEqual(
    created.store.listRecentMedia({
      channel: 'wechat_kf',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ mediaId }) => mediaId),
    ['wechat-collision-image'],
  );
  assert.deepEqual(
    created.store.listRecentMedia({
      channel: 'weixin_ilink',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ mediaId }) => mediaId),
    ['ilink-collision-image'],
  );

  created.store.claimInbound({ messageKey: wecomKey });
  created.store.claimInbound({ messageKey: ilinkKey });
  const wecomSession = created.store.createAgentSession({ messageKey: wecomKey });
  const ilinkSession = created.store.createAgentSession({ messageKey: ilinkKey });
  assert.deepEqual(
    [
      [wecomSession.channel, wecomSession.replyWindowId],
      [ilinkSession.channel, ilinkSession.replyWindowId],
    ],
    [
      ['wechat_kf', 0],
      ['weixin_ilink', ilink.replyWindowIds[0]],
    ],
  );
  const wecomAttempt = created.store.reserveAgentSend({
    sessionToken: wecomSession.token,
    sentType: 'text',
    payload: { content: 'wechat collision reply' },
  });
  const ilinkAttempt = created.ilink.reserveReplyAttempt({
    sessionToken: ilinkSession.token,
    sentType: 'text',
    payload: { content: 'iLink collision reply' },
  });
  assert.deepEqual(
    [
      [wecomAttempt.channel, wecomAttempt.messageKey],
      [ilinkAttempt.channel, ilinkAttempt.messageKey],
    ],
    [
      ['wechat_kf', wecomKey],
      ['weixin_ilink', ilinkKey],
    ],
  );
  assert.equal(wecomAttempt.status, 'sending');
  created.ilink.startReplyAttempt({
    sessionToken: ilinkSession.token,
    attemptId: ilinkAttempt.attemptId,
  });
  created.store.completeSend(wecomAttempt.attemptId, {
    providerMessageId: 'wechat-collision-result',
  });
  created.store.completeSend(ilinkAttempt.attemptId, {
    providerMessageId: 'ilink-collision-result',
  });
  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'wechat_kf',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ attemptId }) => attemptId),
    [wecomAttempt.attemptId],
  );
  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'weixin_ilink',
      accountKey: account.accountKey,
      peerId: account.peerId,
    }).map(({ attemptId }) => attemptId),
    [ilinkAttempt.attemptId],
  );
  assert.deepEqual(created.store.foreignKeyCheck(), []);
});

test('one human has independent WeCom and iLink authorization, state, media, and quota', async (t) => {
  const created = await fixture(t);
  // These provider IDs intentionally describe the same fixture human. There is
  // no logical-contact key that may join the two channel identities.
  const wecomOpenKfId = 'wk-natural-person-404';
  const wecomPeerId = 'wecom-natural-person-404';
  const ilinkAccount = registerAccount(
    created,
    'natural-person-404-bot@im.bot',
    'ilink-natural-person-404',
  );
  assert.equal(created.store.getAuthorization(wecomPeerId), undefined);
  assert.equal(created.store.getAuthorization(ilinkAccount.peerId), undefined);

  const authorizationMessages = Array.from({ length: 3 }, (_, index) =>
    testWecomMessage({
      id: `wecom-authorization-${index + 1}`,
      openKfId: wecomOpenKfId,
      externalUserId: wecomPeerId,
      sentAt: created.now() + index,
      text: 'channel-secret',
    })
  );
  created.store.ingestSyncPage({
    accountKey: wecomOpenKfId,
    expectedCursor: '',
    nextCursor: 'wecom-authorized',
    messages: authorizationMessages,
  });
  authorizationMessages.forEach((message, index) => {
    created.store.evaluateAuthorization({
      messageKey: stableMessageKey('wechat_kf', wecomOpenKfId, message.providerMessageId),
      accountKey: wecomOpenKfId,
      peerId: wecomPeerId,
      isTrigger: true,
      requiredConsecutive: 3,
    });
    assert.equal(
      created.store.getAuthorization(wecomPeerId)?.consecutiveMatches,
      index + 1,
    );
  });
  assert.equal(created.store.getAuthorization(wecomPeerId)?.authorized, true);
  assert.equal(created.store.getAuthorization(ilinkAccount.peerId), undefined);

  const wecomMessage = testWecomMessage({
    id: 'wecom-live-message',
    openKfId: wecomOpenKfId,
    externalUserId: wecomPeerId,
    sentAt: created.now() + 10,
    text: 'WeCom side of the same human',
  });
  const wecomPage = created.store.ingestSyncPage({
    accountKey: wecomOpenKfId,
    expectedCursor: 'wecom-authorized',
    nextCursor: 'wecom-live',
    messages: [wecomMessage],
  });
  const wecomMessageKey = wecomPage.insertedMessageKeys[0]!;
  const ilinkPage = commitMessage(created, ilinkAccount, {
    providerMessageId: 404,
    text: 'iLink side of the same human',
  });
  const ilinkMessageKey = ilinkPage.insertedMessageKeys[0]!;

  created.store.setConversationThread({
    channel: 'wechat_kf',
    accountKey: wecomOpenKfId,
    peerId: wecomPeerId,
    threadId: '01900000-0000-7000-8000-00000000040a',
    memoryThreadId: '01900000-0000-7000-8000-00000000041a',
  });
  assert.deepEqual(
    created.store.getConversation(
      'weixin_ilink',
      ilinkAccount.accountKey,
      ilinkAccount.peerId,
    ),
    {
      channel: 'weixin_ilink',
      accountKey: ilinkAccount.accountKey,
      peerId: ilinkAccount.peerId,
      threadId: '',
      memoryThreadId: '',
      updatedAt: created.now(),
    },
  );
  created.store.setConversationThread({
    channel: 'weixin_ilink',
    accountKey: ilinkAccount.accountKey,
    peerId: ilinkAccount.peerId,
    threadId: '01900000-0000-7000-8000-00000000040b',
    memoryThreadId: '01900000-0000-7000-8000-00000000041b',
  });
  assert.deepEqual(
    [
      created.store.getConversation('wechat_kf', wecomOpenKfId, wecomPeerId)?.threadId,
      created.store.getConversation(
        'weixin_ilink',
        ilinkAccount.accountKey,
        ilinkAccount.peerId,
      )?.threadId,
    ],
    [
      '01900000-0000-7000-8000-00000000040a',
      '01900000-0000-7000-8000-00000000040b',
    ],
  );

  created.store.rememberInboundMedia({
    messageKey: wecomMessageKey,
    attachments: [{
      kind: 'image',
      mediaId: 'wecom-media-for-natural-person-404',
      filename: 'wecom.png',
    }],
  });
  created.store.rememberInboundMedia({
    messageKey: ilinkMessageKey,
    attachments: [{
      kind: 'image',
      mediaId: 'ilink-media-for-natural-person-404',
      filename: 'ilink.png',
    }],
  });
  assert.deepEqual(
    created.store.listRecentMedia({
      channel: 'wechat_kf',
      accountKey: wecomOpenKfId,
      peerId: wecomPeerId,
    }).map(({ mediaId }) => mediaId),
    ['wecom-media-for-natural-person-404'],
  );
  assert.deepEqual(
    created.store.listRecentMedia({
      channel: 'weixin_ilink',
      accountKey: ilinkAccount.accountKey,
      peerId: ilinkAccount.peerId,
    }).map(({ mediaId }) => mediaId),
    ['ilink-media-for-natural-person-404'],
  );

  created.store.claimInbound({ messageKey: wecomMessageKey });
  created.store.claimInbound({ messageKey: ilinkMessageKey });
  const wecomSession = created.store.createAgentSession({
    messageKey: wecomMessageKey,
  });
  const ilinkSession = created.store.createAgentSession({
    messageKey: ilinkMessageKey,
  });
  assert.deepEqual(
    {
      channel: wecomSession.channel,
      memoryThreadId: wecomSession.memoryThreadId,
      mediaIds: wecomSession.mediaCatalog.map(({ mediaId }) => mediaId),
      replyWindowId: wecomSession.replyWindowId,
    },
    {
      channel: 'wechat_kf',
      memoryThreadId: '01900000-0000-7000-8000-00000000041a',
      mediaIds: ['wecom-media-for-natural-person-404'],
      replyWindowId: 0,
    },
  );
  assert.deepEqual(
    {
      channel: ilinkSession.channel,
      memoryThreadId: ilinkSession.memoryThreadId,
      mediaIds: ilinkSession.mediaCatalog.map(({ mediaId }) => mediaId),
      replyWindowId: ilinkSession.replyWindowId,
    },
    {
      channel: 'weixin_ilink',
      memoryThreadId: '01900000-0000-7000-8000-00000000041b',
      mediaIds: ['ilink-media-for-natural-person-404'],
      replyWindowId: ilinkPage.replyWindowIds[0],
    },
  );

  const wecomAttempts = Array.from({ length: 5 }, (_, index) => {
    const attempt = created.store.reserveAgentSend({
      sessionToken: wecomSession.token,
      sentType: 'text',
      payload: { content: `wecom-${index}` },
    });
    created.store.completeSend(attempt.attemptId, {
      providerMessageId: `wecom-provider-result-${index}`,
    });
    return attempt;
  });
  assert.throws(
    () => created.store.reserveAgentSend({
      sessionToken: wecomSession.token,
      sentType: 'text',
      payload: { content: 'wecom-sixth' },
    }),
    /at most five sends/u,
  );

  const ilinkAttempts = Array.from({ length: 10 }, (_, index) =>
    created.ilink.reserveReplyAttempt({
      sessionToken: ilinkSession.token,
      sentType: 'text',
      payload: { content: `ilink-${index}` },
    })
  );
  assert.throws(
    () => created.ilink.reserveReplyAttempt({
      sessionToken: ilinkSession.token,
      sentType: 'text',
      payload: { content: 'ilink-eleventh' },
    }),
    (error: unknown) => isIlinkError(error, 'reply_quota_exhausted'),
  );
  for (const [index, attempt] of ilinkAttempts.entries()) {
    created.ilink.startReplyAttempt({
      sessionToken: ilinkSession.token,
      attemptId: attempt.attemptId,
    });
    created.store.completeSend(attempt.attemptId, {
      providerMessageId: `ilink-provider-result-${index}`,
    });
  }

  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'wechat_kf',
      accountKey: wecomOpenKfId,
      peerId: wecomPeerId,
    }).map(({ channel, attemptId }) => [channel, attemptId]).sort(),
    wecomAttempts.map(({ attemptId }) => ['wechat_kf', attemptId]).sort(),
  );
  assert.deepEqual(
    created.store.listRecentConversationAttempts({
      channel: 'weixin_ilink',
      accountKey: ilinkAccount.accountKey,
      peerId: ilinkAccount.peerId,
    }).map(({ channel, attemptId }) => [channel, attemptId]).sort(),
    ilinkAttempts.map(({ attemptId }) => ['weixin_ilink', attemptId]).sort(),
  );
  assert.deepEqual(created.store.foreignKeyCheck(), []);
});
