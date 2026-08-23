#!/usr/bin/env node

import { loadConfig } from '../src/config.ts';
import {
  SqliteStore,
  assertLegacyMigrationReady,
} from '../src/state/sqlite-store.ts';

const COMMANDS = ['pause', 'resume', 'status'] as const;
type RuntimeControlCommand = (typeof COMMANDS)[number];

function isRuntimeControlCommand(value: string): value is RuntimeControlCommand {
  return COMMANDS.some((command) => command === value);
}

const argument = process.argv[2] ?? 'status';
if (!isRuntimeControlCommand(argument)) {
  throw new Error('Usage: runtime-control [pause|resume|status]');
}
const command: RuntimeControlCommand = argument;
const config = loadConfig();
assertLegacyMigrationReady({
  databaseFile: config.state.databaseFile,
  legacyStateFile: config.state.legacyStateFile,
});
const store = new SqliteStore({ filePath: config.state.databaseFile });
try {
  const state =
    command === 'status'
      ? store.getRuntimeControl()
      : store.setRuntimePaused(command === 'pause');
  process.stdout.write(
    `${state.paused ? 'paused' : 'running'} epoch=${state.automationEpoch}\n`,
  );
} finally {
  store.close();
}
