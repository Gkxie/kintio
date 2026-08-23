import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexResponder,
} from '../src/services/codex-responder.js';
import { WecomMediaGateway } from '../src/services/media-gateway.js';
import { WecomMessageProcessor } from '../src/services/wecom-message-processor.js';
import { JsonStateStore } from '../src/state/json-state-store.js';

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');

test('upstream text and two image messages produce one generated WeChat image', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-generated-image-integration-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const generatedDirectory = path.join(directory, 'generated_images');
  await fs.mkdir(generatedDirectory);
  const generatedPath = path.join(generatedDirectory, 'face-swap.png');
  await fs.writeFile(generatedPath, PNG);
  const store = new JsonStateStore({
    filePath: path.join(directory, 'state.json'),
  });
  const downloads = [];
  const uploads = [];
  const sentImages = [];
  const sentTexts = [];
  const localImagePaths = [];
  const apiClient = {
    async syncMessages() {
      return {
        next_cursor: 'cursor-generated-image',
        has_more: 0,
        msg_list: [
          {
            msgid: 'mock-edit-instruction',
            open_kfid: 'wk-mock',
            external_userid: 'wm-mock',
            send_time: 100,
            origin: 3,
            msgtype: 'text',
            text: {
              content:
                '船上有头发的那个人，把他的脸换成红发的那个人。',
            },
          },
          {
            msgid: 'mock-base-image',
            open_kfid: 'wk-mock',
            external_userid: 'wm-mock',
            send_time: 101,
            origin: 3,
            msgtype: 'image',
            image: { media_id: 'base-image-media' },
          },
          {
            msgid: 'mock-face-image',
            open_kfid: 'wk-mock',
            external_userid: 'wm-mock',
            send_time: 102,
            origin: 3,
            msgtype: 'image',
            image: { media_id: 'face-image-media' },
          },
        ],
      };
    },
    async downloadMedia(mediaId) {
      downloads.push(mediaId);
      return {
        bytes: PNG,
        contentType: 'image/png',
        filename: `${mediaId}.png`,
      };
    },
    async uploadMedia(input) {
      uploads.push(input);
      return { media_id: 'uploaded-generated-image' };
    },
    async sendMediaMessage(message) {
      sentImages.push(message);
      return { errcode: 0, errmsg: 'ok', msgid: 'generated-image-message' };
    },
    async sendTextMessage(message) {
      sentTexts.push(message);
      return { errcode: 0, errmsg: 'ok', msgid: 'unexpected-text-message' };
    },
  };
  const mediaGateway = new WecomMediaGateway({ apiClient });
  let resolveTurn;
  const turnCompletion = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  let steerCalls = 0;
  const thread = {
    id: 'mock-generated-image-thread',
    async startRun() {
      return { turnId: 'mock-generated-image-turn', completion: turnCompletion };
    },
    async steer(input) {
      steerCalls += 1;
      const image = input.find?.((item) => item.type === 'local_image');
      assert.ok(image, 'each image follow-up must reach Codex as a local image');
      localImagePaths.push(image.path);
      assert.deepEqual(await fs.readFile(image.path), PNG);

      if (steerCalls === 2) {
        queueMicrotask(() =>
          resolveTurn({
            finalResponse: '',
            usage: null,
            lastSteerSequence: 10,
            items: [
              {
                id: 'generated-face-swap',
                type: 'imageGeneration',
                status: 'completed',
                revisedPrompt: '以船上图片为底图，换成参考人脸',
                result: PNG.toString('base64'),
                failure: null,
                savedPath: generatedPath,
                startedSequence: 11,
                completedSequence: 12,
              },
              {
                id: 'incorrect-fallback',
                type: 'mcp_tool_call',
                server: 'wechat_kf',
                tool: 'send_text',
                arguments: { content: '图片编辑失败' },
                status: 'completed',
                startedSequence: 13,
                result: {
                  structured_content: {
                    deferred: true,
                    receipts: [
                      {
                        wecomMsgId: 'staged-fallback',
                        sentType: 'text',
                        status: 'staged',
                      },
                    ],
                  },
                },
              },
            ],
          }),
        );
      }
      return 'mock-generated-image-turn';
    },
    async close() {},
  };
  const config = {
    model: 'gpt-test',
    reasoningEffort: 'none',
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    imageTempDirectory: directory,
    workingDirectory: directory,
  };
  const responder = new CodexResponder({
    codexFactory() {
      return {
        startThread() {
          return thread;
        },
      };
    },
    store,
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  const processor = new WecomMessageProcessor({
    apiClient,
    mediaGateway,
    responder,
    store,
    allowedUserIds: ['wm-mock'],
    toolJournalFile: path.join(directory, 'tool-journal.sqlite'),
    logger: { info() {}, warn() {}, error() {} },
  });

  await processor.enqueue({
    callbackToken: 'mock-callback-token',
    openKfId: 'wk-mock',
  });
  await processor.waitForIdle();

  assert.deepEqual(downloads, ['base-image-media', 'face-image-media']);
  assert.equal(steerCalls, 2);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].bytes, PNG);
  assert.equal(sentTexts.length, 0);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].toUser, 'wm-mock');
  assert.equal(sentImages[0].openKfId, 'wk-mock');
  assert.equal(sentImages[0].mediaId, 'uploaded-generated-image');
  assert.match(sentImages[0].messageId, /^wb_[0-9a-f]{29}$/u);
  assert.equal(
    (await store.getMessage('mock-edit-instruction')).toolDispatches[0].tool,
    'send_generated_image',
  );
  assert.equal((await store.getMessage('mock-base-image')).status, 'absorbed');
  assert.equal((await store.getMessage('mock-face-image')).status, 'absorbed');
  await assert.rejects(() => fs.access(generatedPath), { code: 'ENOENT' });
  for (const imagePath of localImagePaths) {
    await assert.rejects(() => fs.access(imagePath), { code: 'ENOENT' });
  }
});
