import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  SendContractError,
  normalizeMediaCatalog,
  normalizeSendIntent,
} from '../../src/domain/send-contract.ts';

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof SendContractError && error.code === expected;
}

test('an empty send type fails with an explicit unknown-type error', () => {
  assert.throws(
    () => normalizeSendIntent('', {}),
    /Unsupported send type: unknown/u,
  );
});

test('every text field enforces its UTF-8 byte boundary', () => {
  assert.throws(
    () => normalizeSendIntent('text', { content: 'a'.repeat(2049) }),
    /2048 UTF-8 bytes/u,
  );
  for (const [type, field, limit, base] of [
    ['link', 'title', 128, { description: '', url: 'https://example.com' }],
    ['link', 'description', 512, { title: 'x', url: 'https://example.com' }],
    ['miniprogram', 'title', 64, {
      appId: 'wx1234567890abcdef', pagePath: 'pages/a', sourceUrl: 'https://example.com',
    }],
    ['miniprogram', 'pagePath', 1024, {
      appId: 'wx1234567890abcdef', title: 'x', sourceUrl: 'https://example.com',
    }],
    ['location', 'name', 128, { address: 'x', latitude: 0, longitude: 0 }],
    ['location', 'address', 512, { name: 'x', latitude: 0, longitude: 0 }],
  ] as const) {
    assert.doesNotThrow(() =>
      normalizeSendIntent(type, { ...base, [field]: 'a'.repeat(limit) })
    );
    assert.throws(
      () => normalizeSendIntent(type, { ...base, [field]: 'a'.repeat(limit + 1) }),
      new RegExp(String(limit), 'u'),
    );
  }
});

test('media catalogs reject duplicates excess entries and hidden capabilities', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => ({
    ref: `media:${index}`,
    kind: 'image',
  }));
  assert.equal(normalizeMediaCatalog(hundred).length, 100);
  assert.throws(() => normalizeMediaCatalog([...hundred, { ref: 'media:0', kind: 'image' }]),
    code('invalid_media_catalog'));
  for (const catalog of [
    [{ ref: 'media:0', kind: 'image' }, { ref: 'media:0', kind: 'image' }],
    [{ ref: 'media:100', kind: 'image' }],
    [{ ref: 'media:0', kind: 'video' }],
    [{ ref: 'media:0', kind: 'image', mediaId: 'secret' }],
    ['media:0'],
  ]) {
    assert.throws(() => normalizeMediaCatalog(catalog));
  }
  assert.throws(() => normalizeMediaCatalog({}), code('invalid_media_catalog'));
});

test('links reject credentials protocols private IPv4 and private IPv6', () => {
  for (const url of [
    'https://user:pass@example.com/path',
    'ftp://example.com/file',
    'http://localhost/path',
    'http://service/path',
    'http://0.0.0.0/path',
    'http://10.0.0.1/path',
    'http://100.64.0.1/path',
    'http://169.254.1.1/path',
    'http://172.31.0.1/path',
    'http://192.168.1.1/path',
    'http://224.0.0.1/path',
    'http://[::]/path',
    'http://[::1]/path',
    'http://[fc00::1]/path',
    'http://[fd00::1]/path',
    'http://[fe80::1]/path',
    'http://[::ffff:192.168.1.1]/path',
  ]) {
    assert.throws(() => normalizeSendIntent('link', {
      title: 'blocked', description: '', url,
    }), /public HTTP/u);
  }
  assert.equal(
    normalizeSendIntent('link', {
      title: 'public', description: '', url: 'https://[2001:4860:4860::8888]/',
    }).type,
    'link',
  );
  assert.throws(() => normalizeSendIntent('link', {
    title: 'long', description: '', url: `https://example.com/${'a'.repeat(2048)}`,
  }), /2048 UTF-8 bytes/u);
});

test('mini-program paths reject schemes traversal controls and bad app IDs', () => {
  const valid = {
    appId: 'wx1234567890abcdef',
    title: '入口',
    sourceUrl: 'https://example.com/proof',
  };
  for (const pagePath of [
    'https://example.com/pages/a',
    'pages/../secret',
    'pages/a\u0000b',
    'pages/a\nb',
    'pages/a\u007fb',
  ]) {
    assert.throws(
      () => normalizeSendIntent('miniprogram', { ...valid, pagePath }),
      /pagePath/u,
    );
  }
  for (const appId of ['wxshort', 'xx1234567890abcdef', 'wx1234567890abcde_']) {
    assert.throws(
      () => normalizeSendIntent('miniprogram', { ...valid, appId, pagePath: 'pages/a' }),
      /appId/u,
    );
  }
});

test('location accepts exact coordinate boundaries and rejects non-finite overflow', () => {
  for (const [latitude, longitude] of [
    [-90, -180], [90, 180], [0, 0],
  ]) {
    const location = normalizeSendIntent('location', {
      name: '点', address: '地址', latitude, longitude,
    });
    assert.equal(location.type, 'location');
  }
  for (const [latitude, longitude] of [
    [-90.0001, 0], [90.0001, 0], [0, -180.0001], [0, 180.0001],
    [Number.NaN, 0], [0, Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(() => normalizeSendIntent('location', {
      name: '点', address: '地址', latitude, longitude,
    }), /between/u);
  }
});
