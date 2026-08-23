import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  MAX_WECHAT_IMAGE_BYTES,
  cleanupStagedImageOrphans,
  detectImageFormat,
  withStagedImages,
} from '../../src/services/image-stager.js';

test('image stager detects formats by magic bytes instead of headers', () => {
  assert.deepEqual(
    detectImageFormat(Buffer.from('89504e470d0a1a0a', 'hex')),
    { extension: '.png', mimeType: 'image/png' },
  );
  assert.deepEqual(detectImageFormat(Buffer.from('ffd8ffe00000', 'hex')), {
    extension: '.jpg',
    mimeType: 'image/jpeg',
  });
  assert.deepEqual(detectImageFormat(Buffer.from('GIF89a', 'ascii')), {
    extension: '.gif',
    mimeType: 'image/gif',
  });
  assert.deepEqual(
    detectImageFormat(Buffer.from('RIFF0000WEBP', 'ascii')),
    { extension: '.webp', mimeType: 'image/webp' },
  );
  assert.deepEqual(detectImageFormat(Buffer.from('BM00', 'ascii')), {
    extension: '.bmp',
    mimeType: 'image/bmp',
  });
  assert.equal(detectImageFormat(Buffer.from('not-an-image')), null);
});

test('[C06][SEC04] staged image inputs use private files and always clean their directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-stage-test-'));
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
    'hex',
  );
  let stagedPath: string | undefined;
  const result = await withStagedImages(
    [{ bytes: png }],
    { temporaryRoot: root },
    async (imagePaths) => {
      const imagePath = imagePaths[0];
      assert.ok(imagePath);
      stagedPath = imagePath;
      assert.equal((await fs.stat(path.dirname(imagePath))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(imagePath)).mode & 0o777, 0o600);
      assert.deepEqual(await fs.readFile(imagePath), png);
      return 'done';
    },
  );
  assert.equal(result, 'done');
  assert.ok(stagedPath);
  await assert.rejects(fs.access(stagedPath), { code: 'ENOENT' });

  await assert.rejects(
    withStagedImages(
      [{ bytes: png }],
      { temporaryRoot: root },
      async () => {
        throw new Error('operation failed');
      },
    ),
    /operation failed/u,
  );
  assert.deepEqual(await fs.readdir(root), []);

  const orphan = path.join(root, 'wechat-codex-image-crashed-turn');
  const unrelated = path.join(root, 'keep-me');
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, 'customer.png'), png);
  await fs.mkdir(unrelated);
  cleanupStagedImageOrphans(root);
  await assert.rejects(fs.access(orphan), { code: 'ENOENT' });
  await fs.access(unrelated);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  await fs.rm(root, { recursive: true, force: true });
});

test('staging rejects empty, oversized, and unknown image bytes', async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-stage-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const invalidCases: ReadonlyArray<readonly [string, Buffer, RegExp]> = [
    ['empty', Buffer.alloc(0), /empty/u],
    ['oversized', Buffer.alloc(MAX_WECHAT_IMAGE_BYTES + 1), /2 MiB/u],
    ['unknown', Buffer.from('not an image'), /not a supported/u],
  ];
  for (const [name, bytes, expected] of invalidCases) {
    await t.test(name, async () => {
      await assert.rejects(
        withStagedImages(
          [{ bytes }],
          { temporaryRoot: root },
          async () => {},
        ),
        expected,
      );
    });
  }
});
