import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImageFormat } from '../src/services/image-stager.js';

test('image stager detects formats by magic bytes instead of headers', () => {
  assert.deepEqual(
    detectImageFormat(Buffer.from('89504e470d0a1a0a', 'hex')),
    { extension: '.png', mimeType: 'image/png' },
  );
  assert.deepEqual(detectImageFormat(Buffer.from('ffd8ffe00000', 'hex')), {
    extension: '.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(detectImageFormat(Buffer.from('not-an-image')), null);
});
