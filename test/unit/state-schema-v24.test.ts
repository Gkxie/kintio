import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { StatePersistence } from '../../src/state/persistence.ts';

interface SchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly tblName: string;
  readonly sql: string;
}

interface SchemaFixture {
  readonly userVersion: number;
  readonly hasSqliteSequence: boolean;
  readonly autoIndexCount: number;
  readonly entries: readonly SchemaEntry[];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

test('the production TypeScript store retains the frozen v24 logical schema', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-v24-schema-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state.sqlite');
  const state = new StatePersistence({ filePath, journalMode: 'DELETE' });
  state.close();

  const expected = JSON.parse(await fs.readFile(
    new URL('../fixtures/state-schema-v24.json', import.meta.url),
    'utf8',
  )) as SchemaFixture;
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const entries = (database.prepare(`
      SELECT type, name, tbl_name AS tblName, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY type, name
    `).all() as unknown as SchemaEntry[]).map((entry) => ({
      ...entry,
      sql: normalizeSql(String(entry.sql)),
    }));
    const userVersion = Number(
      database.prepare('PRAGMA user_version').get()?.user_version,
    );
    const hasSqliteSequence = Boolean(database.prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE name = 'sqlite_sequence'",
    ).get()?.found);
    const autoIndexCount = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%'",
    ).get()?.count);

    assert.deepEqual({ userVersion, hasSqliteSequence, autoIndexCount, entries }, expected);
    assert.equal(entries.filter((entry) => entry.type === 'table').length, 16);
    assert.equal(entries.filter((entry) => entry.type === 'index').length, 15);
    assert.equal(entries.filter((entry) => entry.type === 'trigger').length, 7);
    assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    database.close();
  }
});
