import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
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

test('normalizes valid text and isolates provider facts from the common message', () => {
  const normalized = normalize();

  assert.ok(normalized);
  const { message, facts } = normalized;
  assert.equal(message.conversation.channel, ILINK_CHANNEL);
  assert.equal(message.conversation.accountKey, pair.accountKey);
  assert.equal(message.conversation.peerId, pair.ownerUserId);
  assert.equal(message.providerMessageId, 'message:42');
  assert.deepEqual(message.sync, sync);
  assert.equal(message.origin, 'customer');
  assert.equal(message.type, 'text');
  assert.equal(message.rawType, 'ilink_text');
  assert.equal(message.text, '你好，iLink');
  assert.equal(message.summary, '你好，iLink');
  assert.equal(message.sentAt, 1_700_000_000_123);
  assert.deepEqual(message.attributes, {
    itemTypes: [IlinkMessageItemType.TEXT],
  });
  assert.deepEqual(message.attachments, []);
  assert.equal(facts.contextToken, 'context-secret');
  assert.equal(facts.providerSeq, 8);
  assert.deepEqual(facts.images, []);
  assert.equal('contextToken' in message, false);
  assert.equal('providerAccountId' in message, false);
  assert.doesNotMatch(JSON.stringify(message), /context-secret/u);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(message));
  assert.ok(Object.isFrozen(message.conversation));
  assert.ok(Object.isFrozen(message.sync));
  assert.ok(Object.isFrozen(message.attributes));
  assert.ok(Object.isFrozen(message.attachments));
  assert.ok(Object.isFrozen(facts));
  assert.ok(Object.isFrozen(facts.images));
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

test('derives stable provider IDs without embedding raw provider identities', () => {
  const byMessageIdA = normalize(base, pair, { cursor: 'cursor-a', index: 0 });
  const byMessageIdB = normalize(base, pair, { cursor: 'cursor-b', index: 9 });
  assert.equal(byMessageIdA?.message.providerMessageId, 'message:42');
  assert.equal(byMessageIdB?.message.providerMessageId, 'message:42');

  const { message_id: _messageId, ...withoutMessageId } = base;
  const byClientA = normalize({ ...withoutMessageId, client_id: 'client-stable' });
  const byClientB = normalize({ ...withoutMessageId, client_id: 'client-stable' });
  assert.match(
    byClientA?.message.providerMessageId ?? '',
    /^client:[0-9a-f]{64}$/u,
  );
  assert.equal(
    byClientA?.message.providerMessageId,
    byClientB?.message.providerMessageId,
  );

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
  assert.match(
    byItemsA?.message.providerMessageId ?? '',
    /^items:[0-9a-f]{64}$/u,
  );
  assert.equal(
    byItemsA?.message.providerMessageId,
    byItemsB?.message.providerMessageId,
  );

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
  assert.equal(fallbackA?.message.providerMessageId, `seq:${base.seq}`);
  assert.equal(
    fallbackA?.message.providerMessageId,
    fallbackB?.message.providerMessageId,
  );
  assert.equal(
    fallbackA?.message.providerMessageId,
    fallbackOtherIndex?.message.providerMessageId,
  );
  const { seq: _seq, ...withoutStableSequence } = withoutClientId;
  assert.equal(normalize({
    ...withoutStableSequence,
    item_list: [{ type: IlinkMessageItemType.TEXT, text_item: { text: 'no-id' } }],
  }), null);

  const providerId = fallbackA?.message.providerMessageId ?? '';
  assert.doesNotMatch(providerId, /bot-one@im\.bot|owner-one@im\.wechat/u);
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

  const normalized = normalize(message);

  assert.ok(normalized);
  assert.equal(normalized.message.type, 'non_text');
  assert.equal(normalized.message.text, '');
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
    assert.match(normalized.message.summary, new RegExp(expected, 'u'));
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
    assert.doesNotMatch(normalized.message.summary, new RegExp(secret, 'u'));
  }
  assert.deepEqual(message, before);
  assert.deepEqual(normalized.message.attachments, []);
  assert.deepEqual(normalized.facts.images, []);
  assert.equal('media' in normalized.message, false);
});

test('mixed messages expose only text as text and render media as placeholders', () => {
  const normalized = normalize({
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

  assert.ok(normalized);
  assert.equal(normalized.message.type, 'mixed');
  assert.equal(normalized.message.text, '第一段 \n第二段');
  assert.match(normalized.message.summary, /第一段 /u);
  assert.match(normalized.message.summary, /image: not downloaded or viewed/u);
  assert.match(normalized.message.summary, /第二段/u);
  assert.doesNotMatch(
    normalized.message.summary,
    /quoted-image-secret|image-secret/u,
  );
});

test('valid iLink images expose only a minimal in-memory locator for host sealing', () => {
  const key = Buffer.alloc(16, 5);
  const normalized = normalize({
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
  assert.ok(normalized);
  assert.deepEqual(normalized.facts.images, [{
    position: 0,
    downloadUrl:
      'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x',
    aesKey: key.toString('base64url'),
  }]);
  assert.deepEqual(normalized.message.attachments, [{
    kind: 'image',
    mediaId: 'ilink:0',
    filename: 'ilink-image-0',
    status: 'unresolved',
  }]);
  assert.doesNotMatch(normalized.message.summary, /encrypted_query_param/u);
  const serialized = JSON.stringify(normalized.message);
  for (const secret of [
    'context-secret',
    'encrypted_query_param',
    key.toString('base64url'),
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  }
});

test('iLink image extraction keeps only the latest four locators', () => {
  const normalized = normalize({
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
  assert.deepEqual(
    normalized?.facts.images.map((image) => image.position),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    normalized?.message.attachments.map((attachment) => attachment.mediaId),
    ['ilink:1', 'ilink:2', 'ilink:3', 'ilink:4'],
  );
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

  assert.equal(empty?.message.type, 'empty');
  assert.equal(empty?.message.text, '');
  assert.equal(empty?.message.summary, '[iLink message: no readable content]');
  assert.equal(empty?.facts.providerSeq, 8);
  assert.equal(whitespace?.message.type, 'text');
  assert.equal(whitespace?.message.text, '   ');
  assert.equal(whitespace?.message.summary, '[iLink text: empty]');
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

  test('the legitimate initial empty cursor is preserved', () => {
    const normalized = normalize(base, pair, { cursor: '', index: 0 });

    assert.deepEqual(normalized?.message.sync, { cursor: '', index: 0 });
  });

  test('invalid cursor/index configuration is rejected', () => {
    for (const position of [
      { cursor: 'bad\0cursor', index: 0 },
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
    assert.ok(Buffer.byteLength(text.message.text, 'utf8') <= 32 * 1_024);
    assert.ok(Buffer.byteLength(text.message.summary, 'utf8') <= 48 * 1_024);
    assert.ok(Buffer.byteLength(file.message.summary, 'utf8') < 512);
    assert.match(text.message.text, /…$/u);
    assert.match(file.message.summary, /…/u);
  });
});
