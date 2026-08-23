#!/usr/bin/env node

import { loadConfig } from '../src/config.ts';
import {
  SqliteStore,
  assertLegacyMigrationReady,
} from '../src/state/sqlite-store.ts';

const [command = 'status', externalUserId = ''] = process.argv.slice(2);
if (!['status', 'revoke'].includes(command) || !externalUserId) {
  throw new Error(
    'Usage: pnpm run auth -- <status|revoke> <external_userid>',
  );
}

const config = loadConfig();
assertLegacyMigrationReady({
  databaseFile: config.state.databaseFile,
  legacyStateFile: config.state.legacyStateFile,
});
const store = new SqliteStore({ filePath: config.state.databaseFile });
try {
  const authorization =
    command === 'revoke'
      ? store.revokeAuthorization(externalUserId)
      : store.getAuthorization(externalUserId);
  process.stdout.write(
    `${externalUserId}: ${authorization?.authorized ? 'authorized' : 'unauthorized'}\n`,
  );
} finally {
  store.close();
}
