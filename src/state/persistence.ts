import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { IlinkLoginStore } from '../ilink/login-store.ts';
import type { IlinkSecretBox } from '../ilink/secret-box.ts';
import { IlinkSqliteStore } from '../ilink/sqlite-store.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';
import {
  secureSqliteFiles,
  SqliteStore,
  type CoreState,
} from './sqlite-store.ts';

interface StatePersistenceOptions {
  readonly filePath: string;
  readonly clock?: () => number;
  readonly journalMode?: 'WAL' | 'DELETE';
}

interface IlinkStoreOptions {
  readonly clock?: () => number;
}

interface IlinkLoginStoreOptions {
  readonly secretBox: IlinkSecretBox;
  readonly clock?: () => number;
}

export class StatePersistenceUnclosedError extends AggregateError {
  constructor(errors: readonly unknown[], message: string) {
    super(errors, message);
    this.name = 'StatePersistenceUnclosedError';
  }
}

export class StatePersistence {
  readonly #database: DatabaseSync;
  readonly core: CoreState;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  constructor(options: StatePersistenceOptions) {
    if (!options.filePath) throw new Error('SQLite filePath is required');
    if (
      options.journalMode !== undefined &&
      !['WAL', 'DELETE'].includes(options.journalMode)
    ) {
      throw new Error(`Unsupported SQLite journal mode: ${options.journalMode}`);
    }
    const filePath = path.resolve(options.filePath);
    ensurePrivateDirectory(path.dirname(filePath));
    this.#database = new DatabaseSync(filePath);
    try {
      this.core = new SqliteStore({
        filePath,
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.journalMode ? { journalMode: options.journalMode } : {}),
      }, {
        database: this.#database,
      });
    } catch (error) {
      try {
        this.#database.close();
      } catch (closeError) {
        throw new StatePersistenceUnclosedError(
          [error, closeError],
          'SQLite initialization and cleanup both failed',
        );
      }
      throw error;
    }
  }

  static hasActiveWriter(filePath: string): boolean {
    try {
      fs.statSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(filePath);
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('BEGIN IMMEDIATE');
      database.exec('ROLLBACK');
      return false;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        String(error.code) === 'ERR_SQLITE_ERROR' &&
        /busy|locked/iu.test(error.message)
      ) {
        return true;
      }
      throw error;
    } finally {
      database?.close();
    }
  }

  createIlinkStore(options: IlinkStoreOptions = {}): IlinkSqliteStore {
    this.#assertOpen();
    return new IlinkSqliteStore({
      database: this.#database,
      inbox: this.core,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  createIlinkLoginStore(options: IlinkLoginStoreOptions): IlinkLoginStore {
    this.#assertOpen();
    return new IlinkLoginStore({
      store: this.core,
      database: this.#database,
      secretBox: options.secretBox,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  close(): void {
    if (this.#closed) return;
    let secureError: unknown;
    try {
      secureSqliteFiles(this.core.filePath);
    } catch (error) {
      secureError = error;
    }
    try {
      this.#database.close();
    } catch (closeError) {
      if (secureError !== undefined) {
        throw new StatePersistenceUnclosedError(
          [secureError, closeError],
          'SQLite file hardening and close both failed',
        );
      }
      throw closeError;
    }
    this.#closed = true;
    if (secureError !== undefined) throw secureError;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('State persistence is closed');
  }
}
