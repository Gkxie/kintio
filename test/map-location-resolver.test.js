import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  createDomainMessage,
} from '../src/domain/message.js';
import { createLinkReply } from '../src/domain/reply.js';
import { MapLocationResolver } from '../src/services/map-location-resolver.js';

function locationRequest() {
  return createDomainMessage({
    id: 'location-request',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '把这家店的位置发给我',
  });
}

function linkReply(url) {
  return createLinkReply({
    title: '一喜日本料理（花园路店）',
    description: '北京市海淀区花园东路乙9号3号楼牡丹写字楼1层',
    url,
  });
}

test('exact Apple Maps metadata is promoted to a native location', async () => {
  const requests = [];
  const resolver = new MapLocationResolver({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(
        [
          '<html><head>',
          '<meta property="place:location:latitude" content="39.980657">',
          '<meta property="place:location:longitude" content="116.365992">',
          '</head></html>',
        ].join(''),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    },
  });

  const reply = await resolver.resolve({
    message: locationRequest(),
    reply: linkReply(
      'https://maps.apple.com/place?_provider=57879&place-id=example',
    ),
  });

  assert.deepEqual(reply, {
    type: 'location',
    location: {
      name: '一喜日本料理（花园路店）',
      address: '北京市海淀区花园东路乙9号3号楼牡丹写字楼1层',
      latitude: 39.980657,
      longitude: 116.365992,
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.redirect, 'error');
});

test('coordinates embedded in an Amap URI need no network lookup', async () => {
  let fetchCalls = 0;
  const resolver = new MapLocationResolver({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be used');
    },
  });

  const reply = await resolver.resolve({
    message: locationRequest(),
    reply: linkReply(
      'https://uri.amap.com/marker?position=116.365992,39.980657',
    ),
  });

  assert.equal(reply.type, 'location');
  assert.equal(reply.location.latitude, 39.980657);
  assert.equal(reply.location.longitude, 116.365992);
  assert.equal(fetchCalls, 0);
});

test('generic search links remain links and cannot trigger arbitrary fetches', async () => {
  let fetchCalls = 0;
  const resolver = new MapLocationResolver({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be used');
    },
  });
  const original = linkReply(
    'https://uri.amap.com/search?keyword=%E4%B8%80%E5%96%9C&city=110000',
  );

  const reply = await resolver.resolve({
    message: locationRequest(),
    reply: original,
  });

  assert.equal(reply, original);
  assert.equal(fetchCalls, 0);

  const insecureAppleLink = linkReply(
    'http://maps.apple.com/place?place-id=example',
  );
  assert.equal(
    await resolver.resolve({
      message: locationRequest(),
      reply: insecureAppleLink,
    }),
    insecureAppleLink,
  );
  assert.equal(fetchCalls, 0);
});

test('a generic current link can reuse a matching trusted place page from conversation history', async () => {
  const resolver = new MapLocationResolver({
    historyStore: {
      async getRecentOutboundMessages(request) {
        assert.deepEqual(request, {
          openKfId: 'wk-one',
          externalUserId: 'wm-one',
          limit: 20,
        });
        return [
          {
            type: 'link',
            link: {
              title: '一喜日本料理（花园路店）',
              description:
                '北京市海淀区花园东路乙9号3号楼牡丹写字楼1层',
              url: 'https://maps.apple.com/place?place-id=trusted-place',
            },
          },
        ];
      },
    },
    fetchImpl: async () =>
      new Response(
        [
          '<meta property="place:location:latitude" content="39.980657">',
          '<meta property="place:location:longitude" content="116.365992">',
        ].join(''),
        { headers: { 'Content-Type': 'text/html' } },
      ),
  });
  const currentReply = createLinkReply({
    title: '一喜日本料理（花园路店）位置',
    description: '点击查看地图位置',
    url: 'https://uri.amap.com/search?keyword=%E4%B8%80%E5%96%9C&city=110000',
  });

  const reply = await resolver.resolve({
    message: locationRequest(),
    reply: currentReply,
  });

  assert.equal(reply.type, 'location');
  assert.equal(reply.location.latitude, 39.980657);
  assert.equal(reply.location.longitude, 116.365992);
  assert.equal(reply.location.name, '一喜日本料理（花园路店）');
  assert.equal(
    reply.location.address,
    '北京市海淀区花园东路乙9号3号楼牡丹写字楼1层',
  );
});
