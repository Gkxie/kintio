import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import type { TestContext } from 'vitest';

import { IlinkLoginStore } from '../../src/ilink/login-store.ts';
import type { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { IlinkSqliteStore } from '../../src/ilink/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { SqliteStore, type CoreState } from '../../src/state/sqlite-store.ts';

export interface TempSqliteOptions {
  prefix?: string;
  filename?: string;
}

export interface TempSqlite {
  directory: string;
  filePath: string;
  trackSqlite<T extends { close(): void }>(resource: T): T;
  open(options?: DatabaseSyncOptions): DatabaseSync;
  openPersistence(options?: TestPersistenceOptions): StatePersistence;
  openInjectedPersistenceForTest(
    options?: TestPersistenceOptions,
  ): InjectedTestPersistence;
  withDatabase<T>(operation: (database: DatabaseSync) => T): T;
  cleanup(): Promise<void>;
}

interface TestPersistenceOptions {
  clock?: () => number;
  journalMode?: 'WAL' | 'DELETE';
}

/**
 * Test-only same-connection seam for SQLite fault injection and instrumentation.
 * Application-facing tests should use openPersistence() and JS state methods.
 */
interface InjectedTestPersistence {
  readonly database: DatabaseSync;
  readonly core: CoreState;
  createIlinkStore(options?: { readonly clock?: () => number }): IlinkSqliteStore;
  createIlinkLoginStore(options: {
    readonly secretBox: IlinkSecretBox;
    readonly clock?: () => number;
  }): IlinkLoginStore;
  close(): void;
}

export function withTestDatabase<T>(
  filePath: string,
  operation: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(filePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA foreign_keys = ON');
    return operation(database);
  } finally {
    database.close();
  }
}

export function openInjectedTestPersistence(
  filePath: string,
  options: TestPersistenceOptions = {},
): InjectedTestPersistence {
  const database = new DatabaseSync(filePath);
  let core: SqliteStore;
  try {
    core = new SqliteStore({
      filePath,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.journalMode ? { journalMode: options.journalMode } : {}),
    }, { database });
  } catch (error) {
    database.close();
    throw error;
  }
  let closed = false;
  return {
    database,
    core,
    createIlinkStore(ilinkOptions = {}) {
      if (closed) throw new Error('Test persistence is closed');
      return new IlinkSqliteStore({
        database,
        inbox: core,
        ...(ilinkOptions.clock ? { clock: ilinkOptions.clock } : {}),
      });
    },
    createIlinkLoginStore(loginOptions) {
      if (closed) throw new Error('Test persistence is closed');
      return new IlinkLoginStore({
        store: core,
        database,
        secretBox: loginOptions.secretBox,
        ...(loginOptions.clock ? { clock: loginOptions.clock } : {}),
      });
    },
    close() {
      if (closed) return;
      try {
        database.close();
      } finally {
        closed = true;
      }
    },
  };
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
    prefix = 'kintio-sqlite-',
    filename = 'wecom.sqlite',
  }: TempSqliteOptions = {},
): Promise<TempSqlite> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(directory, filename);
  const connections = new Set<{ close(): void }>();
  let cleaned = false;

  function trackSqlite<T extends { close(): void }>(resource: T): T {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    connections.add(resource);
    return resource;
  }

  function open(options?: DatabaseSyncOptions): DatabaseSync {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    const database =
      options === undefined
        ? new DatabaseSync(filePath)
        : new DatabaseSync(filePath, options);
    return trackSqlite(database);
  }

  function openPersistence(options: TestPersistenceOptions = {}): StatePersistence {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    return trackSqlite(new StatePersistence({
      filePath,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.journalMode ? { journalMode: options.journalMode } : {}),
    }));
  }

  function openInjectedPersistenceForTest(
    options: TestPersistenceOptions = {},
  ): InjectedTestPersistence {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    return trackSqlite(openInjectedTestPersistence(filePath, options));
  }

  function withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    if (cleaned) throw new Error('Temporary SQLite workspace is already cleaned');
    return withTestDatabase(filePath, operation);
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

  testContext.onTestFinished(() => cleanup());
  return {
    directory,
    filePath,
    trackSqlite,
    open,
    openPersistence,
    openInjectedPersistenceForTest,
    withDatabase,
    cleanup,
  };
}
