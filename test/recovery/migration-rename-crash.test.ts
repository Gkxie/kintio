import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrateLegacyState } from '../../scripts/migrate-legacy.ts';
import {
  SqliteStore,
  type LegacyMessageRecord,
  type LegacyStateSnapshot,
} from '../../src/state/sqlite-store.ts';
import { startTestChild } from '../support/child-process.ts';
import { inspectMeta } from '../support/sqlite-inspect.ts';

const currentFile = fileURLToPath(import.meta.url);
const mode = process.argv[2] || '';

if (mode === '--migrate-worker') {
  migrateLegacyState({
    jsonFilePath: process.argv[3] || '',
    databaseFilePath: process.argv[4] || '',
    backupSources: false,
  });
} else {
  async function workspace(t: TestContext): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-crash-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
  }

  function largeState(count: number): LegacyStateSnapshot {
    const messages: Record<string, LegacyMessageRecord> = {};
    for (let index = 0; index < count; index += 1) {
      messages[`legacy-${index}`] = {
        openKfId: 'wk-migration',
        externalUserId: 'wm-migration',
        status: 'ignored',
        updatedAt: index + 1,
      };
    }
    return {
      version: 1,
      cursors: { 'wk-migration': 'legacy-cursor' },
      threads: {},
      sessions: {},
      customerAuthorizations: {},
      inboundMedia: {},
      messages,
    };
  }

  async function waitForTemporaryDatabase(
    directory: string,
    targetName: string,
    child: ReturnType<typeof startTestChild>['child'],
  ): Promise<string> {
    const prefix = `.${targetName}.migration-`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const match = (await fs.readdir(directory)).find(
        (name) => name.startsWith(prefix) && name.endsWith('.tmp'),
      );
      if (match) return path.join(directory, match);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Migration worker exited before a temporary DB was observable');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for migration temporary DB');
  }

  test('[D02] SIGKILL before atomic rename leaves legacy intact and reruns idempotently', async (t) => {
    const directory = await workspace(t);
    const legacyFile = path.join(directory, 'legacy.json');
    const targetFile = path.join(directory, 'state.sqlite');
    const fixture = JSON.stringify(largeState(30_000));
    await fs.writeFile(legacyFile, fixture, { mode: 0o600 });
    const original = await fs.readFile(legacyFile);

    const worker = startTestChild(t, currentFile, {
      args: ['--migrate-worker', legacyFile, targetFile],
      execArgv: ['--experimental-strip-types'],
      timeoutMs: 15_000,
    });
    const temporary = await waitForTemporaryDatabase(
      directory,
      path.basename(targetFile),
      worker.child,
    );
    await fs.access(temporary);
    assert.deepEqual(await worker.stop('SIGKILL'), {
      code: null,
      signal: 'SIGKILL',
    });
    assert.deepEqual(await fs.readFile(legacyFile), original);

    let installedBeforeRerun = false;
    try {
      await fs.access(targetFile);
      installedBeforeRerun = true;
      const installed = new SqliteStore({ filePath: targetFile });
      assert.deepEqual(installed.integrityCheck().map(Object.values), [['ok']]);
      assert.deepEqual(installed.foreignKeyCheck(), []);
      assert.ok(inspectMeta(installed.database, 'legacy_import_hash'));
      installed.close();
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }

    const rerun = migrateLegacyState({
      jsonFilePath: legacyFile,
      databaseFilePath: targetFile,
      backupSources: false,
    });
    assert.equal(rerun.migrated, !installedBeforeRerun);
    const finalStore = new SqliteStore({ filePath: targetFile });
    assert.deepEqual(finalStore.integrityCheck().map(Object.values), [['ok']]);
    assert.deepEqual(finalStore.foreignKeyCheck(), []);
    assert.equal(finalStore.getCursor('wk-migration'), 'legacy-cursor');
    const count = finalStore.database.prepare(`
      SELECT COUNT(*) AS count FROM inbound_messages
    `).get() as { count: number };
    assert.equal(Number(count.count), 30_000);
    finalStore.close();
    assert.deepEqual(await fs.readFile(legacyFile), original);
  });
}
