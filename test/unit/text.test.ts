import assert from 'node:assert/strict';
import { test } from 'vitest';

import { truncateUtf8 } from '../../src/lib/text.ts';

test('UTF-8 truncation reserves room for the suffix', () => {
  const result = truncateUtf8('你'.repeat(10), 14, '...');

  assert.equal(Buffer.byteLength(result), 12);
  assert.equal(result, '你你你...');
});
