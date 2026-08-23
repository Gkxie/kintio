import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import type { TestContext } from 'node:test';

export interface TempSqliteOptions {
  prefix?: string;
  filename?: string;
}

export interface TempSqlite {
  directory: string;
  filePath: string;
  open(options?: DatabaseSyncOptions): DatabaseSync;
  cleanup(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function createTempSqlite(
  testContext: TestContext,
  {
    prefix = 'wechat-bot-sqlite-',
    filename = 'wecom.sqlite',
  }: TempSqliteOptions = {},
): Promise<TempSqlite> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(directory, filename);
  const connections = new Set<DatabaseSync>();
  let cleaned = false;

  function open(options?: DatabaseSyncOptions): DatabaseSync {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    const database =
      options === undefined
        ? new DatabaseSync(filePath)
        : new DatabaseSync(filePath, options);
    connections.add(database);
    return database;
  }

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    for (const database of connections) {
      try {
        database.close();
      } catch (error) {
        if (errorCode(error) !== 'ERR_INVALID_STATE') throw error;
      }
    }
    connections.clear();
    await fs.rm(directory, { recursive: true, force: true });
  }

  testContext.after(() => cleanup());
  return { directory, filePath, open, cleanup };
}
