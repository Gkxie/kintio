import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_TYPES,
  isSupportedCustomerMessage,
  normalizeWecomMessage,
  renderMessageForCodex,
} from '../../src/domain/wecom-message.js';

function customer(msgtype: string, section: unknown = undefined) {
  return normalizeWecomMessage({
    msgid: `edge-${msgtype}`,
    open_kfid: 'wk-edge',
    external_userid: 'wm-edge',
    origin: 3,
    msgtype,
    ...(section && typeof section === 'object' ? section : {}),
  });
}

test('[G05][C03] malformed and unknown payloads produce explicit safe summaries', () => {
  const empty = normalizeWecomMessage(null);
  assert.equal(empty.type, MESSAGE_TYPES.UNKNOWN);
  assert.equal(isSupportedCustomerMessage(empty), false);
  assert.match(renderMessageForCodex(empty), /内容未解析/u);

  const primitive = normalizeWecomMessage('not-an-object');
  assert.equal(primitive.origin, 'unknown');
  assert.equal(primitive.conversation.externalUserId, '');

  const unknown = customer('future_type', { future_type: { secret: 'x' } });
  assert.equal(unknown.type, MESSAGE_TYPES.UNKNOWN);
  assert.equal(isSupportedCustomerMessage(unknown), false);
  assert.doesNotMatch(unknown.summary, /secret/u);
});

test('[C03] optional structured fields remain useful without inventing details', () => {
  const menuWithoutList = customer('msgmenu', { msgmenu: { head_content: '选择' } });
  assert.match(menuWithoutList.summary, /选择/u);

  const menu = customer('msgmenu', {
    msgmenu: {
      list: [null, { type: 'click', click: { content: '售后' } }],
      tail_content: '结束',
    },
  });
  assert.match(menu.summary, /售后/u);

  const sparseFile = customer('file', { file: {} });
  assert.match(sparseFile.summary, /内容未下载或打开/u);

  const sparseLocation = customer('location', {
    location: { name: '未知坐标', latitude: 'bad', longitude: null },
  });
  assert.doesNotMatch(sparseLocation.summary, /纬度/u);
});

test('[C05] malformed and deeply nested merged history is bounded', () => {
  const malformed = customer('merged_msg', {
    merged_msg: {
      title: '混合记录',
      item: [
        { sender_name: '甲', msgtype: 'text', msg_content: '{bad json' },
        { sender_name: '乙', msgtype: 'text', msg_content: '[]' },
      ],
    },
  });
  assert.match(malformed.summary, /内容无法解析/u);

  let nested: Record<string, unknown> = {
    msgtype: 'text',
    text: { content: '最深文本' },
  };
  for (let depth = 0; depth < 5; depth += 1) {
    nested = {
      msgtype: 'merged_msg',
      merged_msg: {
        title: `depth-${depth}`,
        item: [{ sender_name: '递归', msg_content: JSON.stringify(nested) }],
      },
    };
  }
  const deep = customer('merged_msg', { merged_msg: nested.merged_msg });
  assert.match(deep.summary, /嵌套深度上限/u);
  assert.ok(Buffer.byteLength(deep.summary) <= 16 * 1024);
});
