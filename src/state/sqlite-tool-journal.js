import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function rowToEntry(row) {
  if (!row) return undefined;
  return {
    key: row.attempt_key,
    fingerprint: row.fingerprint,
    sentType: row.sent_type,
    clientMessageId: row.client_message_id,
    status: row.status,
    wecomMsgId: row.wecom_msg_id || '',
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    updatedAt: row.updated_at,
  };
}

export class SqliteToolJournal {
  constructor({ filePath }) {
    if (!filePath) throw new Error('Tool journal filePath is required');

    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = DELETE');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS send_attempts (
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
    this.#cleanup();
  }

  #cleanup() {
    this.database
      .prepare('DELETE FROM send_attempts WHERE updated_at < ?')
      .run(Date.now() - ENTRY_TTL_MS);
  }

  #get(key) {
    return rowToEntry(
      this.database
        .prepare('SELECT * FROM send_attempts WHERE attempt_key = ?')
        .get(key),
    );
  }

  async begin({ key, fingerprint, sentType, clientMessageId }) {
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO send_attempts (
          attempt_key,
          fingerprint,
          sent_type,
          client_message_id,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, 'sending', ?)
      `)
      .run(key, fingerprint, sentType, clientMessageId, Date.now());
    const entry = this.#get(key);
    return { duplicate: result.changes === 0, entry };
  }

  async complete(key, receipt) {
    this.database
      .prepare(`
        UPDATE send_attempts
        SET status = 'accepted',
            wecom_msg_id = ?,
            sent_type = ?,
            error_code = '',
            error_message = '',
            updated_at = ?
        WHERE attempt_key = ?
      `)
      .run(
        String(receipt?.wecomMsgId || ''),
        String(receipt?.sentType || ''),
        Date.now(),
        key,
      );
    return this.#get(key);
  }

  async markUncertain(key, error) {
    this.database
      .prepare(`
        UPDATE send_attempts
        SET status = 'uncertain',
            error_code = ?,
            error_message = ?,
            updated_at = ?
        WHERE attempt_key = ?
      `)
      .run(
        String(error?.code || ''),
        String(error?.message || ''),
        Date.now(),
        key,
      );
    return this.#get(key);
  }

  async markFailed(key, error) {
    this.database
      .prepare(`
        UPDATE send_attempts
        SET status = 'failed',
            error_code = ?,
            error_message = ?,
            updated_at = ?
        WHERE attempt_key = ?
      `)
      .run(
        String(error?.code || ''),
        String(error?.message || ''),
        Date.now(),
        key,
      );
    return this.#get(key);
  }

  close() {
    this.database.close();
  }
}
