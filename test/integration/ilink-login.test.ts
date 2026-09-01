import assert from 'node:assert/strict';
import { test } from 'vitest';

import { IlinkLoginManager } from '../../src/ilink/login-manager.ts';
import type { IlinkQrStatusResponse } from '../../src/ilink/protocol/types.ts';
import { IlinkProtocolError } from '../../src/ilink/protocol/client.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const key = Buffer.alloc(32, 23).toString('base64url');

async function fixture(t: Parameters<typeof createTempSqlite>[0]) {
  const temp = await createTempSqlite(t, { prefix: 'ilink-login-' });
  let now = 1_800_000_000_000;
  const secretBox = new IlinkSecretBox(key);
  const persistence = temp.openInjectedPersistenceForTest({ clock: () => now });
  const store = persistence.core;
  const accounts = persistence.createIlinkStore({ clock: () => now });
  const offers = persistence.createIlinkLoginStore({
    secretBox,
    clock: () => now,
  });
  const page = store.ingestSyncPage({
    accountKey: 'wk-source',
    nextCursor: 'cursor-source',
    messages: [testWecomMessage({
      id: 'source-message',
      openKfId: 'wk-source',
      externalUserId: 'wm-source',
      text: '切换到 Bot',
    })],
  });
  const messageKey = page.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey });
  const session = store.createAgentSession({ messageKey });
  return {
    store, accounts, secretBox, offers, session,
    database: persistence.database,
    clock: () => now,
    advance(milliseconds: number) { now += milliseconds; },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true');
}

function wechatSource(created: Awaited<ReturnType<typeof fixture>>) {
  return { kind: 'wechat_kf' as const, sessionToken: created.session.token };
}

test('confirmed QR creates a separate encrypted iLink identity and refreshes listeners', async (t) => {
  const created = await fixture(t);
  const botId = 'new-bot@im.bot';
  const owner = 'actual-scanner@im.wechat';
  let refreshed = 0;
  const localTokenLists: string[][] = [];
  const client = {
    async createQr(request: { readonly local_token_list?: readonly string[] } = {}) {
      localTokenLists.push([...(request.local_token_list || [])]);
      return { qrcode: 'opaque-qr-token', qrcode_img_content: 'weixin://ilink/login/test' };
    },
    async getQrStatus(): Promise<IlinkQrStatusResponse> {
      return {
        status: 'confirmed',
        bot_token: 'new-bot-secret',
        ilink_bot_id: botId,
        ilink_user_id: owner,
        baseurl: 'https://ilinkai.weixin.qq.com/',
      };
    },
    resolveRedirectBaseUrl(host: string) {
      return `https://${host}/`;
    },
  };
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client,
    clock: created.clock,
    onAccountsChanged: () => { refreshed += 1; },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer(wechatSource(created));
  assert.equal(offered.qrContent, 'weixin://ilink/login/test');
  assert.equal(offered.expiresAt, created.clock() + 5 * 60 * 1_000);
  await eventually(() => created.accounts.listActiveAccounts().length === 1);

  const accountKey = createIlinkAccountKey(botId);
  const account = created.accounts.getAccountWithSecret(accountKey);
  assert.ok(account);
  assert.equal(account.account.ownerPeerId, owner);
  assert.equal(account.account.agentAccess, 'restricted');
  assert.equal(account.account.runtimeEnabled, true);
  assert.notEqual(account.account.ownerPeerId, 'wm-source');
  assert.equal(
    created.secretBox.open(account.secret.sealedBotToken, {
      secretKind: 'bot_token', accountId: accountKey, peerId: owner, generation: 1,
    }),
    'new-bot-secret',
  );
  assert.equal(created.offers.listActive().length, 0);
  assert.equal(refreshed, 1);
  assert.equal(
    created.store.getConversation('weixin_ilink', accountKey, owner),
    undefined,
  );

  await manager.offer(wechatSource(created));
  await eventually(() => created.accounts.getAccount(accountKey)?.generation === 2);
  const rotated = created.accounts.getAccountWithSecret(accountKey);
  assert.ok(rotated);
  assert.equal(
    created.secretBox.open(rotated.secret.sealedBotToken, {
      secretKind: 'bot_token', accountId: accountKey, peerId: owner, generation: 2,
    }),
    'new-bot-secret',
  );
  assert.equal(refreshed, 2);
  const audits = created.database.prepare(`
    SELECT result, account_key FROM ilink_enrollment_audit ORDER BY completed_at
  `).all() as Array<{ result: string; account_key: string }>;
  assert.equal(audits.length, 2);
  assert.ok(audits.every((audit) =>
    audit.result === 'confirmed' && audit.account_key === accountKey));
  assert.deepEqual(localTokenLists, [[], ['new-bot-secret']]);
});

test('configured iLink login origin is preserved from QR creation through status polling', async (t) => {
  const created = await fixture(t);
  const baseUrl = 'https://login-edge.weixin.qq.com/';
  const polledOrigins: string[] = [];
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    baseUrl,
    client: {
      async createQr() {
        return { qrcode: 'configured-origin', qrcode_img_content: 'weixin://configured' };
      },
      async getQrStatus(_request, options) {
        polledOrigins.push(options.baseUrl);
        return { status: 'expired' as const };
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  await eventually(() => manager.status(offered.offerId).status === 'expired');
  assert.deepEqual(polledOrigins, [baseUrl]);
});

test('cancelling QR creation leaves no login offer or account', async (t) => {
  const created = await fixture(t);
  const controller = new AbortController();
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr(_request, options = {}) {
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
      async getQrStatus() { return { status: 'wait' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const pending = manager.offer({ kind: 'terminal' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error: unknown) =>
    error instanceof Error && error.name === 'AbortError');
  assert.equal(created.offers.listActive().length, 0);
  assert.equal(created.accounts.listActiveAccounts().length, 0);
});

test('terminal source uses the same encrypted enrollment and five-minute state machine', async (t) => {
  const created = await fixture(t);
  const statuses: IlinkQrStatusResponse[] = [
    { status: 'scaned' },
    {
      status: 'confirmed',
      bot_token: 'terminal-bot-secret',
      ilink_bot_id: 'terminal-bot@im.bot',
      ilink_user_id: 'terminal-owner@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com/',
    },
    {
      status: 'confirmed',
      bot_token: 'terminal-bot-secret-rotated',
      ilink_bot_id: 'terminal-bot@im.bot',
      ilink_user_id: 'terminal-owner@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com/',
    },
  ];
  let refreshed = 0;
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'terminal-status-token', qrcode_img_content: 'weixin://terminal' };
      },
      async getQrStatus() { return statuses.shift() || { status: 'wait' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    clock: created.clock,
    onAccountsChanged: () => { refreshed += 1; },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  assert.equal(offered.qrContent, 'weixin://terminal');
  assert.equal(offered.expiresAt, created.clock() + 5 * 60 * 1_000);
  await eventually(() => manager.status(offered.offerId).status === 'confirmed');
  assert.equal(refreshed, 1);
  const audit = created.database.prepare(`
    SELECT initiator_kind, source_channel, source_message_key, source_account_id,
           source_peer_id, result
    FROM ilink_enrollment_audit WHERE offer_id = ?
  `).get(offered.offerId) as Record<string, unknown>;
  assert.deepEqual({ ...audit }, {
    initiator_kind: 'local_operator',
    source_channel: 'terminal',
    source_message_key: '',
    source_account_id: 'local',
    source_peer_id: 'operator',
    result: 'confirmed',
  });
  assert.equal(Number((created.database.prepare(`
    SELECT COUNT(*) AS count FROM agent_sessions
  `).get() as { count: number }).count), 1);
  const accountKey = createIlinkAccountKey('terminal-bot@im.bot');
  const account = created.accounts.getAccountWithSecret(accountKey);
  assert.ok(account);
  assert.equal(account.account.agentAccess, 'host');
  assert.equal(account.account.runtimeEnabled, false);
  assert.equal(
    created.secretBox.open(account.secret.sealedBotToken, {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: 'terminal-owner@im.wechat',
      generation: 1,
    }),
    'terminal-bot-secret',
  );
  await manager.offer(wechatSource(created));
  await eventually(() => created.accounts.getAccount(accountKey)?.generation === 2);
  assert.equal(created.accounts.getAccount(accountKey)?.agentAccess, 'host');
  assert.equal(created.accounts.getAccount(accountKey)?.runtimeEnabled, true);
});

test('terminal offers are released on runtime shutdown instead of resuming without a CLI', async (t) => {
  const created = await fixture(t);
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'terminal-shutdown-token', qrcode_img_content: 'weixin://stop' };
      },
      async getQrStatus(_request, options) {
        return await new Promise<IlinkQrStatusResponse>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  assert.equal(manager.status(offered.offerId).status, 'waiting');
  await manager.close();
  assert.equal(manager.status(offered.offerId).status, 'cancelled');
  assert.equal(created.offers.listActive().length, 0);
});

test('observing the real five-minute expiry aborts the in-flight provider poll', async (t) => {
  const created = await fixture(t);
  let aborted = false;
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    clock: created.clock,
    client: {
      async createQr() {
        return { qrcode: 'terminal-expiry-token', qrcode_img_content: 'weixin://expiry' };
      },
      async getQrStatus(_request, options) {
        return await new Promise<IlinkQrStatusResponse>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(options.signal.reason);
          }, { once: true });
        });
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  created.advance(5 * 60 * 1_000);
  assert.equal(manager.status(offered.offerId).status, 'expired');
  await eventually(() => aborted);
  assert.equal(created.offers.listActive().length, 0);
});

test('confirmed account and enrollment audit commit in one transaction', async (t) => {
  const created = await fixture(t);
  const offer = created.offers.create({
    source: wechatSource(created),
    qrCode: 'atomic-confirm-token',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
  });
  const providerAccountId = 'atomic-confirm-bot@im.bot';
  const ownerPeerId = 'atomic-confirm-owner@im.wechat';
  const accountKey = createIlinkAccountKey(providerAccountId);
  const encryptedBotToken = created.secretBox.seal('atomic-confirm-secret', {
    secretKind: 'bot_token',
    accountId: accountKey,
    peerId: ownerPeerId,
    generation: 1,
  });
  created.database.exec(`
    CREATE TRIGGER reject_confirm_audit
    BEFORE INSERT ON ilink_enrollment_audit
    WHEN NEW.result = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'forced confirm audit failure'); END;
  `);

  assert.throws(() => created.accounts.confirmEnrollment({
    offerId: offer.offerId,
    accountGeneration: 1,
    maxAccounts: 20,
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken,
    now: created.clock(),
  }), /forced confirm audit failure/u);
  assert.equal(created.accounts.getAccount(accountKey), undefined);
  assert.equal(created.offers.listActive().length, 1);
  assert.equal(created.database.prepare(`
    SELECT 1 FROM ilink_enrollment_audit WHERE offer_id = ?
  `).get(offer.offerId), undefined);

  created.database.exec('DROP TRIGGER reject_confirm_audit');
  const account = created.accounts.confirmEnrollment({
    offerId: offer.offerId,
    accountGeneration: 1,
    maxAccounts: 20,
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken,
    now: created.clock(),
  });
  assert.equal(account.accountKey, accountKey);
  assert.equal(account.generation, 1);
  assert.equal(created.offers.listActive().length, 0);
  assert.deepEqual({ ...(created.database.prepare(`
    SELECT result, account_key FROM ilink_enrollment_audit WHERE offer_id = ?
  `).get(offer.offerId) as Record<string, unknown>) }, {
    result: 'confirmed', account_key: accountKey,
  });

  const rotationOffer = created.offers.create({
    source: wechatSource(created),
    qrCode: 'atomic-rotation-token',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
  });
  const rotatedSecret = created.secretBox.seal('atomic-rotated-secret', {
    secretKind: 'bot_token',
    accountId: accountKey,
    peerId: ownerPeerId,
    generation: 2,
  });
  created.database.exec(`
    CREATE TRIGGER reject_rotation_audit
    BEFORE INSERT ON ilink_enrollment_audit
    WHEN NEW.offer_id = '${rotationOffer.offerId}'
    BEGIN SELECT RAISE(ABORT, 'forced rotation audit failure'); END;
  `);
  assert.throws(() => created.accounts.confirmEnrollment({
    offerId: rotationOffer.offerId,
    accountGeneration: 2,
    maxAccounts: 20,
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: rotatedSecret,
    now: created.clock(),
  }), /forced rotation audit failure/u);
  assert.equal(created.accounts.getAccount(accountKey)?.generation, 1);
  assert.equal(created.offers.listActive().length, 1);
});

test('existing-account host authorization and audit commit atomically', async (t) => {
  const created = await fixture(t);
  const providerAccountId = 'atomic-existing-bot@im.bot';
  const ownerPeerId = 'atomic-existing-owner@im.wechat';
  const accountKey = createIlinkAccountKey(providerAccountId);
  created.accounts.registerAccount({
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: created.secretBox.seal('atomic-existing-secret', {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation: 1,
    }),
    now: created.clock(),
  });
  const offer = created.offers.create({
    source: { kind: 'terminal' },
    qrCode: 'atomic-existing-offer',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
    candidateAccountKeys: [accountKey],
  });
  created.database.exec(`
    CREATE TRIGGER reject_existing_authorization_audit
    BEFORE INSERT ON ilink_enrollment_audit
    WHEN NEW.offer_id = '${offer.offerId}'
    BEGIN SELECT RAISE(ABORT, 'forced existing authorization audit failure'); END;
  `);
  assert.throws(() => created.accounts.confirmExistingEnrollment({
    offerId: offer.offerId,
    accountKey,
    now: created.clock(),
  }), /forced existing authorization audit failure/u);
  assert.equal(created.accounts.getAccount(accountKey)?.agentAccess, 'restricted');
  assert.equal(created.offers.isActive(offer.offerId), true);
  created.database.exec('DROP TRIGGER reject_existing_authorization_audit');
  assert.equal(created.accounts.confirmExistingEnrollment({
    offerId: offer.offerId,
    accountKey,
    now: created.clock(),
  }).agentAccess, 'host');
  assert.equal(created.offers.isActive(offer.offerId), false);
  assert.deepEqual({ ...(created.database.prepare(`
    SELECT result, account_key FROM ilink_enrollment_audit WHERE offer_id = ?
  `).get(offer.offerId) as Record<string, unknown>) }, {
    result: 'already_connected',
    account_key: accountKey,
  });
});

test('atomic enrollment rechecks the active account limit', async (t) => {
  const created = await fixture(t);
  const existingBot = 'existing-limit-bot@im.bot';
  const existingOwner = 'existing-limit-owner@im.wechat';
  const existingKey = createIlinkAccountKey(existingBot);
  created.accounts.registerAccount({
    providerAccountId: existingBot,
    ownerPeerId: existingOwner,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: created.secretBox.seal('existing-limit-secret', {
      secretKind: 'bot_token',
      accountId: existingKey,
      peerId: existingOwner,
      generation: 1,
    }),
    now: created.clock(),
  });
  const offer = created.offers.create({
    source: wechatSource(created),
    qrCode: 'limited-confirm-token',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
  });
  const providerAccountId = 'rejected-limit-bot@im.bot';
  const ownerPeerId = 'rejected-limit-owner@im.wechat';
  const accountKey = createIlinkAccountKey(providerAccountId);

  assert.throws(() => created.accounts.confirmEnrollment({
    offerId: offer.offerId,
    accountGeneration: 1,
    maxAccounts: 1,
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: created.secretBox.seal('rejected-limit-secret', {
      secretKind: 'bot_token', accountId: accountKey, peerId: ownerPeerId, generation: 1,
    }),
    now: created.clock(),
  }), /account limit/u);
  assert.equal(created.accounts.getAccount(accountKey), undefined);
  assert.equal(created.offers.listActive().length, 1);
});

test('already-connected QR status retires the offer without rotating credentials', async (t) => {
  const created = await fixture(t);
  const info: string[] = [];
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'bound-token', qrcode_img_content: 'weixin://bound' };
      },
      async getQrStatus() { return { status: 'binded_redirect' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    logger: { info(message) { info.push(message); }, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer(wechatSource(created));
  await eventually(() => created.offers.listActive().length === 0);
  assert.deepEqual(info, ['[ilink-login] account is already connected']);
  assert.equal(created.accounts.listActiveAccounts().length, 0);
  assert.equal(
    (created.database.prepare(`
      SELECT result FROM ilink_enrollment_audit WHERE offer_id = ?
    `).get(offered.offerId) as { result: string }).result,
    'already_connected',
  );
});

test('terminal already-connected response fails closed without one attributable candidate', async (t) => {
  const created = await fixture(t);
  const warnings: string[] = [];
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'unattributed-token', qrcode_img_content: 'weixin://unknown' };
      },
      async getQrStatus() { return { status: 'binded_redirect' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  await eventually(() => manager.status(offered.offerId).status === 'failed');
  assert.deepEqual(warnings, [
    '[ilink-login] already-connected account could not be identified',
  ]);
  assert.equal(created.accounts.listActiveAccounts().length, 0);
});

test('terminal reauthorization upgrades one existing restricted account at the account limit', async (t) => {
  const created = await fixture(t);
  const otherProviderId = 'other-existing-bot@im.bot';
  const otherOwnerId = 'other-existing-owner@im.wechat';
  const otherAccountKey = createIlinkAccountKey(otherProviderId);
  created.accounts.registerAccount({
    providerAccountId: otherProviderId,
    ownerPeerId: otherOwnerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: created.secretBox.seal('other-existing-token', {
      secretKind: 'bot_token',
      accountId: otherAccountKey,
      peerId: otherOwnerId,
      generation: 1,
    }),
    now: created.clock(),
  });
  const providerAccountId = 'restricted-existing-bot@im.bot';
  const ownerPeerId = 'restricted-existing-owner@im.wechat';
  const accountKey = createIlinkAccountKey(providerAccountId);
  created.accounts.registerAccount({
    providerAccountId,
    ownerPeerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: created.secretBox.seal('restricted-existing-token', {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation: 1,
    }),
    now: created.clock() + 1,
  });
  const localTokens: string[][] = [];
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    maxAccounts: 2,
    client: {
      async createQr(request = {}) {
        localTokens.push([...(request.local_token_list || [])]);
        return { qrcode: 'existing-terminal-token', qrcode_img_content: 'weixin://existing' };
      },
      async getQrStatus() { return { status: 'binded_redirect' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const offered = await manager.offer({ kind: 'terminal' });
  await eventually(() => manager.status(offered.offerId).status === 'already_connected');
  assert.deepEqual(localTokens, [['restricted-existing-token']]);
  assert.equal(created.accounts.getAccount(accountKey)?.agentAccess, 'host');
  assert.equal(created.accounts.getAccount(otherAccountKey)?.agentAccess, 'restricted');
  assert.equal(created.accounts.getAccount(accountKey)?.generation, 1);
  assert.deepEqual({ ...(created.database.prepare(`
    SELECT result, account_key FROM ilink_enrollment_audit WHERE offer_id = ?
  `).get(offered.offerId) as Record<string, unknown>) }, {
    result: 'already_connected',
    account_key: accountKey,
  });
});

test('pending QR offer resumes after manager restart and confirms once', async (t) => {
  const created = await fixture(t);
  const first = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'restart-token', qrcode_img_content: 'weixin://restart' };
      },
      async getQrStatus(_request, options) {
        return new Promise<IlinkQrStatusResponse>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await first.start();
  const offered = await first.offer(wechatSource(created));
  assert.equal(created.offers.listActive().length, 1);
  await first.close();
  assert.equal(created.offers.listActive().length, 1);

  let refreshed = 0;
  const second = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() { assert.fail('restart must not create another QR'); },
      async getQrStatus() {
        return {
          status: 'confirmed' as const,
          bot_token: 'restart-secret',
          ilink_bot_id: 'restart-bot@im.bot',
          ilink_user_id: 'restart-owner@im.wechat',
          baseurl: 'https://ilinkai.weixin.qq.com/',
        };
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    onAccountsChanged: () => { refreshed += 1; },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => second.close());
  await second.start();
  await eventually(() => created.offers.listActive().length === 0);
  assert.equal(created.accounts.listActiveAccounts().length, 1);
  assert.equal(refreshed, 1);
  assert.equal(
    (created.database.prepare(`
      SELECT result FROM ilink_enrollment_audit WHERE offer_id = ?
    `).get(offered.offerId) as { result: string }).result,
    'confirmed',
  );
});

test('only one pending QR offer is allowed for a bound WeChat conversation', async (t) => {
  const created = await fixture(t);
  let release!: (value: IlinkQrStatusResponse) => void;
  const pending = new Promise<IlinkQrStatusResponse>((resolve) => { release = resolve; });
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'pending-token', qrcode_img_content: 'weixin://pending' };
      },
      async getQrStatus() { return pending; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  const first = await manager.offer(wechatSource(created));
  await assert.rejects(() => manager.offer(wechatSource(created)), /already pending/u);
  assert.throws(() => created.offers.create({
    source: { kind: 'terminal' },
    qrCode: 'too-many-candidates',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
    candidateAccountKeys: Array.from(
      { length: 11 },
      (_value, index) => createIlinkAccountKey(`candidate-${index}@im.bot`),
    ),
  }), /Too many iLink login candidate accounts/u);
  assert.throws(
    () => created.offers.create({
      source: wechatSource(created),
      qrCode: 'duplicate-token',
      apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
    }),
    /already pending/u,
  );
  const scanned = created.offers.update(first.offerId, {
    status: 'scanned',
    apiBaseUrl: 'https://edge.weixin.qq.com/',
  });
  assert.equal(scanned.status, 'scanned');
  assert.equal(scanned.apiBaseUrl, 'https://edge.weixin.qq.com/');
  assert.throws(
    () => created.offers.create({
      source: wechatSource(created),
      qrCode: '',
      apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
    }),
    /Invalid iLink QR/u,
  );
  manager.cancel(first.offerId);
  release({ status: 'expired' });
  await manager.close();
  assert.equal(created.offers.listActive().length, 0);
  assert.equal(created.offers.finish('missing-offer'), false);
  assert.equal(
    (created.database.prepare(`
      SELECT result FROM ilink_enrollment_audit WHERE offer_id = ?
    `).get(first.offerId) as { result: string }).result,
    'cancelled',
  );
});

test('persisted terminal candidate metadata fails closed when malformed', async (t) => {
  const created = await fixture(t);
  const invalidShapes = [
    ['{}', /Invalid iLink login candidate accounts/u],
    ['[1]', /Invalid iLink login candidate account/u],
  ] as const;
  for (const [candidateJson, expected] of invalidShapes) {
    const offer = created.offers.create({
      source: { kind: 'terminal' },
      qrCode: `malformed-candidate-${candidateJson}`,
      apiBaseUrl: 'https://ilinkai.weixin.qq.com/',
    });
    created.database.prepare(`
      UPDATE ilink_login_offers SET candidate_account_keys_json = ?
      WHERE offer_id = ?
    `).run(candidateJson, offer.offerId);
    assert.throws(() => created.offers.listActive(), expected);
    created.database.prepare(`
      DELETE FROM ilink_login_offers WHERE offer_id = ?
    `).run(offer.offerId);
  }
});

test('QR polling follows an allowlisted redirect and retires non-confirmed terminal states', async (t) => {
  const created = await fixture(t);
  const statuses: IlinkQrStatusResponse[] = [
    { status: 'scaned_but_redirect', redirect_host: 'edge.weixin.qq.com' },
    { status: 'scaned' },
    { status: 'expired' },
  ];
  const bases: string[] = [];
  let transient = true;
  const manager = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'redirect-token', qrcode_img_content: 'weixin://redirect' };
      },
      async getQrStatus(_request, options) {
        bases.push(options.baseUrl);
        if (transient) {
          transient = false;
          throw new Error('transient');
        }
        return statuses.shift()!;
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    clock: created.clock,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(() => manager.close());
  await manager.start();
  await manager.offer(wechatSource(created));
  await eventually(() => created.offers.listActive().length === 0);
  assert.deepEqual(bases, [
    'https://ilinkai.weixin.qq.com/',
    'https://ilinkai.weixin.qq.com/',
    'https://edge.weixin.qq.com/',
    'https://edge.weixin.qq.com/',
  ]);
  await manager.close();
  await manager.close();
  await assert.rejects(() => manager.start(), /closed/u);
  await assert.rejects(() => manager.offer(wechatSource(created)), /closed/u);
});

test('login failures retire secret offers and account limits fail before QR creation', async (t) => {
  const created = await fixture(t);
  let createCalls = 0;
  const limited = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    maxAccounts: 0,
    client: {
      async createQr() {
        createCalls += 1;
        return { qrcode: 'never', qrcode_img_content: 'never' };
      },
      async getQrStatus() { return { status: 'expired' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
  });
  await limited.start();
  await assert.rejects(() => limited.offer(wechatSource(created)), /limit reached/u);
  assert.equal(createCalls, 0);
  await limited.close();

  const invalidQr = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'invalid-render-token', qrcode_img_content: '' };
      },
      async getQrStatus() { return { status: 'wait' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
  });
  await invalidQr.start();
  await assert.rejects(
    () => invalidQr.offer({ kind: 'terminal' }),
    /Invalid iLink QR content/u,
  );
  assert.equal(created.offers.listActive().length, 0);
  await invalidQr.close();

  const warnings: string[] = [];
  const invalidConfirmed = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'invalid-confirmed', qrcode_img_content: 'weixin://invalid' };
      },
      async getQrStatus() { return { status: 'confirmed' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
  });
  await invalidConfirmed.start();
  await invalidConfirmed.offer(wechatSource(created));
  await eventually(() => created.offers.listActive().length === 0);
  assert.deepEqual(warnings, ['[ilink-login] confirmed account activation failed']);
  await invalidConfirmed.close();

  const configurationFailure = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    client: {
      async createQr() {
        return { qrcode: 'configuration-failure', qrcode_img_content: 'weixin://config' };
      },
      async getQrStatus() {
        throw new IlinkProtocolError('configuration', 'bad configuration');
      },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
    sleep: async () => undefined,
  });
  await configurationFailure.start();
  await configurationFailure.offer(wechatSource(created));
  await eventually(() => created.offers.listActive().length === 0);
  await configurationFailure.close();

  const expiredBeforePoll = new IlinkLoginManager({
    offers: created.offers,
    accounts: created.accounts,
    secretBox: created.secretBox,
    clock: () => created.clock() + 11 * 60 * 1_000,
    client: {
      async createQr() {
        return { qrcode: 'already-expired', qrcode_img_content: 'weixin://expired' };
      },
      async getQrStatus() { return { status: 'wait' as const }; },
      resolveRedirectBaseUrl(host: string) { return `https://${host}/`; },
    },
  });
  await expiredBeforePoll.start();
  await expiredBeforePoll.offer(wechatSource(created));
  await eventually(() => created.offers.listActive().length === 0);
  await expiredBeforePoll.close();
});
