import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { isPathInside, samePath } from '../../src/lib/path-identity.ts';

test('path identity follows the host filesystem and rejects sibling escapes', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-path-'));
  const root = path.join(temporary, 'Root');
  const child = path.join(root, 'Child');
  const sibling = path.join(temporary, 'Sibling');
  await Promise.all([
    fs.mkdir(child, { recursive: true }),
    fs.mkdir(sibling, { recursive: true }),
  ]);
  t.onTestFinished(() => fs.rm(temporary, { recursive: true, force: true }));

  assert.equal(samePath(root, path.join(root, '.')), true);
  assert.equal(isPathInside(root, child), true);
  assert.equal(isPathInside(root, path.join(root, 'future', 'file')), true);
  assert.equal(isPathInside(root, sibling), false);

  const alternateCase = root.toLowerCase();
  const alternateExists = await fs.access(alternateCase).then(
    () => true,
    () => false,
  );
  assert.equal(samePath(root, alternateCase), alternateExists);
});

test('path containment resolves directory links before accepting a child', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-path-link-'));
  const root = path.join(temporary, 'root');
  const outside = path.join(temporary, 'outside');
  const link = path.join(root, 'escape');
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.onTestFinished(() => fs.rm(temporary, { recursive: true, force: true }));

  assert.equal(isPathInside(root, link), false);
});
