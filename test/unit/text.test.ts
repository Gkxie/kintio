import assert from 'node:assert/strict';
import test from 'node:test';

import { splitUtf8, truncateUtf8 } from '../../src/lib/text.js';

test('UTF-8 splitting does not break multibyte characters', () => {
  const chunks = splitUtf8('你好abc', 6);

  assert.deepEqual(chunks, ['你好', 'abc']);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 6));
});

test('UTF-8 truncation reserves room for the suffix', () => {
  const result = truncateUtf8('你'.repeat(10), 14, '...');

  assert.equal(Buffer.byteLength(result), 12);
  assert.equal(result, '你你你...');
});
