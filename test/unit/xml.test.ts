import assert from 'node:assert/strict';
import { test } from 'vitest';

import { extractXmlTag } from '../../src/lib/xml.ts';

test('XML extraction supports plain text, CDATA, attributes, and missing tags', () => {
  assert.equal(extractXmlTag('<xml><Value> text </Value></xml>', 'Value'), 'text');
  assert.equal(
    extractXmlTag('<xml><Value type="x"><![CDATA[<safe>]]></Value></xml>', 'Value'),
    '<safe>',
  );
  assert.equal(extractXmlTag('<xml><Value></Value></xml>', 'Value'), '');
  assert.equal(extractXmlTag('<xml></xml>', 'Value'), '');
  assert.throws(() => extractXmlTag('<xml/>', '../Value'), /Invalid XML tag/u);
});
