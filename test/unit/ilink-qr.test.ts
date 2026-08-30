import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PNG } from 'pngjs';
import { create } from 'qrcode';
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

test('renders a branded card with integer modules and a four-module quiet zone', async () => {
  const content = 'A'.repeat(21);
  const bytes = await renderIlinkQrPng(content);
  const card = PNG.sync.read(bytes);
  const template = PNG.sync.read(fs.readFileSync('assets/ilink-login-card.png'));
  assert.deepEqual({ width: card.width, height: card.height }, {
    width: 720,
    height: 1_024,
  });

  const matrix = create(content, { errorCorrectionLevel: 'M' }).modules;
  const scale = Math.floor(480 / (matrix.size + 8));
  const renderedSize = (matrix.size + 8) * scale;
  const matrixX = 120 + Math.floor((480 - renderedSize) / 2) + 4 * scale;
  const matrixY = 220 + Math.floor((480 - renderedSize) / 2) + 4 * scale;
  assert.ok(Number.isInteger(scale) && scale > 0);

  const pixel = (image: PNG, x: number, y: number): number[] => {
    const offset = (y * image.width + x) * 4;
    return [...image.data.subarray(offset, offset + 4)];
  };
  assert.equal(pixel(card, 0, 0)[3], 0);
  assert.equal(pixel(card, 360, 32)[3], 0);
  let transparentPixels = 0;
  for (let index = 3; index < card.data.length; index += 4) {
    if (card.data[index] === 0) transparentPixels += 1;
  }
  assert.ok(transparentPixels > card.width * card.height * 0.25);
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      const x = matrixX + column * scale + Math.floor(scale / 2);
      const y = matrixY + row * scale + Math.floor(scale / 2);
      assert.deepEqual(
        pixel(card, x, y),
        matrix.get(row, column)
          ? [0x11, 0x18, 0x14, 0xff]
          : pixel(template, x, y),
      );
    }
  }
  for (let module = 1; module <= 4; module += 1) {
    const middle = Math.floor(scale / 2);
    const samples = [
      [matrixX - module * scale + middle, matrixY + middle],
      [matrixX + matrix.size * scale + (module - 1) * scale + middle, matrixY + middle],
      [matrixX + middle, matrixY - module * scale + middle],
      [matrixX + middle, matrixY + matrix.size * scale + (module - 1) * scale + middle],
    ];
    for (const [x = 0, y = 0] of samples) {
      assert.deepEqual(pixel(card, x, y), pixel(template, x, y));
    }
  }
});

test('enforces non-empty and 2048-byte UTF-8 input limits without echoing content', async () => {
  const maximumContent = '🙂'.repeat(512);
  const maximum = PNG.sync.read(await renderIlinkQrPng(maximumContent));
  const maximumMatrix = create(maximumContent, { errorCorrectionLevel: 'M' }).modules;
  assert.ok(Math.floor(480 / (maximumMatrix.size + 8)) >= 2);
  assert.deepEqual({ width: maximum.width, height: maximum.height }, {
    width: 720,
    height: 1_024,
  });

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
