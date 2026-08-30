import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  matchesReadyMarker,
  readyMarkerPath,
  writeReadyMarker,
} from '../../src/runtime/ready-marker.ts';

test('readiness requires the current start token and PM2 worker PID', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-ready-marker-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const first = 'a'.repeat(43);
  const second = 'b'.repeat(43);

  writeReadyMarker(root, first, 1234);
  assert.equal(matchesReadyMarker(root, first, 1234), true);
  assert.equal(matchesReadyMarker(root, second, 1234), false);
  assert.equal(matchesReadyMarker(root, first, 5678), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(readyMarkerPath(root))).mode & 0o777, 0o600);
  }

  writeReadyMarker(root, second, 5678);
  assert.equal(matchesReadyMarker(root, first, 1234), false);
  assert.equal(matchesReadyMarker(root, second, 5678), true);
});

test('invalid, corrupt, or linked readiness evidence fails closed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-ready-negative-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  assert.throws(() => writeReadyMarker(root, 'short', 1), /Invalid/u);
  assert.equal(matchesReadyMarker(root, 'a'.repeat(43), 1), false);

  await fs.mkdir(path.dirname(readyMarkerPath(root)), { recursive: true });
  await fs.writeFile(readyMarkerPath(root), 'not json\n');
  assert.equal(matchesReadyMarker(root, 'a'.repeat(43), 1), false);

  await fs.rm(readyMarkerPath(root));
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, JSON.stringify({
    token: 'a'.repeat(43), pid: 1, readyAt: new Date().toISOString(),
  }));
  await fs.symlink(outside, readyMarkerPath(root));
  assert.equal(matchesReadyMarker(root, 'a'.repeat(43), 1), false);
});
