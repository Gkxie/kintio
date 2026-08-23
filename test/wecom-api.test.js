import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomApiClient, WecomApiError } from '../src/services/wecom-api.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('WeCom API caches access tokens and sends official sync/send payloads', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).includes('/gettoken?')) {
      return jsonResponse({ access_token: 'access-one', expires_in: 7200 });
    }

    if (String(url).includes('/kf/sync_msg?')) {
      return jsonResponse({
        errcode: 0,
        errmsg: 'ok',
        next_cursor: 'cursor-two',
        has_more: 0,
        msg_list: [],
      });
    }

    return jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'reply-id' });
  };
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl,
  });

  await client.syncMessages({
    cursor: 'cursor-one',
    callbackToken: 'callback-token',
    openKfId: 'wk-one',
  });
  await client.sendTextMessage({
    toUser: 'wm-one',
    openKfId: 'wk-one',
    content: 'hello',
  });

  assert.equal(calls.filter((call) => call.url.includes('/gettoken?')).length, 1);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    cursor: 'cursor-one',
    token: 'callback-token',
    limit: 1000,
    voice_format: 0,
    open_kfid: 'wk-one',
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    touser: 'wm-one',
    open_kfid: 'wk-one',
    msgtype: 'text',
    text: { content: 'hello' },
  });
});

test('WeCom API refreshes an expired access token once', async () => {
  const tokenValues = ['old-token', 'new-token'];
  let tokenRequests = 0;
  let syncRequests = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/gettoken?')) {
      const accessToken = tokenValues[tokenRequests];
      tokenRequests += 1;
      return jsonResponse({ access_token: accessToken, expires_in: 7200 });
    }

    syncRequests += 1;

    if (syncRequests === 1) {
      return jsonResponse({ errcode: 42001, errmsg: 'access token expired' });
    }

    return jsonResponse({
      errcode: 0,
      errmsg: 'ok',
      next_cursor: 'cursor',
      has_more: 0,
      msg_list: [],
    });
  };
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl,
  });

  await client.syncMessages({ openKfId: 'wk-one' });

  assert.equal(tokenRequests, 2);
  assert.equal(syncRequests, 2);
});

test('WeCom API exposes nonzero errcodes as typed errors', async () => {
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url) =>
      String(url).includes('/gettoken?')
        ? jsonResponse({ access_token: 'access', expires_in: 7200 })
        : jsonResponse({ errcode: 95018, errmsg: 'service state invalid' }),
  });

  await assert.rejects(
    () =>
      client.sendTextMessage({
        toUser: 'wm-one',
        openKfId: 'wk-one',
        content: 'hello',
      }),
    (error) => error instanceof WecomApiError && error.code === 95018,
  );
});

test('WeCom API downloads inbound media as an in-memory buffer', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const calls = [];
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });

      if (String(url).includes('/gettoken?')) {
        return jsonResponse({ access_token: 'access', expires_in: 7200 });
      }

      return new Response(png, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': "attachment; filename*=UTF-8''customer%20photo.png",
        },
      });
    },
  });

  const media = await client.downloadMedia('media-one');

  assert.equal(media.contentType, 'image/png');
  assert.equal(media.filename, 'customer photo.png');
  assert.ok(media.bytes.equals(png));
  assert.match(calls[1].url, /\/cgi-bin\/media\/get\?/);
  assert.equal(calls[1].options.method, 'GET');
});

test('WeCom API uploads multipart media and returns a temporary media ID', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let uploadCall;
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/gettoken?')) {
        return jsonResponse({ access_token: 'access', expires_in: 7200 });
      }

      uploadCall = { url: String(url), options };
      return jsonResponse({
        errcode: 0,
        errmsg: 'ok',
        type: 'image',
        media_id: 'uploaded-media',
        created_at: '123',
      });
    },
  });

  const result = await client.uploadMedia({
    type: 'image',
    bytes: png,
    filename: 'customer.png',
    contentType: 'image/png',
  });

  assert.equal(result.media_id, 'uploaded-media');
  assert.match(uploadCall.url, /\/cgi-bin\/media\/upload\?/);
  assert.match(uploadCall.url, /type=image/);
  assert.match(uploadCall.options.headers['Content-Type'], /^multipart\/form-data/);
  const body = uploadCall.options.body.toString('latin1');
  assert.match(body, /name="media"/);
  assert.match(body, /filename="customer.png"/);
  assert.match(body, /filelength=12/);
});

test('WeCom API sends an image with an optional stable client message ID', async () => {
  const calls = [];
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/gettoken?')
        ? jsonResponse({ access_token: 'access', expires_in: 7200 })
        : jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'media-message' });
    },
  });

  await client.sendMediaMessage({
    toUser: 'wm-one',
    openKfId: 'wk-one',
    type: 'image',
    mediaId: 'image-media',
    messageId: 'wb_stable_message_001',
  });

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    touser: 'wm-one',
    open_kfid: 'wk-one',
    msgtype: 'image',
    image: { media_id: 'image-media' },
    msgid: 'wb_stable_message_001',
  });
});

test('WeCom API sends location messages with validated coordinates', async () => {
  const calls = [];
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/gettoken?')
        ? jsonResponse({ access_token: 'access', expires_in: 7200 })
        : jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'location-id' });
    },
  });

  await client.sendLocationMessage({
    toUser: 'wm-one',
    openKfId: 'wk-one',
    location: {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    touser: 'wm-one',
    open_kfid: 'wk-one',
    msgtype: 'location',
    location: {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });
});

test('WeCom API sends native link messages with a thumbnail media ID', async () => {
  const calls = [];
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/gettoken?')
        ? jsonResponse({ access_token: 'access', expires_in: 7200 })
        : jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'link-id' });
    },
  });

  await client.sendLinkMessage({
    toUser: 'wm-one',
    openKfId: 'wk-one',
    link: {
      title: '地图',
      description: '门店地址',
      url: 'https://maps.apple.com/place?place-id=example',
    },
    thumbnailMediaId: 'thumbnail-media',
  });

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    touser: 'wm-one',
    open_kfid: 'wk-one',
    msgtype: 'link',
    link: {
      title: '地图',
      desc: '门店地址',
      url: 'https://maps.apple.com/place?place-id=example',
      thumb_media_id: 'thumbnail-media',
    },
  });
});

test('WeCom API sends native mini-program deep links', async () => {
  const calls = [];
  const client = new WecomApiClient({
    corpId: 'ww-test',
    kfSecret: 'kf-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/gettoken?')
        ? jsonResponse({ access_token: 'access', expires_in: 7200 })
        : jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'mini-id' });
    },
  });

  await client.sendMiniProgramMessage({
    toUser: 'wm-one',
    openKfId: 'wk-one',
    miniprogram: {
      appId: 'wx1234567890abcdef',
      title: '门店小程序',
      pagePath: 'pages/store/detail?id=123',
    },
    thumbnailMediaId: 'thumbnail-media',
  });

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    touser: 'wm-one',
    open_kfid: 'wk-one',
    msgtype: 'miniprogram',
    miniprogram: {
      appid: 'wx1234567890abcdef',
      title: '门店小程序',
      thumb_media_id: 'thumbnail-media',
      pagepath: 'pages/store/detail?id=123',
    },
  });
});
