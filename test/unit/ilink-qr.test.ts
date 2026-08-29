import assert from 'node:assert/strict';
import fs from 'node:fs';

import { test, vi } from 'vitest';

import {
  IlinkQrRenderError,
  renderIlinkQrPng,
} from '../../src/ilink/qr.ts';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

test('renders deterministic in-memory PNG bytes', async () => {
  const content =
    'https://liteapp.weixin.qq.com/q/example?qrcode=opaque-value&bot_type=3';
  const first = await renderIlinkQrPng(content);
  const second = await renderIlinkQrPng(content);

  assert.ok(Buffer.isBuffer(first));
  assert.ok(first.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
  assert.ok(first.length > PNG_SIGNATURE.length);
  assert.ok(first.length <= 512 * 1_024);
  assert.deepEqual(first, second);
});

test('uses fixed medium correction, four-module margin, and eight-pixel scale', async () => {
  const png = await renderIlinkQrPng('A'.repeat(21));
  assert.equal(png.readUInt32BE(16), 264);
  assert.equal(png.readUInt32BE(20), 264);
});

test('enforces non-empty and 2048-byte UTF-8 input limits without echoing content', async () => {
  await assert.doesNotReject(renderIlinkQrPng('🙂'.repeat(512)));

  const secret = `qr-secret-${'x'.repeat(2_048)}`;
  for (const invalid of ['', '   ', 'a'.repeat(2_049), '🙂'.repeat(513), secret]) {
    let captured: unknown;
    try {
      await renderIlinkQrPng(invalid);
    } catch (error: unknown) {
      captured = error;
    }
    assert.ok(captured instanceof IlinkQrRenderError);
    assert.equal(captured.code, 'invalid_qr_content');
    assert.equal(captured.message, 'Invalid iLink QR content');
    assert.doesNotMatch(captured.message, /qr-secret|x{16}/u);
  }
});

test('renders without network access or filesystem output', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('network access is forbidden'),
  );
  const fileSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation(() => {
    throw new Error('filesystem output is forbidden');
  });

  const png = await renderIlinkQrPng('offline-and-memory-only');
  assert.ok(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(fileSpy.mock.calls.length, 0);
});
