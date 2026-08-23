import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  CodexResponder,
  createCodexClient,
} from '../src/services/codex-responder.js';
import { WecomMediaGateway } from '../src/services/media-gateway.js';
import { WecomApiClient } from '../src/services/wecom-api.js';
import { WecomMessageProcessor } from '../src/services/wecom-message-processor.js';
import { JsonStateStore } from '../src/state/json-state-store.js';

const liveTest =
  process.env.RUN_LIVE_WECOM_IMAGE_INTEGRATION === '1' ? test : test.skip;

function latestImageConversation(state) {
  return Object.entries(state.inboundMedia || {})
    .map(([conversationKey, entries]) => ({
      conversationKey,
      entries: (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry.kind === 'image' && entry.mediaId)
        .sort((left, right) => Number(right.sentAt) - Number(left.sentAt)),
    }))
    .filter((item) => item.entries.length >= 2)
    .sort(
      (left, right) =>
        Number(right.entries[0]?.sentAt || 0) -
        Number(left.entries[0]?.sentAt || 0),
    )[0];
}

liveTest(
  'mock upstream input sends a real generated image to the latest authorized customer',
  { timeout: 240_000 },
  async (t) => {
    const config = loadConfig();
    const productionState = JSON.parse(
      await fs.readFile(config.state.filePath, 'utf8'),
    );
    const source = latestImageConversation(productionState);
    assert.ok(source, 'two recent customer images are required');
    const separator = source.conversationKey.indexOf(':');
    const openKfId = source.conversationKey.slice(0, separator);
    const externalUserId = source.conversationKey.slice(separator + 1);
    assert.ok(openKfId && externalUserId);
    const [faceImage, baseImage] = source.entries.slice(0, 2);
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wechat-live-image-integration-'),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'tool-journal.sqlite');
    const store = new JsonStateStore({ filePath: stateFile });
    const apiClient = new WecomApiClient({
      corpId: config.wecom.api.corpId,
      kfSecret: config.wecom.api.kfSecret,
      timeoutMs: config.wecom.api.timeoutMs,
    });
    const mediaGateway = new WecomMediaGateway({ apiClient });
    const responder = new CodexResponder({
      codexFactory: (toolContext) =>
        createCodexClient(config.codex, {
          corpId: config.wecom.api.corpId,
          kfSecret: config.wecom.api.kfSecret,
          timeoutMs: config.wecom.api.timeoutMs,
          ...toolContext,
          journalFile,
        }),
      store,
      config: config.codex,
      logger: console,
    });
    const now = Math.floor(Date.now() / 1000);
    let syncCalls = 0;
    const mockUpstreamApi = {
      async syncMessages() {
        syncCalls += 1;
        return syncCalls === 1
          ? {
              next_cursor: 'live-mock-cursor',
              has_more: 0,
              msg_list: [
                {
                  msgid: `live_mock_text_${now}`,
                  open_kfid: openKfId,
                  external_userid: externalUserId,
                  send_time: now,
                  origin: 3,
                  msgtype: 'text',
                  text: {
                    content:
                      '以船上图片为底图，把船上有头发的人的脸换成红发人物的脸，保留底图的身体、姿势、背景和构图。',
                  },
                },
                {
                  msgid: `live_mock_base_${now}`,
                  open_kfid: openKfId,
                  external_userid: externalUserId,
                  send_time: now + 1,
                  origin: 3,
                  msgtype: 'image',
                  image: { media_id: baseImage.mediaId },
                },
                {
                  msgid: `live_mock_face_${now}`,
                  open_kfid: openKfId,
                  external_userid: externalUserId,
                  send_time: now + 2,
                  origin: 3,
                  msgtype: 'image',
                  image: { media_id: faceImage.mediaId },
                },
              ],
            }
          : {
              next_cursor: 'live-mock-cursor',
              has_more: 0,
              msg_list: [],
            };
      },
      sendTextMessage: (message) => apiClient.sendTextMessage(message),
      sendLocationMessage: (message) => apiClient.sendLocationMessage(message),
      sendLinkMessage: (message) => apiClient.sendLinkMessage(message),
      sendMiniProgramMessage: (message) =>
        apiClient.sendMiniProgramMessage(message),
      sendMediaMessage: (message) => apiClient.sendMediaMessage(message),
    };
    const processor = new WecomMessageProcessor({
      apiClient: mockUpstreamApi,
      mediaGateway,
      responder,
      store,
      allowedUserIds: [externalUserId],
      toolJournalFile: journalFile,
      logger: console,
    });

    await processor.enqueue({
      callbackToken: 'mocked-upstream-token',
      openKfId,
    });
    await processor.waitForIdle();

    const primary = await store.getMessage(`live_mock_text_${now}`);
    assert.equal(primary.status, 'sent');
    assert.equal(primary.toolDispatches.length, 1);
    assert.equal(primary.toolDispatches[0].tool, 'send_generated_image');
    assert.equal(primary.sendReceipts.length, 1);
    assert.equal(primary.sendReceipts[0].sentType, 'image');
    assert.ok(['accepted', 'uncertain'].includes(primary.sendReceipts[0].status));
    assert.equal(
      (await store.getMessage(`live_mock_base_${now}`)).status,
      'absorbed',
    );
    assert.equal(
      (await store.getMessage(`live_mock_face_${now}`)).status,
      'absorbed',
    );
  },
);

liveTest(
  'mock upstream quality feedback uses real Codex and real WeChat delivery state',
  { timeout: 120_000 },
  async (t) => {
    const config = loadConfig();
    const productionState = JSON.parse(
      await fs.readFile(config.state.filePath, 'utf8'),
    );
    const source = latestImageConversation(productionState);
    assert.ok(source);
    const separator = source.conversationKey.indexOf(':');
    const openKfId = source.conversationKey.slice(0, separator);
    const externalUserId = source.conversationKey.slice(separator + 1);
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wechat-live-feedback-integration-'),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const journalFile = path.join(directory, 'tool-journal.sqlite');
    const store = new JsonStateStore({
      filePath: path.join(directory, 'state.json'),
    });
    await store.setGeneratedMessage('seed-generated-delivery', {
      openKfId,
      externalUserId,
      outboundMessages: [],
      toolDispatches: [
        {
          tool: 'send_generated_image',
          arguments: {
            byteLength: 1024,
            revisedPrompt:
              'Apply only the requested delta and preserve every unmentioned visual property.',
          },
        },
      ],
      sendReceipts: [
        {
          wecomMsgId: 'seed-delivered-image',
          sentType: 'image',
          status: 'accepted',
        },
      ],
    });
    await store.markMessageSent('seed-generated-delivery');
    const apiClient = new WecomApiClient({
      corpId: config.wecom.api.corpId,
      kfSecret: config.wecom.api.kfSecret,
      timeoutMs: config.wecom.api.timeoutMs,
    });
    const mediaGateway = new WecomMediaGateway({ apiClient });
    const responder = new CodexResponder({
      codexFactory: (toolContext) =>
        createCodexClient(config.codex, {
          corpId: config.wecom.api.corpId,
          kfSecret: config.wecom.api.kfSecret,
          timeoutMs: config.wecom.api.timeoutMs,
          ...toolContext,
          journalFile,
        }),
      store,
      config: config.codex,
      logger: console,
    });
    const messageId = `live_mock_feedback_${Math.floor(Date.now() / 1000)}`;
    let syncCalls = 0;
    const mockUpstreamApi = {
      async syncMessages() {
        syncCalls += 1;
        return {
          next_cursor: 'live-feedback-cursor',
          has_more: 0,
          msg_list:
            syncCalls === 1
              ? [
                  {
                    msgid: messageId,
                    open_kfid: openKfId,
                    external_userid: externalUserId,
                    send_time: Math.floor(Date.now() / 1000),
                    origin: 3,
                    msgtype: 'text',
                    text: {
                      content:
                        '上一张图把我没有要求修改的内容也改了，这是怎么回事？',
                    },
                  },
                ]
              : [],
        };
      },
      sendTextMessage: (message) => apiClient.sendTextMessage(message),
      sendLocationMessage: (message) => apiClient.sendLocationMessage(message),
      sendLinkMessage: (message) => apiClient.sendLinkMessage(message),
      sendMiniProgramMessage: (message) =>
        apiClient.sendMiniProgramMessage(message),
      sendMediaMessage: (message) => apiClient.sendMediaMessage(message),
    };
    const processor = new WecomMessageProcessor({
      apiClient: mockUpstreamApi,
      mediaGateway,
      responder,
      store,
      allowedUserIds: [externalUserId],
      toolJournalFile: journalFile,
      logger: console,
    });

    await processor.enqueue({
      callbackToken: 'mocked-feedback-token',
      openKfId,
    });
    await processor.waitForIdle();

    const record = await store.getMessage(messageId);
    assert.equal(record.status, 'sent');
    assert.equal(record.toolDispatches.length, 1);
    assert.equal(record.toolDispatches[0].tool, 'send_text');
    const content = record.toolDispatches[0].arguments.content;
    assert.doesNotMatch(content, /没有返回成品|生成失败|合成失败/u);
    assert.match(content, /结果|编辑|修改|偏差|预期/u);
    assert.equal(record.sendReceipts.length, 1);
    assert.equal(record.sendReceipts[0].sentType, 'text');
  },
);
