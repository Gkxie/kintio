import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';

import { describe, test } from 'vitest';

import {
  DEFAULT_ILINK_IMAGE_TIMEOUT_MS,
  downloadIlinkInboundImage,
  extractIlinkInboundImageLocator,
  IlinkInboundImageError,
} from '../../src/ilink/inbound-image.ts';
import { MAX_WECHAT_IMAGE_BYTES } from '../../src/lib/image-format.ts';

const CDN_URL =
  'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=signed-secret';
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082',
  'hex',
);
const JPEG = Buffer.from(
  'ffd8ffc00011080001000103011100021100031100ffda000c03010002000300003f0000ffd9',
  'hex',
);

function encrypt(plaintext: Buffer, key = KEY): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function imageItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    media: {
      full_url: CDN_URL,
      aes_key: KEY.toString('base64'),
    },
    ...overrides,
  };
}

function errorKind(error: unknown, kind: string): boolean {
  return error instanceof IlinkInboundImageError && error.kind === kind;
}

test('downloads, decrypts, and recognizes PNG using the preferred image hex key', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const alternateKey = Buffer.alloc(16, 0xff);
  const item = imageItem({
    aeskey: KEY.toString('hex'),
    media: {
      full_url: CDN_URL,
      aes_key: alternateKey.toString('base64'),
    },
  });

  const result = await downloadIlinkInboundImage(item, {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(encrypt(PNG), { status: 200 });
    },
  });

  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.contentType, 'image/png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CDN_URL);
  assert.equal(calls[0]?.init.method, 'GET');
  assert.equal(calls[0]?.init.redirect, 'error');
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
});

test('builds the official CDN URL and parses raw or hex-ascii base64 keys', async () => {
  const encodings = [
    KEY.toString('base64'),
    Buffer.from(KEY.toString('hex'), 'ascii').toString('base64'),
  ];

  for (const aesKey of encodings) {
    let requested = '';
    const result = await downloadIlinkInboundImage({
      media: {
        encrypt_query_param: 'opaque/+ value',
        aes_key: aesKey,
      },
    }, {
      fetchImpl: async (url) => {
        requested = String(url);
        return new Response(encrypt(JPEG));
      },
    });

    const parsed = new URL(requested);
    assert.equal(parsed.origin, 'https://novac2c.cdn.weixin.qq.com');
    assert.equal(parsed.pathname, '/c2c/download');
    assert.equal(parsed.searchParams.get('encrypted_query_param'), 'opaque/+ value');
    assert.deepEqual(result.bytes, JPEG);
    assert.equal(result.contentType, 'image/jpeg');
  }
});

test('accepts provider JPEG trailers but removes them before model input', async () => {
  const trailer = Buffer.from('provider-specific-trailer');
  const result = await downloadIlinkInboundImage(imageItem(), {
    fetchImpl: async () => new Response(encrypt(Buffer.concat([JPEG, trailer]))),
  });

  assert.deepEqual(result.bytes, JPEG);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.bytes.includes(trailer), false);
});

test('extractor ignores non-original locators and does not mutate its input', () => {
  const item = Object.freeze({
    aeskey: KEY.toString('hex'),
    url: 'http://127.0.0.1/private',
    thumb_media: Object.freeze({
      full_url: 'http://169.254.169.254/latest/meta-data',
      aes_key: Buffer.alloc(16, 1).toString('base64'),
    }),
    media: Object.freeze({ full_url: CDN_URL }),
  });

  const locator = extractIlinkInboundImageLocator(item);

  assert.equal(locator.downloadUrl, CDN_URL);
  assert.deepEqual(locator.aesKey, KEY);
  assert.equal(item.media.full_url, CDN_URL);
});

describe('locator and key validation', () => {
  test('rejects non-image shapes and never invokes fetch', async () => {
    let fetched = false;
    await assert.rejects(
      () => downloadIlinkInboundImage({
        voice_item: {
          media: { full_url: CDN_URL, aes_key: KEY.toString('base64') },
        },
      }, {
        fetchImpl: async () => {
          fetched = true;
          return new Response();
        },
      }),
      (error) => errorKind(error, 'invalid_locator'),
    );
    assert.equal(fetched, false);
  });

  test('allows only the exact official HTTPS CDN host without credentials or redirects', async () => {
    const unsafeUrls = [
      'http://novac2c.cdn.weixin.qq.com/c2c/download?q=secret',
      'https://localhost/c2c/download?q=secret',
      'https://127.0.0.1/c2c/download?q=secret',
      'https://novac2c.cdn.weixin.qq.com.evil.example/c2c/download?q=secret',
      'https://user:pass@novac2c.cdn.weixin.qq.com/c2c/download?q=secret',
      'https://novac2c.cdn.weixin.qq.com:444/c2c/download?q=secret',
      'https://novac2c.cdn.weixin.qq.com/c2c/download?q=secret#fragment',
    ];
    let fetches = 0;
    for (const fullUrl of unsafeUrls) {
      await assert.rejects(
        () => downloadIlinkInboundImage(imageItem({
          media: { full_url: fullUrl, aes_key: KEY.toString('base64') },
        }), {
          fetchImpl: async () => {
            fetches += 1;
            return new Response();
          },
        }),
        (error) => errorKind(error, 'invalid_locator'),
      );
    }
    assert.equal(fetches, 0);
  });

  test('rejects an invalid preferred key instead of falling back', async () => {
    let fetched = false;
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem({
        aeskey: 'not-hex',
      }), {
        fetchImpl: async () => {
          fetched = true;
          return new Response();
        },
      }),
      (error) => errorKind(error, 'invalid_key'),
    );
    assert.equal(fetched, false);
  });

  test('rejects malformed and wrong-sized base64 keys', () => {
    for (const aesKey of [
      '***not-base64***',
      Buffer.alloc(15).toString('base64'),
      Buffer.alloc(32, 0xff).toString('base64'),
    ]) {
      assert.throws(
        () => extractIlinkInboundImageLocator(imageItem({
          media: { full_url: CDN_URL, aes_key: aesKey },
        })),
        (error) => errorKind(error, 'invalid_key'),
      );
    }
  });
});

describe('bounded and sanitized download', () => {
  test('rejects HTTP redirects and does not expose response bodies', async () => {
    const secretBody = `${CDN_URL} ${KEY.toString('hex')}`;
    let redirectMode: string | undefined;
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async (_url, init = {}) => {
          redirectMode = init.redirect;
          return new Response(secretBody, {
            status: 302,
            headers: { location: 'http://127.0.0.1/private' },
          });
        },
      }),
      (error) => {
        assert.ok(error instanceof IlinkInboundImageError);
        assert.equal(error.kind, 'download_failed');
        assert.doesNotMatch(error.message, /signed-secret|00112233|127\.0\.0\.1/u);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(redirectMode, 'error');
  });

  test('times out the whole download and sanitizes provider errors', async () => {
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        timeoutMs: 5,
        fetchImpl: async (_url, init = {}) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error(`failed ${CDN_URL} key=${KEY.toString('hex')}`));
          }, { once: true });
        }),
      }),
      (error) => {
        assert.ok(error instanceof IlinkInboundImageError);
        assert.equal(error.kind, 'download_timeout');
        assert.doesNotMatch(error.message, /signed-secret|00112233/u);
        assert.equal(error.cause, undefined);
        return true;
      },
    );

    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => {
          throw new Error(`network ${CDN_URL} key=${KEY.toString('hex')}`);
        },
      }),
      (error) => {
        assert.ok(error instanceof IlinkInboundImageError);
        assert.equal(error.kind, 'download_failed');
        assert.doesNotMatch(error.message, /signed-secret|00112233/u);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  test('rejects oversized declared and streamed responses', async () => {
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(null, {
          headers: {
            'content-length': String(MAX_WECHAT_IMAGE_BYTES + 17),
          },
        }),
      }),
      (error) => errorKind(error, 'response_too_large'),
    );

    const chunk = new Uint8Array(MAX_WECHAT_IMAGE_BYTES + 17);
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        })),
      }),
      (error) => errorKind(error, 'response_too_large'),
    );
  });

  test('does not allow callers to weaken the production timeout', async () => {
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        timeoutMs: DEFAULT_ILINK_IMAGE_TIMEOUT_MS + 1,
        fetchImpl: async () => new Response(encrypt(PNG)),
      }),
      (error) => errorKind(error, 'download_failed'),
    );
  });
});

describe('decrypted image validation', () => {
  test('rejects invalid ciphertext and incorrect keys without exposing details', async () => {
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(Buffer.from('not-a-block')),
      }),
      (error) => errorKind(error, 'decryption_failed'),
    );

    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(encrypt(PNG, Buffer.alloc(16, 7))),
      }),
      (error) => {
        assert.ok(error instanceof IlinkInboundImageError);
        assert.equal(error.kind, 'decryption_failed');
        assert.doesNotMatch(error.message, /signed-secret|00112233/u);
        return true;
      },
    );
  });

  test('rejects truncated images and excessive decoded dimensions', async () => {
    const oversized = Buffer.from(PNG);
    oversized.writeUInt32BE(20_000, 16);
    for (const plaintext of [
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('ffd8ffe000104a46494600ffd9', 'hex'),
      oversized,
    ]) {
      await assert.rejects(
        () => downloadIlinkInboundImage(imageItem(), {
          fetchImpl: async () => new Response(encrypt(plaintext)),
        }),
        (error) => errorKind(error, 'unsupported_image'),
      );
    }
  });

  test('accepts only PNG and JPEG magic bytes', async () => {
    const gif = Buffer.from('47494638396101000100', 'hex');
    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(encrypt(gif)),
      }),
      (error) => errorKind(error, 'unsupported_image'),
    );
  });

  test('enforces the existing decrypted image size limit', async () => {
    const oversizedPng = Buffer.alloc(MAX_WECHAT_IMAGE_BYTES + 1);
    PNG.copy(oversizedPng);

    await assert.rejects(
      () => downloadIlinkInboundImage(imageItem(), {
        fetchImpl: async () => new Response(encrypt(oversizedPng)),
      }),
      (error) => errorKind(error, 'image_too_large'),
    );
  });
});
