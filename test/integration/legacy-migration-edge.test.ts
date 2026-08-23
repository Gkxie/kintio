import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateLegacyState } from '../../scripts/migrate-legacy.ts';
import { createConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import {
  SqliteStore,
  type LegacyStateSnapshot,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';

function directory(t: TestContext): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-edge-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function writeState(filePath: string, state: LegacyStateSnapshot): void {
  fs.writeFileSync(filePath, JSON.stringify(state), { mode: 0o600 });
}

function baseState(
  overrides: Partial<LegacyStateSnapshot> = {},
): LegacyStateSnapshot {
  return {
    version: 1,
    cursors: {},
    threads: {},
    sessions: {},
    customerAuthorizations: {},
    messages: {},
    inboundMedia: {},
    ...overrides,
  };
}

function createJournal(filePath: string, withTable = true): DatabaseSync {
  const database = new DatabaseSync(filePath);
  if (withTable) {
    database.exec(`
      CREATE TABLE send_attempts (
        attempt_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        sent_type TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        wecom_msg_id TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
  }
  return database;
}

test('[D02] missing legacy JSON is a no-op and unsupported versions fail', (t) => {
  const root = directory(t);
  const missing = path.join(root, 'missing.json');
  const target = path.join(root, 'state.sqlite');
  assert.deepEqual(
    migrateLegacyState({ jsonFilePath: missing, databaseFilePath: target }),
    { migrated: false, reason: 'legacy_state_missing' },
  );
  assert.equal(fs.existsSync(target), false);
  writeState(missing, { version: 99 });
  assert.throws(
    () => migrateLegacyState({ jsonFilePath: missing, databaseFilePath: target }),
    /Unsupported legacy JSON state version/u,
  );
});

test('[D02] runtime fails closed until the explicit offline migration runs', (t) => {
  const root = directory(t);
  const legacy = path.join(root, 'legacy.json');
  const database = path.join(root, 'state.sqlite');
  writeState(legacy, baseState());
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'CallbackToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-test',
    WECOM_KF_SECRET: 'secret',
    CODEX_ENABLED: 'true',
    WECOM_STATE_FILE: legacy,
    WECOM_DB_FILE: database,
  });
  assert.throws(
    () => createRuntime({
      config,
      logger: { info() {}, warn() {}, error() {} },
    }),
    /run pnpm run migrate/u,
  );
  assert.equal(fs.existsSync(database), false);
  assert.equal(fs.existsSync(config.state.lockFile), false);
});

test('[D02] an existing import rejects legacy sources with a different hash', (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const target = path.join(root, 'state.sqlite');
  writeState(json, baseState({ cursors: { wk: 'one' } }));
  assert.equal(migrateLegacyState({
    jsonFilePath: json,
    databaseFilePath: target,
    backupSources: false,
  }).migrated, true);
  writeState(json, baseState({ cursors: { wk: 'changed' } }));
  assert.throws(
    () => migrateLegacyState({ jsonFilePath: json, databaseFilePath: target }),
    /different legacy source/u,
  );
});

test('[D02] journal without send_attempts imports as empty while malformed keys become uncertain placeholders', (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const emptyJournal = path.join(root, 'empty.sqlite');
  const emptyTarget = path.join(root, 'empty-target.sqlite');
  writeState(json, baseState());
  const unrelated = createJournal(emptyJournal, false);
  unrelated.exec('CREATE TABLE unrelated (value TEXT)');
  unrelated.close();
  const empty = migrateLegacyState({
    jsonFilePath: json,
    journalFilePath: emptyJournal,
    databaseFilePath: emptyTarget,
    backupSources: false,
  });
  assert.equal(empty.summary?.journalEntries, 0);

  const invalidJournal = path.join(root, 'invalid.sqlite');
  const invalidTarget = path.join(root, 'invalid-target.sqlite');
  const journal = createJournal(invalidJournal);
  journal.prepare(`
    INSERT INTO send_attempts (
      attempt_key, fingerprint, sent_type, client_message_id,
      status, updated_at
    ) VALUES ('not-parseable', 'hash', 'text', 'client', 'sending', 1)
  `).run();
  journal.close();
  migrateLegacyState({
    jsonFilePath: json,
    journalFilePath: invalidJournal,
    databaseFilePath: invalidTarget,
    backupSources: false,
  });
  const store = new SqliteStore({ filePath: invalidTarget });
  t.after(() => store.close());
  const attempt = inspectAttempts(store.database)[0];
  assert.ok(attempt);
  assert.equal(attempt.status, 'uncertain');
  assert.equal(store.getInbound(attempt.messageKey)?.status, 'completed');
});

test('[D02][A03][I01] every migrated ready row owns a recoverable outbox', (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const target = path.join(root, 'state.sqlite');
  writeState(json, baseState({
    messages: {
      auth: {
        openKfId: 'wk', externalUserId: 'wm', status: 'authorization_pending', sentChunks: 0,
      },
      'auth-uncertain': {
        openKfId: 'wk', externalUserId: 'wm', status: 'authorization_pending', sentChunks: 1,
      },
      chunks: {
        openKfId: 'wk', externalUserId: 'wm', status: 'generated', sentChunks: 0,
        responseChunks: ['chunk one', 'chunk two'],
      },
      tool: {
        openKfId: 'wk', externalUserId: 'wm', status: 'generated', sentChunks: 0,
        toolDispatches: [{ tool: 'send_text', arguments: { content: 'tool text' } }],
      },
      unrecoverable: {
        openKfId: 'wk', externalUserId: 'wm', status: 'generated', sentChunks: 0,
        outboundMessages: [{ type: 'link', url: 'https://example.com' }],
      },
      image: {
        openKfId: 'wk', externalUserId: 'wm', status: 'generated', sentChunks: 1,
        toolDispatches: [{
          tool: 'send_generated_image',
          arguments: { revisedPrompt: 'make it blue', byteLength: 10 },
        }],
        sendReceipts: [{
          sentType: 'image', status: 'accepted', wecomMsgId: 'wx-image', acceptedAt: 2,
        }],
      },
    },
  }));
  migrateLegacyState({
    jsonFilePath: json,
    databaseFilePath: target,
    backupSources: false,
  });
  const store = new SqliteStore({ filePath: target });
  t.after(() => store.close());

  const authKey = stableMessageKey('wk', 'auth');
  assert.equal(store.getInbound(authKey)?.status, 'ready');
  assert.equal(inspectAttempts(store.database, authKey)[0]?.status, 'pending');
  const authUncertain = stableMessageKey('wk', 'auth-uncertain');
  assert.equal(store.getInbound(authUncertain)?.status, 'completed');
  assert.equal(
    inspectAttempts(store.database, authUncertain)[0]?.status,
    'uncertain',
  );
  for (const [id, expected] of [['chunks', 2], ['tool', 1]] as const) {
    const key = stableMessageKey('wk', id);
    assert.equal(store.getInbound(key)?.status, 'ready');
    assert.equal(inspectAttempts(store.database, key).length, expected);
  }
  const badKey = stableMessageKey('wk', 'unrecoverable');
  assert.equal(store.getInbound(badKey)?.status, 'failed');
  assert.match(store.getInbound(badKey)?.errorMessage || '', /legacy_unrecoverable/u);
  const image = store.getLatestGeneratedImageDelivery({
    openKfId: 'wk', externalUserId: 'wm',
  });
  assert.equal(image?.accepted, true);
  assert.equal(image?.metadata.revisedPrompt, 'make it blue');

  const emptyReady = store.database.prepare(`
    SELECT COUNT(*) AS count FROM inbound_messages AS inbound
    WHERE inbound.status = 'ready' AND NOT EXISTS (
      SELECT 1 FROM send_attempts AS attempt
      WHERE attempt.source_message_key = inbound.message_key
        AND attempt.status = 'pending'
    )
  `).get() as { count: number };
  assert.equal(Number(emptyReady.count), 0);
});

test('[D02] backup rename failure warns after installing a valid database', (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const target = path.join(root, 'state.sqlite');
  const now = Date.UTC(2026, 7, 23, 4, 0, 0);
  writeState(json, baseState());
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-');
  const blockedDestination = `${json}.migrated-${stamp}.bak`;
  fs.mkdirSync(blockedDestination);
  fs.writeFileSync(path.join(blockedDestination, 'keep'), 'occupied');
  const warnings: string[] = [];
  const result = migrateLegacyState({
    jsonFilePath: json,
    databaseFilePath: target,
    clock: () => now,
    logger: {
      info() {},
      warn: (message) => { warnings.push(message); },
      error() {},
    },
  });
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(json), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || '', /backup rename failed/u);
  const store = new SqliteStore({ filePath: target });
  assert.deepEqual(store.integrityCheck().map(Object.values), [['ok']]);
  store.close();
});

test('[D02] partially sent legacy text batch preserves every remaining chunk', (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const target = path.join(root, 'state.sqlite');
  writeState(json, baseState({
    messages: {
      partial: {
        openKfId: 'wk-partial',
        externalUserId: 'wm-partial',
        status: 'generated',
        sentChunks: 1,
        outboundMessages: [
          { type: 'text', content: 'first' },
          { type: 'text', content: 'second' },
        ],
        sendReceipts: [{
          sentType: 'text', status: 'accepted',
          wecomMsgId: 'wx-first', acceptedAt: 1,
        }],
      },
    },
  }));
  migrateLegacyState({
    jsonFilePath: json,
    databaseFilePath: target,
    backupSources: false,
  });
  const store = new SqliteStore({ filePath: target });
  t.after(() => store.close());
  const key = stableMessageKey('wk-partial', 'partial');
  const attempts = inspectAttempts(store.database, key);
  assert.deepEqual(attempts.map((attempt) => attempt.status), [
    'accepted',
    'pending',
  ]);
  const secondPayload = attempts[1]?.payload;
  assert.ok(secondPayload);
  assert.equal(
    (secondPayload.text as { content?: unknown }).content,
    'second',
  );
  assert.equal(store.getInbound(key)?.status, 'ready');
});

test('[D02][H05] legacy pause is imported once and never overrides a later resume', async (t) => {
  const root = directory(t);
  const json = path.join(root, 'state.json');
  const pause = path.join(root, 'bot-paused');
  const target = path.join(root, 'state.sqlite');
  writeState(json, baseState());
  fs.writeFileSync(pause, '', { mode: 0o600 });
  migrateLegacyState({
    jsonFilePath: json,
    pauseFilePath: pause,
    databaseFilePath: target,
    backupSources: false,
  });
  const store = new SqliteStore({ filePath: target });
  assert.equal(store.getRuntimeControl().paused, true);
  store.setRuntimePaused(false);
  store.close();

  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'CallbackToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-test',
    WECOM_KF_SECRET: 'secret',
    CODEX_ENABLED: 'true',
    WECOM_STATE_FILE: json,
    WECOM_BOT_PAUSE_FILE: pause,
    WECOM_DB_FILE: target,
  });
  const runtime = createRuntime({
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  await runtime.close();
  const reopened = new SqliteStore({ filePath: target });
  assert.equal(reopened.getRuntimeControl().paused, false);
  reopened.close();
});
