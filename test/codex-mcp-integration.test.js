import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexResponder,
  createCodexClient,
} from '../src/services/codex-responder.js';
import { WecomMediaGateway } from '../src/services/media-gateway.js';
import { WecomApiClient } from '../src/services/wecom-api.js';
import { WecomMessageProcessor } from '../src/services/wecom-message-processor.js';
import { JsonStateStore } from '../src/state/json-state-store.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const integrationTest =
  process.env.RUN_CODEX_MCP_INTEGRATION === '1' ? test : test.skip;

async function runScenario(
  t,
  {
    customerContent = '',
    customerMessage = undefined,
    customerMessages = undefined,
    rememberedAttachments = [],
    steerAfterFirstTool = false,
  },
) {
  const sent = [];
  const uploads = [];
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const server = http.createServer(async (request, response) => {
    const url = request.url || '';

    if (url.startsWith('/cgi-bin/gettoken?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ access_token: 'mock-access', expires_in: 7200 }),
      );
      return;
    }

    if (url.startsWith('/cgi-bin/media/get?')) {
      response.setHeader('Content-Type', 'image/png');
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="customer.png"',
      );
      response.end(png);
      return;
    }

    if (url.startsWith('/cgi-bin/media/upload?')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks));
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          errcode: 0,
          errmsg: 'ok',
          type: 'image',
          media_id: 'mock-uploaded-media',
          created_at: '123',
        }),
      );
      return;
    }

    if (url.startsWith('/cgi-bin/kf/send_msg?')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ errcode: 0, errmsg: 'ok', msgid: 'mock-msgid' }),
      );
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  let processor;
  let followUpEnqueuePromise;
  let resolveFollowUpScheduled;
  const followUpScheduled = new Promise((resolve) => {
    resolveFollowUpScheduled = resolve;
  });
  const config = {
    apiKey: '',
    baseUrl: '',
    pathOverride: '',
    localAccessEnabled: false,
    model: '',
    reasoningEffort: undefined,
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    imageTempDirectory: '/dev/shm',
    workingDirectory: path.join(projectRoot, 'codex-workspace'),
    onNotification: steerAfterFirstTool
      ? (message) => {
          if (
            !followUpEnqueuePromise &&
            message.method === 'item/completed' &&
            message.params?.item?.type === 'mcpToolCall'
          ) {
            followUpEnqueuePromise = processor.enqueue({
              callbackToken: 'mock-follow-up-token',
              openKfId: 'wk-mock-bound',
            });
            resolveFollowUpScheduled();
          }
        }
      : undefined,
  };
  const stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-kf-mcp-integration-'),
  );
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const store = new JsonStateStore({
    filePath: path.join(stateDirectory, 'state.json'),
  });

  if (rememberedAttachments.length) {
    await store.rememberInboundAttachments({
      openKfId: 'wk-mock-bound',
      externalUserId: 'wm-mock-bound',
      messageId: 'previous-customer-media',
      sentAt: 122,
      attachments: rememberedAttachments,
    });
  }

  const responder = new CodexResponder({
    codexFactory: (toolContext) =>
      createCodexClient(config, {
        corpId: 'ww-mock',
        kfSecret: 'mock-secret',
        apiBaseUrl,
        ...toolContext,
        journalFile: path.join(stateDirectory, 'tool-journal.sqlite'),
      }),
    store,
    config,
  });
  const sendingApiClient = new WecomApiClient({
    corpId: 'ww-mock',
    kfSecret: 'mock-secret',
    baseUrl: apiBaseUrl,
  });
  const mediaGateway = new WecomMediaGateway({ apiClient: sendingApiClient });
  let syncCalls = 0;
  processor = new WecomMessageProcessor({
    apiClient: {
      async syncMessages() {
        syncCalls += 1;
        const baseMessage = {
          msgid: 'mock-customer-message',
          open_kfid: 'wk-mock-bound',
          external_userid: 'wm-mock-bound',
          send_time: 123,
          origin: 3,
        };
        const allPayloads = customerMessages || [
          customerMessage || {
            msgtype: 'text',
            text: { content: customerContent },
          },
        ];
        const payloads = steerAfterFirstTool
          ? [allPayloads[Math.min(syncCalls - 1, allPayloads.length - 1)]]
          : allPayloads;
        const offset = steerAfterFirstTool ? syncCalls - 1 : 0;
        return {
          next_cursor: `mock-next-cursor-${syncCalls}`,
          has_more: 0,
          msg_list: payloads.map((payload, index) =>
            ({
              ...baseMessage,
              msgid:
                index + offset === 0
                  ? 'mock-customer-message'
                  : `mock-customer-message-${index + offset}`,
              send_time: 123 + index + offset,
              ...payload,
            }),
          ),
        };
      },
      sendTextMessage: (message) => sendingApiClient.sendTextMessage(message),
      sendLocationMessage: (message) =>
        sendingApiClient.sendLocationMessage(message),
      sendLinkMessage: (message) => sendingApiClient.sendLinkMessage(message),
      sendMiniProgramMessage: (message) =>
        sendingApiClient.sendMiniProgramMessage(message),
      sendMediaMessage: (message) => sendingApiClient.sendMediaMessage(message),
    },
    mediaGateway,
    responder,
    store,
    allowedUserIds: ['wm-mock-bound'],
    logger:
      process.env.DEBUG_CODEX_MCP_INTEGRATION === '1'
        ? console
        : { info() {}, warn() {}, error() {} },
  });

  await processor.enqueue({
    callbackToken: 'mock-callback-token',
    openKfId: 'wk-mock-bound',
  });
  if (steerAfterFirstTool) {
    let timeoutId;
    try {
      await Promise.race([
        followUpScheduled,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Codex did not stage the first tool call')),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    await followUpEnqueuePromise;
  }
  await processor.waitForIdle();

  return {
    cursor: await store.getCursor('wk-mock-bound'),
    record: await store.getMessage('mock-customer-message'),
    sent,
    uploads,
  };
}

integrationTest(
  'real Codex uses concise text for choices when no menu tool is exposed',
  async (t) => {
    const result = await runScenario(t, {
      customerContent:
        '请告诉我两个服务选项：售前咨询、售后服务。用简洁文字回复。',
    });

    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].touser, 'wm-mock-bound');
    assert.equal(result.sent[0].open_kfid, 'wk-mock-bound');
    assert.equal(result.sent[0].msgtype, 'text');
    assert.match(result.sent[0].text.content, /售前咨询/u);
    assert.match(result.sent[0].text.content, /售后服务/u);
    assert.equal(result.record.status, 'sent');
    assert.equal(result.record.toolDispatches[0].tool, 'send_text');
    assert.equal(result.record.sendReceipts[0].wecomMsgId, 'mock-msgid');
    assert.equal(result.cursor, 'mock-next-cursor-1');
  },
);

integrationTest(
  'real Codex resends only a remembered customer image reference',
  async (t) => {
    const result = await runScenario(t, {
      customerContent: '把我刚才发送的原图重新发给我，不要文字说明。',
      rememberedAttachments: [
        { kind: 'image', mediaId: 'mock-customer-image' },
      ],
    });

    assert.equal(result.uploads.length, 1);
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].touser, 'wm-mock-bound');
    assert.equal(result.sent[0].open_kfid, 'wk-mock-bound');
    assert.equal(result.sent[0].msgtype, 'image');
    assert.deepEqual(result.sent[0].image, {
      media_id: 'mock-uploaded-media',
    });
    assert.match(result.sent[0].msgid, /^wb_[0-9a-f]{29}$/);
    assert.equal(result.record.toolDispatches[0].tool, 'send_image');
    assert.deepEqual(result.record.toolDispatches[0].arguments, {
      mediaRef: 'media:0',
    });
  },
);

integrationTest(
  'real Codex chooses a native location instead of a map link',
  async (t) => {
    const result = await runScenario(t, {
      customerContent:
        '请把天安门以微信位置卡片发给我，不要发地图链接。已核验：名称天安门，地址北京市东城区东长安街，纬度39.9087，经度116.3975。',
    });

    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].touser, 'wm-mock-bound');
    assert.equal(result.sent[0].open_kfid, 'wk-mock-bound');
    assert.equal(result.sent[0].msgtype, 'location');
    assert.match(result.sent[0].location.name, /天安门/);
    assert.equal(result.sent[0].location.latitude, 39.9087);
    assert.equal(result.sent[0].location.longitude, 116.3975);
    assert.equal(result.record.toolDispatches[0].tool, 'send_location');
  },
);

integrationTest(
  'real Codex sends one native card per verified location without extra text',
  async (t) => {
    const result = await runScenario(t, {
      customerContent:
        '请分别以微信原生位置卡片发送这三处，不要任何说明文字：甲店，地址北京市东城区甲路1号，纬度39.91，经度116.40；乙店，地址北京市西城区乙路2号，纬度39.92，经度116.38；丙店，地址北京市海淀区丙路3号，纬度39.98，经度116.31。',
    });

    assert.equal(result.sent.length, 3);
    assert.ok(result.sent.every((message) => message.msgtype === 'location'));
    assert.deepEqual(
      result.sent.map((message) => message.location.name).sort(),
      ['甲店', '乙店', '丙店'].sort(),
    );
    assert.ok(
      result.record.toolDispatches.every(
        (dispatch) => dispatch.tool === 'send_location',
      ),
    );
    assert.equal(new Set(result.sent.map((message) => message.msgid)).size, 3);
  },
);

integrationTest(
  'real Codex chooses a native link card for a trusted destination',
  async (t) => {
    const result = await runScenario(t, {
      customerContent:
        '请把帮助中心以微信图文链接卡片发给我。标题“帮助中心”，描述“查看使用说明”，可信链接 https://example.com/help 。',
    });

    assert.equal(result.uploads.length, 1);
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].msgtype, 'link');
    assert.equal(result.sent[0].link.title, '帮助中心');
    assert.equal(result.sent[0].link.url, 'https://example.com/help');
    assert.equal(result.record.toolDispatches[0].tool, 'send_link');
  },
);

integrationTest(
  'real Codex steers an active turn with an inbound link-card summary',
  async (t) => {
    const result = await runScenario(t, {
      customerMessages: [
        {
          msgtype: 'text',
          text: {
            content:
              '我接下来会发一张博主主页卡片，收到后请告诉我这个博主是做什么的。',
          },
        },
        {
          msgtype: 'link',
          link: {
            title: '@示例博主的个人主页',
            desc: '主要分享 AI 编程、开源项目和开发教程',
            url: 'https://example.com/creator',
            pic_url: 'https://example.com/avatar.png',
          },
        },
      ],
    });

    assert.equal(result.sent.length, 1);
    const finalMessage = result.sent.at(-1);
    assert.equal(finalMessage.msgtype, 'text');
    assert.match(finalMessage.text.content, /AI/u);
    assert.match(finalMessage.text.content, /编程|开源|开发/u);
  },
);

integrationTest(
  'real Codex discards a staged reply completed before steering',
  async (t) => {
    const result = await runScenario(t, {
      steerAfterFirstTool: true,
      customerMessages: [
        {
          msgtype: 'text',
          text: { content: '介绍一下华北' },
        },
        {
          msgtype: 'text',
          text: { content: '只说三个著名景点' },
        },
      ],
    });

    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].msgtype, 'text');
    assert.match(result.sent[0].text.content, /故宫|长城|云冈|颐和园/u);
    assert.doesNotMatch(result.sent[0].text.content, /华北通常|代表城市/u);
    assert.equal(result.record.toolDispatches.length, 1);
  },
);

integrationTest(
  'real Codex chooses a verified native mini-program card',
  async (t) => {
    const result = await runScenario(t, {
      customerContent:
        '请发送已核验的微信小程序卡片：appid 是 wx1234567890abcdef，标题“服务入口”，pagepath 是 pages/index.html，核验来源 https://example.com/mini-program 。',
    });

    assert.equal(result.uploads.length, 1);
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].msgtype, 'miniprogram');
    assert.deepEqual(result.sent[0].miniprogram, {
      appid: 'wx1234567890abcdef',
      title: '服务入口',
      thumb_media_id: 'mock-uploaded-media',
      pagepath: 'pages/index.html',
    });
    assert.equal(result.record.toolDispatches[0].tool, 'send_miniprogram');
  },
);
