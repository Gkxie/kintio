import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import { describe, test, vi } from 'vitest';

import {
  IlinkMediaError,
  MAX_ILINK_IMAGE_BYTES,
  encryptIlinkMedia,
  ilinkAesEcbPaddedSize,
  uploadIlinkImageBuffer,
  type IlinkGetUploadUrlRequest,
  type IlinkGetUploadUrlResponse,
  type IlinkImageUploadClient,
} from '../../src/ilink/media.ts';
import { IlinkMessageItemType } from '../../src/ilink/protocol/types.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function protocolClient(
  getUploadUrl: IlinkImageUploadClient['getUploadUrl'],
): IlinkImageUploadClient {
  return { getUploadUrl };
}

function mediaErrorCode(error: unknown, code: IlinkMediaError['code']): boolean {
  return error instanceof IlinkMediaError && error.code === code;
}

describe('iLink in-memory image encryption', () => {
  test('uses AES-128-ECB with PKCS#7 and reports exact ciphertext sizes', () => {
    const plaintext = Buffer.from('0123456789abcdef');
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const ciphertext = encryptIlinkMedia(plaintext, key);

    assert.equal(ciphertext.length, 32);
    assert.equal(ilinkAesEcbPaddedSize(0), 16);
    assert.equal(ilinkAesEcbPaddedSize(15), 16);
    assert.equal(ilinkAesEcbPaddedSize(16), 32);
    assert.equal(ilinkAesEcbPaddedSize(17), 32);

    const decipher = createDecipheriv('aes-128-ecb', key, null);
    assert.deepEqual(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      plaintext,
    );
  });

  test('rejects invalid keys and sizes', () => {
    assert.throws(
      () => encryptIlinkMedia(PNG, Buffer.alloc(15)),
      (error) => mediaErrorCode(error, 'invalid_image'),
    );
    assert.throws(
      () => ilinkAesEcbPaddedSize(-1),
      (error) => mediaErrorCode(error, 'invalid_image'),
    );
  });
});

test('uploads a Buffer through a validated full URL and returns an IMAGE item', async () => {
  let request: IlinkGetUploadUrlRequest | undefined;
  let optionsSignal: AbortSignal | undefined;
  let uploadBody: Buffer | undefined;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(input),
      'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=opaque',
    );
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/octet-stream');
    uploadBody = Buffer.from(init?.body as Uint8Array);
    return new Response(null, {
      status: 200,
      headers: { 'x-encrypted-param': 'download-token' },
    });
  });
  const client = protocolClient(async (input, options) => {
    request = input;
    optionsSignal = options?.signal;
    return {
      upload_full_url:
        'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=opaque',
    };
  });

  const item = await uploadIlinkImageBuffer({
    bytes: PNG,
    peerId: 'owner@im.wechat',
    client,
    fetchImpl,
    timeoutMs: 1_000,
  });

  assert.ok(request);
  assert.equal(request.media_type, 1);
  assert.equal(request.to_user_id, 'owner@im.wechat');
  assert.equal(request.rawsize, PNG.length);
  assert.equal(request.rawfilemd5, createHash('md5').update(PNG).digest('hex'));
  assert.equal(request.filesize, ilinkAesEcbPaddedSize(PNG.length));
  assert.equal(request.no_need_thumb, true);
  assert.match(request.filekey, /^[a-f0-9]{32}$/u);
  assert.match(request.aeskey, /^[a-f0-9]{32}$/u);
  assert.ok(optionsSignal instanceof AbortSignal);
  assert.ok(uploadBody);
  assert.equal(uploadBody.length, request.filesize);

  const encodedKey = Buffer.from(item.image_item.media.aes_key, 'base64');
  assert.equal(item.image_item.media.aes_key.length, 44);
  assert.equal(encodedKey.length, 32);
  assert.equal(encodedKey.toString('ascii'), request.aeskey);
  const key = Buffer.from(encodedKey.toString('ascii'), 'hex');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  assert.deepEqual(
    Buffer.concat([decipher.update(uploadBody), decipher.final()]),
    PNG,
  );
  assert.deepEqual(item, {
    type: IlinkMessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: 'download-token',
        aes_key: Buffer.from(request.aeskey, 'ascii').toString('base64'),
        encrypt_type: 1,
      },
      mid_size: request.filesize,
    },
  });
  assert.equal(fetchImpl.mock.calls.length, 1);
});

test('uses only the fixed Tencent CDN fallback and safely encodes opaque parameters', async () => {
  let request: IlinkGetUploadUrlRequest | undefined;
  let uploadUrl = '';
  await uploadIlinkImageBuffer({
    bytes: PNG,
    peerId: 'owner@im.wechat',
    client: protocolClient(async (input) => {
      request = input;
      return { upload_param: 'opaque+/=&value' };
    }),
    fetchImpl: async (input) => {
      uploadUrl = String(input);
      return new Response(null, {
        status: 200,
        headers: { 'x-encrypted-param': 'download-token' },
      });
    },
  });

  const parsed = new URL(uploadUrl);
  assert.equal(parsed.origin, 'https://novac2c.cdn.weixin.qq.com');
  assert.equal(parsed.pathname, '/c2c/upload');
  assert.equal(parsed.searchParams.get('encrypted_query_param'), 'opaque+/=&value');
  assert.equal(parsed.searchParams.get('filekey'), request?.filekey);
});

describe('iLink CDN boundary validation', () => {
  test.each([
    'http://novac2c.cdn.weixin.qq.com/c2c/upload?signed=x',
    'https://evil.example/c2c/upload?signed=x',
    'https://novac2c.cdn.weixin.qq.com.evil.example/c2c/upload?signed=x',
    'https://user:pass@novac2c.cdn.weixin.qq.com/c2c/upload?signed=x',
    'https://novac2c.cdn.weixin.qq.com:8443/c2c/upload?signed=x',
    'https://novac2c.cdn.weixin.qq.com/other/upload?signed=x',
    'https://novac2c.cdn.weixin.qq.com/c2c/upload',
    'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=x#fragment',
    ' https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=x',
  ])('rejects unsafe upload_full_url %s without contacting it', async (uploadFullUrl) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    await assert.rejects(
      uploadIlinkImageBuffer({
        bytes: PNG,
        peerId: 'owner@im.wechat',
        client: protocolClient(async () => ({ upload_full_url: uploadFullUrl })),
        fetchImpl,
      }),
      (error) => mediaErrorCode(error, 'unsafe_upload_url'),
    );
    assert.equal(fetchImpl.mock.calls.length, 0);
  });

  test('does not fall back when a supplied full URL is malformed', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    await assert.rejects(
      uploadIlinkImageBuffer({
        bytes: PNG,
        peerId: 'owner@im.wechat',
        client: protocolClient(async () => ({
          upload_full_url: 'https://evil.example/c2c/upload?signed=x',
          upload_param: 'otherwise-valid',
        })),
        fetchImpl,
      }),
      (error) => mediaErrorCode(error, 'unsafe_upload_url'),
    );
    assert.equal(fetchImpl.mock.calls.length, 0);
  });

  test.each([
    {},
    { upload_param: '' },
    { upload_param: ' spaced ' },
    { upload_param: 'line\nbreak' },
    { upload_full_url: 42 },
  ])('rejects malformed getuploadurl response %#', async (response) => {
    await assert.rejects(
      uploadIlinkImageBuffer({
        bytes: PNG,
        peerId: 'owner@im.wechat',
        client: protocolClient(async () =>
          response as unknown as IlinkGetUploadUrlResponse),
        fetchImpl: vi.fn<typeof globalThis.fetch>(),
      }),
      (error) => mediaErrorCode(error, 'invalid_upload_response'),
    );
  });

  test('rejects redirects, non-200 responses, changed response URLs and missing header', async () => {
    const responses = [
      Object.defineProperty(new Response(null, {
        status: 200,
        headers: { 'x-encrypted-param': 'token' },
      }), 'redirected', { value: true }),
      new Response(null, { status: 503 }),
      Object.defineProperty(new Response(null, {
        status: 200,
        headers: { 'x-encrypted-param': 'token' },
      }), 'url', {
        value: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=changed',
      }),
      new Response(null, { status: 200 }),
    ];
    const client = protocolClient(async () => ({
      upload_full_url:
        'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=original',
    }));
    const expected = [
      'unsafe_upload_url',
      'upload_rejected',
      'unsafe_upload_url',
      'invalid_upload_response',
    ] as const;
    for (const code of expected) {
      const response = responses.shift();
      assert.ok(response);
      await assert.rejects(
        uploadIlinkImageBuffer({
          bytes: PNG,
          peerId: 'owner@im.wechat',
          client,
          fetchImpl: async () => response,
        }),
        (error) => mediaErrorCode(error, code),
      );
    }
  });
});

describe('iLink image input and deadline controls', () => {
  test('rejects non-images, empty data, oversize data and invalid recipients before I/O', async () => {
    const getUploadUrl = vi.fn<IlinkImageUploadClient['getUploadUrl']>();
    const client = protocolClient(getUploadUrl);
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    const cases: readonly [Buffer, string, IlinkMediaError['code']][] = [
      [Buffer.alloc(0), 'owner@im.wechat', 'invalid_image'],
      [Buffer.from('not-an-image'), 'owner@im.wechat', 'invalid_image'],
      [
        Buffer.concat([
          Buffer.from('89504e470d0a1a0a', 'hex'),
          Buffer.alloc(MAX_ILINK_IMAGE_BYTES),
        ]),
        'owner@im.wechat',
        'image_too_large',
      ],
      [PNG, ' owner@im.wechat', 'invalid_peer'],
      [PNG, 'owner\n@im.wechat', 'invalid_peer'],
    ];
    for (const [bytes, peerId, code] of cases) {
      await assert.rejects(
        uploadIlinkImageBuffer({ bytes, peerId, client, fetchImpl }),
        (error) => mediaErrorCode(error, code),
      );
    }
    assert.equal(getUploadUrl.mock.calls.length, 0);
    assert.equal(fetchImpl.mock.calls.length, 0);
  });

  test('enforces an overall timeout even if getuploadurl ignores its signal', async () => {
    await assert.rejects(
      uploadIlinkImageBuffer({
        bytes: PNG,
        peerId: 'owner@im.wechat',
        client: protocolClient(() => new Promise(() => undefined)),
        fetchImpl: vi.fn<typeof globalThis.fetch>(),
        timeoutMs: 5,
      }),
      (error) => mediaErrorCode(error, 'timeout'),
    );
  });

  test('honors external cancellation and never reads local files', async () => {
    const controller = new AbortController();
    controller.abort();
    const readFile = vi.spyOn(fs, 'readFile');
    await assert.rejects(
      uploadIlinkImageBuffer({
        bytes: PNG,
        peerId: 'owner@im.wechat',
        client: protocolClient(() => new Promise(() => undefined)),
        fetchImpl: vi.fn<typeof globalThis.fetch>(),
        signal: controller.signal,
      }),
      (error) => mediaErrorCode(error, 'aborted'),
    );
    assert.equal(readFile.mock.calls.length, 0);
  });

  test.each([0, -1, 60_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s before I/O',
    async (timeoutMs) => {
      const getUploadUrl = vi.fn<IlinkImageUploadClient['getUploadUrl']>();
      await assert.rejects(
        uploadIlinkImageBuffer({
          bytes: PNG,
          peerId: 'owner@im.wechat',
          client: protocolClient(getUploadUrl),
          fetchImpl: vi.fn<typeof globalThis.fetch>(),
          timeoutMs,
        }),
        (error) => mediaErrorCode(error, 'invalid_timeout'),
      );
      assert.equal(getUploadUrl.mock.calls.length, 0);
    },
  );
});
