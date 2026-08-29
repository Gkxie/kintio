import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  ILINK_INBOUND_PROVIDER,
  IlinkMessageNormalizationError,
  normalizeIlinkInboundMessage,
  type IlinkInboundPair,
  type IlinkInboundSyncPosition,
} from '../../src/ilink/message.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
  type IlinkMessage,
} from '../../src/ilink/protocol/types.ts';
import {
  ILINK_CHANNEL,
  createIlinkAccountKey,
} from '../../src/ilink/store-types.ts';

const pair: IlinkInboundPair = Object.freeze({
  accountKey: createIlinkAccountKey('bot-one@im.bot'),
  botId: 'bot-one@im.bot',
  ownerUserId: 'owner-one@im.wechat',
});

const sync: IlinkInboundSyncPosition = Object.freeze({
  cursor: 'cursor-one',
  index: 3,
});

const base: IlinkMessage = Object.freeze({
  seq: 8,
  message_id: 42,
  from_user_id: pair.ownerUserId,
  to_user_id: pair.botId,
  create_time_ms: 1_700_000_000_123,
  message_type: IlinkMessageType.USER,
  message_state: IlinkMessageState.FINISH,
  context_token: 'context-secret',
  item_list: [{
    type: IlinkMessageItemType.TEXT,
    text_item: { text: '你好，iLink' },
  }],
});

function normalize(
  message: IlinkMessage = base,
  activePair: IlinkInboundPair = pair,
  position: IlinkInboundSyncPosition = sync,
) {
  return normalizeIlinkInboundMessage(message, activePair, position);
}

test('normalizes valid text into an isolated iLink candidate', () => {
  const candidate = normalize();

  assert.ok(candidate);
  assert.equal(candidate.provider, ILINK_CHANNEL);
  assert.equal(candidate.provider, ILINK_INBOUND_PROVIDER);
  assert.equal(candidate.accountKey, pair.accountKey);
  assert.equal(candidate.providerAccountId, pair.botId);
  assert.equal(candidate.peerId, pair.ownerUserId);
  assert.equal(candidate.providerMessageId, 'message:42');
  assert.deepEqual(candidate.messageKeyMaterial, {
    accountKey: pair.accountKey,
    providerMessageId: 'message:42',
  });
  assert.deepEqual(candidate.sync, sync);
  assert.equal(candidate.kind, 'text');
  assert.equal(candidate.text, '你好，iLink');
  assert.equal(candidate.summary, '你好，iLink');
  assert.deepEqual(candidate.itemTypes, [IlinkMessageItemType.TEXT]);
  assert.equal(candidate.contextToken, 'context-secret');
  assert.equal(candidate.createTime, 1_700_000_000_123);
  assert.equal(candidate.seq, 8);
  assert.equal('conversation' in candidate, false);
  assert.equal('openKfId' in candidate, false);
  assert.equal('externalUserId' in candidate, false);
  assert.ok(Object.isFrozen(candidate));
  assert.ok(Object.isFrozen(candidate.messageKeyMaterial));
  assert.ok(Object.isFrozen(candidate.sync));
});

test('strictly rejects messages outside the active owner/bot USER-FINISH envelope', () => {
  const invalid: IlinkMessage[] = [
    { ...base, from_user_id: 'someone-else@im.wechat' },
    { ...base, to_user_id: 'another-bot@im.bot' },
    { ...base, message_type: IlinkMessageType.BOT },
    { ...base, message_type: IlinkMessageType.NONE },
    { ...base, message_state: IlinkMessageState.NEW },
    { ...base, message_state: IlinkMessageState.GENERATING },
    { ...base, context_token: '' },
    { ...base, create_time_ms: -1 },
    { ...base, seq: -1 },
    { ...base, item_list: Array.from({ length: 51 }, () => ({
      type: IlinkMessageItemType.TEXT,
      text_item: { text: 'overflow' },
    })) },
    { ...base, item_list: {} as never },
  ];

  for (const message of invalid) assert.equal(normalize(message), null);
  assert.equal(
    normalizeIlinkInboundMessage(null as never, pair, sync),
    null,
  );
  assert.equal(
    normalize({ ...base, context_token: 7 as never }),
    null,
  );
});

test('derives stable provider IDs without putting raw provider identities in key material', () => {
  const byMessageIdA = normalize(base, pair, { cursor: 'cursor-a', index: 0 });
  const byMessageIdB = normalize(base, pair, { cursor: 'cursor-b', index: 9 });
  assert.equal(byMessageIdA?.providerMessageId, 'message:42');
  assert.equal(byMessageIdB?.providerMessageId, 'message:42');

  const { message_id: _messageId, ...withoutMessageId } = base;
  const byClientA = normalize({ ...withoutMessageId, client_id: 'client-stable' });
  const byClientB = normalize({ ...withoutMessageId, client_id: 'client-stable' });
  assert.match(byClientA?.providerMessageId ?? '', /^client:[0-9a-f]{64}$/u);
  assert.equal(byClientA?.providerMessageId, byClientB?.providerMessageId);

  const { client_id: _clientId, ...withoutClientId } = {
    ...withoutMessageId,
    client_id: 'unused',
  };
  const byItemsA = normalize({
    ...withoutClientId,
    item_list: [
      { type: IlinkMessageItemType.TEXT, msg_id: 'item-one', text_item: { text: '一' } },
      { type: IlinkMessageItemType.TEXT, msg_id: 'item-two', text_item: { text: '二' } },
    ],
  });
  const byItemsB = normalize({
    ...withoutClientId,
    item_list: [
      { type: IlinkMessageItemType.TEXT, msg_id: 'item-one', text_item: { text: 'changed' } },
      { type: IlinkMessageItemType.IMAGE, msg_id: 'item-two' },
    ],
  });
  assert.match(byItemsA?.providerMessageId ?? '', /^items:[0-9a-f]{64}$/u);
  assert.equal(byItemsA?.providerMessageId, byItemsB?.providerMessageId);

  const fallbackA = normalize({
    ...withoutClientId,
    item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text: 'fallback' } }],
  });
  const fallbackB = normalize({
    ...withoutClientId,
    item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text: 'fallback' } }],
  });
  const fallbackOtherIndex = normalize(
    { ...withoutClientId, item_list: [] },
    pair,
    { cursor: sync.cursor, index: sync.index + 1 },
  );
  assert.equal(fallbackA?.providerMessageId, `seq:${base.seq}`);
  assert.equal(fallbackA?.providerMessageId, fallbackB?.providerMessageId);
  assert.equal(fallbackA?.providerMessageId, fallbackOtherIndex?.providerMessageId);
  const { seq: _seq, ...withoutStableSequence } = withoutClientId;
  assert.equal(normalize({
    ...withoutStableSequence,
    item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text: 'no-id' } }],
  }), null);

  const material = JSON.stringify(fallbackA?.messageKeyMaterial);
  assert.doesNotMatch(material, /bot-one@im\.bot|owner-one@im\.wechat/u);
});

test('non-text items produce bounded safe summaries and retain no download material', () => {
  const message: IlinkMessage = {
    ...base,
    item_list: [
      {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          url: 'https://untrusted.example/image-secret',
          aeskey: 'image-aes-secret',
          media: { full_url: 'https://cdn.example/media-secret' },
        },
      },
      {
        type: IlinkMessageItemType.VOICE,
        voice_item: {
          text: 'voice-transcript-secret',
          media: { aes_key: 'voice-key-secret' },
        },
      },
      {
        type: IlinkMessageItemType.FILE,
        file_item: {
          file_name: ' 合同\n最终版.pdf ',
          md5: 'file-md5-secret',
          media: { encrypt_query_param: 'file-query-secret' },
        },
      },
      {
        type: IlinkMessageItemType.VIDEO,
        video_item: {
          video_md5: 'video-md5-secret',
          media: { aes_key: 'video-key-secret' },
        },
      },
      {
        type: IlinkMessageItemType.TOOL_CALL_START,
        tool_call_start_item: {
          tool_name: 'private-tool-name',
          tool_call_id: 'private-tool-id',
        },
      },
      {
        type: IlinkMessageItemType.TOOL_CALL_RESULT,
        tool_call_result_item: {
          tool_name: 'private-result-tool',
          tool_call_id: 'private-result-id',
          status: 'private-result-status',
        },
      },
      { type: 99, text_item: { text: 'unknown-payload-secret' } },
      null as never,
    ],
  };
  const before = structuredClone(message);

  const candidate = normalize(message);

  assert.ok(candidate);
  assert.equal(candidate.kind, 'non_text');
  assert.equal(candidate.text, '');
  for (const expected of [
    'image: not downloaded or viewed',
    'voice: not downloaded, played, or transcribed',
    '合同 最终版.pdf',
    'video: not downloaded, watched, or transcribed',
    'type 11',
    'type 12',
    'type 99',
    'unknown type',
  ]) {
    assert.match(candidate.summary, new RegExp(expected, 'u'));
  }
  for (const secret of [
    'untrusted.example',
    'image-aes-secret',
    'media-secret',
    'voice-transcript-secret',
    'voice-key-secret',
    'file-md5-secret',
    'file-query-secret',
    'video-md5-secret',
    'video-key-secret',
    'private-tool',
    'private-result',
    'unknown-payload-secret',
  ]) {
    assert.doesNotMatch(candidate.summary, new RegExp(secret, 'u'));
  }
  assert.deepEqual(message, before);
  assert.equal('attachments' in candidate, false);
  assert.equal('media' in candidate, false);
});

test('mixed messages expose only text as text and render media as placeholders', () => {
  const candidate = normalize({
    ...base,
    item_list: [
      {
        type: IlinkMessageItemType.TEXT,
        text_item: { text: '第一段 ' },
        ref_msg: {
          message_item: {
            type: IlinkMessageItemType.IMAGE,
            image_item: { aeskey: 'quoted-image-secret' },
          },
        },
      },
      { type: IlinkMessageItemType.IMAGE, image_item: { aeskey: 'image-secret' } },
      { type: IlinkMessageItemType.TEXT, text_item: { text: '第二段' } },
    ],
  });

  assert.ok(candidate);
  assert.equal(candidate.kind, 'mixed');
  assert.equal(candidate.text, '第一段 \n第二段');
  assert.match(candidate.summary, /第一段 /u);
  assert.match(candidate.summary, /image: not downloaded or viewed/u);
  assert.match(candidate.summary, /第二段/u);
  assert.doesNotMatch(candidate.summary, /quoted-image-secret|image-secret/u);
});

test('valid iLink images expose only a minimal in-memory locator for host sealing', () => {
  const key = Buffer.alloc(16, 5);
  const candidate = normalize({
    ...base,
    item_list: [{
      type: IlinkMessageItemType.IMAGE,
      image_item: {
        media: {
          full_url:
            'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x',
          aes_key: key.toString('base64'),
        },
      },
    }],
  });
  assert.ok(candidate);
  assert.deepEqual(candidate.images, [{
    position: 0,
    downloadUrl:
      'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x',
    aesKey: key.toString('base64url'),
  }]);
  assert.doesNotMatch(candidate.summary, /encrypted_query_param/u);
});

test('iLink image extraction keeps only the latest four locators', () => {
  const candidate = normalize({
    ...base,
    item_list: Array.from({ length: 5 }, (_, index) => ({
      type: IlinkMessageItemType.IMAGE,
      image_item: {
        media: {
          full_url:
            `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${index}`,
          aes_key: Buffer.alloc(16, index + 1).toString('base64'),
        },
      },
    })),
  });
  assert.deepEqual(candidate?.images.map((image) => image.position), [1, 2, 3, 4]);
});

test('empty and whitespace-only text remain explicit', () => {
  const empty = normalize({ ...base, item_list: [] });
  const whitespace = normalize({
    ...base,
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text: '   ' },
    }],
  });

  assert.equal(empty?.kind, 'empty');
  assert.equal(empty?.text, '');
  assert.equal(empty?.summary, '[iLink message: no readable content]');
  assert.equal(empty?.seq, 8);
  assert.equal(whitespace?.kind, 'text');
  assert.equal(whitespace?.text, '   ');
  assert.equal(whitespace?.summary, '[iLink text: empty]');
});

describe('normalizer input boundaries', () => {
  test('invalid pair configuration fails before inspecting a provider message', () => {
    for (const activePair of [
      { ...pair, accountKey: 'raw-bot-id' as never },
      { ...pair, botId: '' },
      { ...pair, botId: ' bot-one@im.bot' },
      { ...pair, ownerUserId: 'owner\nsecret' },
    ]) {
      assert.throws(
        () => normalize(base, activePair),
        (error) =>
          error instanceof IlinkMessageNormalizationError &&
          error.code === 'invalid_pair',
      );
    }
  });

  test('invalid cursor/index configuration is rejected', () => {
    for (const position of [
      { cursor: '', index: 0 },
      { cursor: 'cursor', index: -1 },
      { cursor: 'cursor', index: 1.5 },
    ]) {
      assert.throws(
        () => normalize(base, pair, position),
        (error) =>
          error instanceof IlinkMessageNormalizationError &&
          error.code === 'invalid_sync',
      );
    }
  });

  test('text and file summaries are UTF-8 bounded', () => {
    const text = normalize({
      ...base,
      item_list: [{
        type: IlinkMessageItemType.TEXT,
        text_item: { text: '你'.repeat(20_000) },
      }],
    });
    const file = normalize({
      ...base,
      item_list: [{
        type: IlinkMessageItemType.FILE,
        file_item: { file_name: `${'文'.repeat(300)}.pdf` },
      }],
    });

    assert.ok(text);
    assert.ok(file);
    assert.ok(Buffer.byteLength(text.text, 'utf8') <= 32 * 1_024);
    assert.ok(Buffer.byteLength(text.summary, 'utf8') <= 48 * 1_024);
    assert.ok(Buffer.byteLength(file.summary, 'utf8') < 512);
    assert.match(text.text, /…$/u);
    assert.match(file.summary, /…/u);
  });
});
