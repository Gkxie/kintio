import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { test, vi } from 'vitest';

import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

const SQLITE_IMPLEMENTATIONS = new Set([
  'src/ilink/login-store.ts',
  'src/ilink/sqlite-store.ts',
  'src/state/persistence.ts',
  'src/state/sqlite-store.ts',
]);

async function sourceFiles(directory = 'src'): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : Promise.resolve(
          entry.isFile() && file.endsWith('.ts')
            ? [file.split(path.sep).join('/')]
            : [],
        );
  }));
  return nested.flat().sort();
}

test('raw SQLite imports remain inside the persistence implementation boundary', async () => {
  const imports: string[] = [];
  const coreConstructors: string[] = [];
  const ilinkConstructors: string[] = [];
  const loginConstructors: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await fs.readFile(file, 'utf8');
    if (/from ['"]node:sqlite['"]/u.test(source)) imports.push(file);
    if (/\bnew SqliteStore\s*\(/u.test(source)) coreConstructors.push(file);
    if (/\bnew IlinkSqliteStore\s*\(/u.test(source)) ilinkConstructors.push(file);
    if (/\bnew IlinkLoginStore\s*\(/u.test(source)) loginConstructors.push(file);
  }
  assert.deepEqual(imports, [...SQLITE_IMPLEMENTATIONS].sort());
  assert.deepEqual(coreConstructors, ['src/state/persistence.ts']);
  assert.deepEqual(ilinkConstructors, ['src/state/persistence.ts']);
  assert.deepEqual(loginConstructors, ['src/state/persistence.ts']);
});

test('application state facades expose methods without a raw database handle', async (t) => {
  const temporary = await createTempSqlite(t, { prefix: 'persistence-boundary-' });
  const persistence = temporary.openPersistence();
  const ilink = persistence.createIlinkStore();
  const login = persistence.createIlinkLoginStore({
    secretBox: new IlinkSecretBox(Buffer.alloc(32, 31).toString('base64url')),
  });

  for (const value of [persistence, persistence.core, ilink, login]) {
    assert.equal('database' in value, false);
  }
  assert.equal('close' in persistence.core, false);
  persistence.close();
  persistence.close();
  assert.throws(
    () => persistence.createIlinkStore(),
    /State persistence is closed/u,
  );
});

test('writer probing distinguishes a live writer from corruption', async (t) => {
  const temporary = await createTempSqlite(t, { prefix: 'persistence-writer-' });
  assert.equal(
    StatePersistence.hasActiveWriter(path.join(temporary.directory, 'missing.sqlite')),
    false,
  );
  const persistence = temporary.openPersistence();
  persistence.close();
  const writer = temporary.open();
  writer.exec('BEGIN IMMEDIATE');
  assert.equal(StatePersistence.hasActiveWriter(temporary.filePath), true);
  writer.exec('ROLLBACK');
  assert.equal(StatePersistence.hasActiveWriter(temporary.filePath), false);

  const corrupt = path.join(temporary.directory, 'corrupt.sqlite');
  await fs.writeFile(corrupt, 'not a sqlite database');
  assert.throws(() => StatePersistence.hasActiveWriter(corrupt));
});

test('a failed physical close remains retryable and commits closed state once', async (t) => {
  const temporary = await createTempSqlite(t, { prefix: 'persistence-close-' });
  const persistence = temporary.openPersistence();
  const nativeClose = DatabaseSync.prototype.close;
  let calls = 0;
  const close = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(
    function (this: DatabaseSync) {
      calls += 1;
      if (calls === 1) throw new Error('injected physical close failure');
      return nativeClose.call(this);
    },
  );
  t.onTestFinished(() => close.mockRestore());

  assert.equal(persistence.closed, false);
  assert.throws(() => persistence.close(), /injected physical close failure/u);
  assert.equal(persistence.closed, false);
  assert.doesNotThrow(() => persistence.close());
  assert.equal(persistence.closed, true);
  assert.doesNotThrow(() => persistence.close());
  assert.equal(calls, 2);
});
