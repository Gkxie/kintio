import type { DatabaseSync } from 'node:sqlite';

export function inspectSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

export function inspectPragmas(database: DatabaseSync): {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeout: number;
} {
  const value = (pragma: string, key: string): unknown =>
    (database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[key];
  return {
    journalMode: String(value('journal_mode', 'journal_mode')),
    synchronous: Number(value('synchronous', 'synchronous')),
    foreignKeys: Number(value('foreign_keys', 'foreign_keys')),
    busyTimeout: Number(value('busy_timeout', 'timeout')),
  };
}
