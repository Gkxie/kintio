import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { test } from 'vitest';

test('public CLI rejects Node 22 before importing the compiled application', () => {
  const binUrl = pathToFileURL(path.resolve('bin/kintio.js')).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `Object.defineProperty(process.versions, 'node', { value: '22.23.1' });` +
      `await import(${JSON.stringify(binUrl)});`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /requires Node\.js 24 or newer/u);
  assert.match(result.stderr, /current runtime is v22\.23\.1/u);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|SQLite|experimental/iu);
});
