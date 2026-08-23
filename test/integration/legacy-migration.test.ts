import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { migrateLegacyState } from '../../scripts/migrate-legacy.js';
import {
  SqliteStore,
  type LegacyStateSnapshot,
  stableMessageKey,
} from '../../src/state/sqlite-store.js';
import { inspectAttempts } from '../support/sqlite-inspect.js';

function tempDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeLegacyJournal(filePath: string): void {
  const database = new DatabaseSync(filePath);
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
  database
    .prepare(`
      INSERT INTO send_attempts (
        attempt_key, fingerprint, sent_type, client_message_id, status,
        wecom_msg_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'wk-a:wm-a:sent-message:0',
      'legacy-fingerprint',
      'text',
      'legacy-client-id',
      'accepted',
      'legacy-wecom-id',
      1_700_000_000_500,
    );
  database
    .prepare(`
      INSERT INTO send_attempts (
        attempt_key, fingerprint, sent_type, client_message_id, status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      'unparseable-legacy-key',
      'orphan-fingerprint',
      'image',
      'orphan-client-id',
      'sending',
      1_700_000_000_600,
    );
  database.close();
}

function legacyState(): LegacyStateSnapshot {
  return {
    version: 1,
    cursors: { 'wk-a': 'legacy-cursor' },
    threads: { 'wk-a:wm-a': 'thread-old' },
    sessions: {
      'wk-a:wm-a': {
        mode: 'human',
        servicerUserId: 'zhangsan',
        source: 'origin_5',
        updatedAt: 1_700_000_000_100,
      },
    },
    customerAuthorizations: {
      'wm-a': {
        authorized: true,
        consecutiveMatches: 3,
        openKfId: 'wk-a',
        lastMessageId: 'sent-message',
        authorizedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
      },
    },
    messages: {
      'processing-message': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'processing',
        inboundMessage: {
          id: 'processing-message',
          origin: 'customer',
          type: 'text',
          sentAt: 10,
          text: '尚未完成',
          conversation: { openKfId: 'wk-a', externalUserId: 'wm-a' },
        },
        updatedAt: 1_700_000_000_200,
      },
      'steered-message': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'steered',
        primaryMessageId: 'processing-message',
        inboundMessage: {
          id: 'steered-message',
          origin: 'customer',
          type: 'text',
          sentAt: 11,
          text: '调整方向',
          conversation: { openKfId: 'wk-a', externalUserId: 'wm-a' },
        },
        updatedAt: 1_700_000_000_300,
      },
      'sent-message': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'sent',
        sendReceipts: [
          {
            wecomMsgId: 'legacy-wecom-id',
            sentType: 'text',
            status: 'accepted',
            acceptedAt: 1_700_000_000_500,
          },
        ],
        updatedAt: 1_700_000_000_500,
      },
      'authorization-message': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'authorization_pending',
        sentChunks: 0,
        updatedAt: 1_700_000_000_550,
      },
      'generated-text': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'generated',
        sentChunks: 0,
        outboundMessages: [{ type: 'text', content: '恢复的旧回复' }],
        updatedAt: 1_700_000_000_560,
      },
      'generated-unrecoverable': {
        openKfId: 'wk-a',
        externalUserId: 'wm-a',
        status: 'generated',
        sentChunks: 0,
        outboundMessages: [{ type: 'link', url: 'https://example.com' }],
        updatedAt: 1_700_000_000_570,
      },
    },
    inboundMedia: {
      'wk-a:wm-a': [
        {
          messageId: 'sent-message',
          kind: 'image',
          mediaId: 'legacy-media-id',
          filename: 'photo.jpg',
          sentAt: 9,
          rememberedAt: 1_700_000_000_400,
        },
      ],
    },
  };
}

test('[D02] legacy JSON and journal migrate once into the unified SQLite schema', (t) => {
  const directory = tempDirectory(t);
  const jsonFilePath = path.join(directory, 'wecom-state.json');
  const journalFilePath = path.join(directory, 'wecom-tool-journal.sqlite');
  const databaseFilePath = path.join(directory, 'wecom.sqlite');
  fs.writeFileSync(jsonFilePath, JSON.stringify(legacyState()), { mode: 0o600 });
  writeLegacyJournal(journalFilePath);

  const first = migrateLegacyState({
    jsonFilePath,
    journalFilePath,
    databaseFilePath,
    backupSources: false,
    clock: () => 1_700_000_001_000,
  });
  assert.equal(first.migrated, true);
  assert.ok(first.summary);
  assert.equal(first.summary.messages, 6);
  assert.equal(first.summary.journalEntries, 2);

  const store = new SqliteStore({ filePath: databaseFilePath });
  assert.equal(store.getCursor('wk-a'), 'legacy-cursor');
  assert.deepEqual(store.getConversation('wk-a', 'wm-a'), {
    openKfId: 'wk-a',
    externalUserId: 'wm-a',
    threadId: 'thread-old',
    mode: 'human',
    automationEpoch: 0,
    servicerUserId: 'zhangsan',
    source: 'origin_5',
    changeType: 0,
    updatedAt: 1_700_000_000_100,
  });
  const authorization = store.getAuthorization('wm-a');
  assert.ok(authorization);
  assert.equal(authorization.authorized, true);
  const primaryKey = stableMessageKey('wk-a', 'processing-message');
  const steerKey = stableMessageKey('wk-a', 'steered-message');
  const primary = store.getInbound(primaryKey);
  const steer = store.getInbound(steerKey);
  assert.ok(primary?.payload);
  assert.ok(steer);
  assert.equal(primary.status, 'processing');
  assert.equal(primary.payload.text, '尚未完成');
  assert.equal(steer.primaryMessageKey, primaryKey);
  const media = store.listRecentMedia({
    openKfId: 'wk-a',
    externalUserId: 'wm-a',
    maxAgeMs: Number.MAX_SAFE_INTEGER,
  })[0];
  assert.ok(media);
  assert.equal(
    media.mediaId,
    'legacy-media-id',
  );
  const sentKey = stableMessageKey('wk-a', 'sent-message');
  const attempt = inspectAttempts(store.database, sentKey)[0];
  assert.ok(attempt);
  assert.equal(attempt.status, 'accepted');
  assert.equal(attempt.wecomMsgId, 'legacy-wecom-id');
  assert.equal(attempt.clientMessageId, 'legacy-client-id');
  const orphan = inspectAttempts(store.database)
    .find((item) => item.clientMessageId === 'orphan-client-id');
  assert.ok(orphan);
  assert.equal(orphan.status, 'uncertain');
  assert.equal(store.getInbound(orphan.messageKey)?.status, 'completed');
  const authorizationKey = stableMessageKey('wk-a', 'authorization-message');
  assert.equal(store.getInbound(authorizationKey)?.status, 'ready');
  assert.equal(
    inspectAttempts(store.database, authorizationKey)[0]?.status,
    'pending',
  );
  const generatedKey = stableMessageKey('wk-a', 'generated-text');
  assert.equal(store.getInbound(generatedKey)?.status, 'ready');
  assert.deepEqual(
    inspectAttempts(store.database, generatedKey)[0]?.payload,
    { msgtype: 'text', text: { content: '恢复的旧回复' } },
  );
  const unrecoverableKey = stableMessageKey(
    'wk-a',
    'generated-unrecoverable',
  );
  const unrecoverable = store.getInbound(unrecoverableKey);
  assert.equal(unrecoverable?.status, 'failed');
  assert.match(unrecoverable?.errorMessage || '', /legacy_unrecoverable/u);
  assert.deepEqual(store.foreignKeyCheck(), []);
  store.close();

  const second = migrateLegacyState({
    jsonFilePath,
    journalFilePath,
    databaseFilePath,
    backupSources: false,
  });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already_migrated');
});

test('[D02] successful migration can archive legacy sources without deleting them', (t) => {
  const directory = tempDirectory(t);
  const jsonFilePath = path.join(directory, 'wecom-state.json');
  const journalFilePath = path.join(directory, 'wecom-tool-journal.sqlite');
  const databaseFilePath = path.join(directory, 'wecom.sqlite');
  fs.writeFileSync(jsonFilePath, JSON.stringify(legacyState()), { mode: 0o600 });
  writeLegacyJournal(journalFilePath);

  const result = migrateLegacyState({
    jsonFilePath,
    journalFilePath,
    databaseFilePath,
    backupSources: true,
    clock: () => Date.UTC(2026, 7, 23, 4, 0, 0),
  });
  assert.equal(result.migrated, true);
  assert.ok(result.backups);
  assert.equal(result.backups.length, 2);
  assert.equal(fs.existsSync(jsonFilePath), false);
  assert.equal(fs.existsSync(journalFilePath), false);
  for (const backup of result.backups) assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.existsSync(databaseFilePath), true);
  assert.deepEqual(
    migrateLegacyState({ jsonFilePath, journalFilePath, databaseFilePath }),
    {
      migrated: false,
      reason: 'already_migrated',
      importHash: result.importHash,
    },
  );
});

test('[D02] invalid legacy state leaves source files untouched and installs no DB', (t) => {
  const directory = tempDirectory(t);
  const jsonFilePath = path.join(directory, 'wecom-state.json');
  const databaseFilePath = path.join(directory, 'wecom.sqlite');
  fs.writeFileSync(jsonFilePath, '{not-json', { mode: 0o600 });
  assert.throws(
    () => migrateLegacyState({ jsonFilePath, databaseFilePath }),
    /Unable to parse legacy JSON state/,
  );
  assert.equal(fs.readFileSync(jsonFilePath, 'utf8'), '{not-json');
  assert.equal(fs.existsSync(databaseFilePath), false);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.migration-')),
    [],
  );
});

test('[D02] an existing unmarked target is never initialized or overwritten', (t) => {
  const directory = tempDirectory(t);
  const jsonFilePath = path.join(directory, 'wecom-state.json');
  const databaseFilePath = path.join(directory, 'wecom.sqlite');
  fs.writeFileSync(jsonFilePath, JSON.stringify(legacyState()), { mode: 0o600 });
  const existing = new DatabaseSync(databaseFilePath);
  existing.exec('CREATE TABLE unrelated (value TEXT)');
  existing.close();
  const before = fs.readFileSync(databaseFilePath);
  assert.throws(
    () => migrateLegacyState({ jsonFilePath, databaseFilePath }),
    /without a legacy import marker/,
  );
  assert.deepEqual(fs.readFileSync(databaseFilePath), before);
  const verify = new DatabaseSync(databaseFilePath, { readOnly: true });
  assert.deepEqual(
    (verify
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[])
      .map((row) => row.name),
    ['unrelated'],
  );
  verify.close();
});
