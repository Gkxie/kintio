import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { ensurePrivateDirectory } from '../../src/lib/private-directory.ts';

test('private directory helper creates targets without chmodding existing directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'private-directory-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o777);

  assert.equal(ensurePrivateDirectory(root), path.resolve(root));
  assert.equal((await fs.stat(root)).mode & 0o777, 0o777);

  const created = path.join(root, 'application-owned');
  assert.equal(ensurePrivateDirectory(created), path.resolve(created));
  assert.equal((await fs.stat(created)).mode & 0o777, 0o700);
});
