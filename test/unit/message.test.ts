import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  isProcessableCustomerMessage,
  isSystemEvent,
  renderMessageForAgent,
} from '../../src/domain/message.ts';

test('normalized customer types are provider-independent except reserved values', () => {
  assert.equal(isProcessableCustomerMessage({
    origin: 'customer',
    type: 'feishu_post',
  }), true);
  assert.equal(isProcessableCustomerMessage({ origin: 'system', type: 'feishu_post' }), false);
  assert.equal(isProcessableCustomerMessage({ origin: 'customer', type: 'event' }), false);
  assert.equal(isProcessableCustomerMessage({ origin: 'customer', type: 'unknown' }), false);
  assert.equal(isProcessableCustomerMessage({ origin: 'customer', type: '' }), false);
  assert.equal(isProcessableCustomerMessage({ origin: 'customer', type: '  ' }), false);
  assert.equal(isSystemEvent({ origin: 'system', type: 'event' }), true);
  assert.equal(isSystemEvent({ origin: 'customer', type: 'event' }), false);

  assert.equal(renderMessageForAgent({ summary: 'structured', text: 'raw' }), 'structured');
  assert.equal(renderMessageForAgent({ summary: '', text: 'raw' }), 'raw');
  assert.equal(
    renderMessageForAgent({ summary: '', text: '' }),
    '[Channel message: no readable summary]',
  );
});
