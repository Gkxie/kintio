import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  createDomainMessage,
} from '../src/domain/message.js';
import { CodexResponder } from '../src/services/codex-responder.js';

class MemoryThreadStore {
  constructor() {
    this.threads = new Map();
    this.generatedDelivery = undefined;
  }

  async getThreadId(key) {
    return this.threads.get(key) || '';
  }

  async setThreadId(key, value) {
    this.threads.set(key, value);
  }

  async getLatestGeneratedImageDelivery() {
    return this.generatedDelivery
      ? structuredClone(this.generatedDelivery)
      : undefined;
  }
}

function testConfig(workingDirectory) {
  return {
    apiKey: '',
    baseUrl: '',
    pathOverride: '',
    localAccessEnabled: false,
    model: '',
    reasoningEffort: undefined,
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    imageTempDirectory: workingDirectory,
    workingDirectory,
  };
}

function customerMessage(text, externalUserId = 'wm-one') {
  return createDomainMessage({
    id: `message-${externalUserId}`,
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId,
    text,
  });
}

test('Codex responder isolates and persists a thread per customer', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  const startCalls = [];
  const prompts = [];
  const codex = {
    startThread(options) {
      startCalls.push(options);
      return {
        id: null,
        async run(prompt, options) {
          prompts.push(prompt);
          assert.equal(options.outputSchema.type, 'object');
          this.id = `thread-${startCalls.length}`;
          return { finalResponse: '客服回复' };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used in this instance');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });

  assert.deepEqual(
    await responder.respond({ message: customerMessage('你好') }),
    { type: 'text', text: '客服回复' },
  );
  await responder.respond({ message: customerMessage('继续') });
  await responder.respond({
    message: customerMessage('另一个客户', 'wm-two'),
  });

  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0].sandboxMode, 'read-only');
  assert.equal(startCalls[0].networkAccessEnabled, false);
  assert.equal(startCalls[0].webSearchMode, 'disabled');
  assert.equal(startCalls[0].approvalPolicy, 'never');
  assert.equal(await store.getThreadId('wk-one:wm-one'), 'thread-1');
  assert.equal(await store.getThreadId('wk-one:wm-two'), 'thread-2');
  assert.match(prompts[0], /不可信输入/);
  assert.match(prompts[0], /没有本机文件访问权限/);
  assert.match(prompts[0], /必须先调用网页搜索工具/);
  assert.match(prompts[0], /你好/);
});

test('Codex responder resumes a persisted thread after restart', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-resume-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  await store.setThreadId('wk-one:wm-one', 'persisted-thread');
  const resumeCalls = [];
  const codex = {
    startThread() {
      throw new Error('startThread should not be used');
    },
    resumeThread(id, options) {
      resumeCalls.push({ id, options });
      return {
        id,
        async run() {
          return { finalResponse: '已恢复' };
        },
      };
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });

  const response = await responder.respond({
    message: customerMessage('继续会话'),
  });

  assert.deepEqual(response, { type: 'text', text: '已恢复' });
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].id, 'persisted-thread');
});

test('Codex responder stages customer images and removes them after the turn', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-image-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  let stagedPath = '';
  const codex = {
    startThread() {
      return {
        id: 'image-thread',
        async run(input) {
          assert.ok(Array.isArray(input));
          const image = input.find((item) => item.type === 'local_image');
          stagedPath = image.path;
          const bytes = await fs.readFile(stagedPath);
          assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
          return { finalResponse: '图片已识别' };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });
  const message = createDomainMessage({
    id: 'image-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.IMAGE,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
  });

  const response = await responder.respond({
    message,
    resolvedMedia: [
      {
        kind: 'image',
        bytes: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
      },
    ],
  });

  assert.deepEqual(response, { type: 'text', text: '图片已识别' });
  await assert.rejects(() => fs.access(stagedPath), { code: 'ENOENT' });
});

test('Codex responder retries location intent before falling back to text', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-location-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  const prompts = [];
  const responses = [
    JSON.stringify({
      type: 'text',
      text: '地址是北京市东城区',
      location: { name: '', address: '', latitude: 0, longitude: 0 },
    }),
    JSON.stringify({
      type: 'location',
      text: '',
      location: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    }),
  ];
  const codex = {
    startThread() {
      return {
        id: 'location-thread',
        async run(prompt) {
          prompts.push(prompt);
          return { finalResponse: responses.shift() };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });

  const reply = await responder.respond({
    message: customerMessage('把天安门的位置发给我'),
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /微信原生 location 是首选/);
  assert.match(prompts[1], /重新检查/);
  assert.deepEqual(reply, {
    type: 'location',
    location: {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });
});

test('Codex responder retries explicit mini-program intent', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-mini-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  const prompts = [];
  const responses = [
    JSON.stringify({ type: 'text', text: '请在微信中搜索门店' }),
    JSON.stringify({
      type: 'miniprogram',
      miniprogram: {
        appId: 'wx1234567890abcdef',
        title: '门店小程序',
        pagePath: 'pages/store/index',
        sourceUrl: 'https://example.com/mini-program',
      },
    }),
  ];
  const codex = {
    startThread() {
      return {
        id: 'mini-thread',
        async run(prompt) {
          prompts.push(prompt);
          return { finalResponse: responses.shift() };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });

  const reply = await responder.respond({
    message: customerMessage('把这家店的小程序卡片发给我'),
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /微信内部的结构化直达链接/);
  assert.match(prompts[1], /appId 与 pagePath/);
  assert.equal(reply.type, 'miniprogram');
  assert.equal(reply.miniprogram.pagePath, 'pages/store/index');
});

test('Codex responder promotes a resolvable map link before retrying', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-map-resolver-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  let runCalls = 0;
  const codex = {
    startThread() {
      return {
        id: 'map-resolver-thread',
        async run() {
          runCalls += 1;
          return {
            finalResponse: JSON.stringify({
              type: 'link',
              link: {
                title: '门店',
                description: '北京市海淀区',
                url: 'https://maps.apple.com/place?place-id=example',
              },
            }),
          };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
    replyResolver: {
      async resolve({ reply }) {
        if (reply.type !== 'link') return reply;
        return {
          type: 'location',
          location: {
            name: reply.link.title,
            address: reply.link.description,
            latitude: 39.980657,
            longitude: 116.365992,
          },
        };
      },
    },
  });

  const reply = await responder.respond({
    message: customerMessage('把门店的位置发给我'),
  });

  assert.equal(runCalls, 1);
  assert.equal(reply.type, 'location');
  assert.equal(reply.location.longitude, 116.365992);
});

test('Codex responder can select only an advertised customer-media reference', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-media-reply-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  let capturedPrompt = '';
  const codex = {
    startThread() {
      return {
        id: 'media-reply-thread',
        async run(prompt) {
          capturedPrompt = prompt;
          return {
            finalResponse: JSON.stringify({
              type: 'image',
              text: '暂时无法重新发送原图。',
              media: {
                reference: 'media:0',
                caption: '这是你刚才发送的原图：',
              },
            }),
          };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });

  const reply = await responder.respond({
    message: customerMessage('把刚才的原图重新发给我'),
    mediaCatalog: [
      {
        ref: 'media:0',
        kind: 'image',
        messageId: 'previous-image',
        sentAt: 123,
      },
    ],
  });

  assert.match(capturedPrompt, /media:0：图片/);
  assert.match(capturedPrompt, /只有客户明确要求重新发送/);
  assert.deepEqual(reply, {
    type: 'image',
    media: {
      reference: 'media:0',
      caption: '这是你刚才发送的原图：',
    },
    fallbackText: '暂时无法重新发送原图。',
  });
});

test('Codex responder treats successful MCP sends as the delivered reply', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-tool-dispatch-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  let factoryContext;
  let capturedPrompt = '';
  let capturedRunOptions;
  const responder = new CodexResponder({
    codexFactory(context) {
      factoryContext = context;
      return {
        startThread() {
          return {
            id: 'tool-thread',
            async run(prompt, options) {
              capturedPrompt = prompt;
              capturedRunOptions = options;
              return {
                finalResponse: '已发送',
                items: [
                  {
                    id: 'tool-call-one',
                    type: 'mcp_tool_call',
                    server: 'wechat_kf',
                    tool: 'send_location',
                    arguments: {
                      name: '天安门',
                      address: '北京市东城区',
                      latitude: 39.9087,
                      longitude: 116.3975,
                    },
                    status: 'completed',
                    result: {
                      content: [],
                      structured_content: {
                        receipts: [
                          {
                            wecomMsgId: 'wecom-location',
                            sentType: 'location',
                            status: 'accepted',
                          },
                        ],
                        remainingSends: 4,
                      },
                    },
                  },
                ],
              };
            },
          };
        },
        resumeThread() {
          throw new Error('resumeThread should not be used');
        },
      };
    },
    store,
    config: testConfig(workingDirectory),
  });

  const reply = await responder.respond({
    message: customerMessage('把地址发给我'),
    mediaCatalog: [
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'secret-wecom-media-id',
        messageId: 'previous-image',
      },
    ],
  });

  assert.equal(factoryContext.mediaCatalog[0].mediaId, 'secret-wecom-media-id');
  assert.match(capturedPrompt, /\$wechat-kf-reply-sop/);
  assert.match(capturedPrompt, /media:0：图片/);
  assert.doesNotMatch(capturedPrompt, /secret-wecom-media-id/);
  assert.deepEqual(capturedRunOptions, {});
  assert.deepEqual(reply, {
    type: 'tool_dispatch',
    dispatches: [
      {
        tool: 'send_location',
        arguments: {
          name: '天安门',
          address: '北京市东城区',
          latitude: 39.9087,
          longitude: 116.3975,
        },
      },
    ],
    receipts: [
      {
        wecomMsgId: 'wecom-location',
        sentType: 'location',
        status: 'accepted',
      },
    ],
  });
});

test('structured link fields are rendered into the customer turn context', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-link-context-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  let capturedPrompt = '';
  const codex = {
    startThread() {
      return {
        id: 'link-context-thread',
        async run(prompt) {
          capturedPrompt = prompt;
          return { finalResponse: '已收到主页卡片。' };
        },
      };
    },
    resumeThread() {
      throw new Error('resumeThread should not be used');
    },
  };
  const responder = new CodexResponder({
    codex,
    store,
    config: testConfig(workingDirectory),
  });
  const message = createDomainMessage({
    id: 'link-context-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.LINK,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    attributes: {
      title: '@示例博主的个人主页',
      description: '粉丝1.3万，获赞与收藏20.2万',
      url: 'https://example.com/creator',
    },
  });

  await responder.respond({ message });

  assert.match(capturedPrompt, /@示例博主的个人主页/);
  assert.match(capturedPrompt, /粉丝1\.3万/);
  assert.match(capturedPrompt, /https:\/\/example\.com\/creator/);
});

test('Codex responder steers a follow-up into the active turn', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-steer-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  const startInputs = [];
  const steerInputs = [];
  let resolveRun;
  let closeCalls = 0;
  let factoryCalls = 0;
  let factoryContext;
  const runCompletion = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const thread = {
    id: 'steer-thread',
    async startRun(input) {
      startInputs.push(input);
      return { turnId: 'active-turn', completion: runCompletion };
    },
    async steer(input, options) {
      steerInputs.push({ input, options });
      return 'active-turn';
    },
    async close() {
      closeCalls += 1;
    },
  };
  const responder = new CodexResponder({
    codexFactory(context) {
      factoryCalls += 1;
      factoryContext = context;
      return {
        startThread() {
          return thread;
        },
        resumeThread() {
          throw new Error('resumeThread should not be used');
        },
      };
    },
    store,
    config: testConfig(workingDirectory),
  });
  const firstMessage = createDomainMessage({
    id: 'customer-first',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '先帮我解释这个问题',
  });
  const followUp = createDomainMessage({
    id: 'customer-follow-up',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '不对，请改为只说最终结论',
  });

  const first = await responder.submit({ message: firstMessage });
  const second = await responder.submit({
    message: followUp,
    mediaCatalog: [
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'follow-up-image',
        filename: 'follow-up.png',
      },
    ],
  });

  assert.equal(first.kind, 'started');
  assert.equal(second.kind, 'steered');
  assert.equal(second.primaryMessageId, 'customer-first');
  assert.equal(factoryCalls, 1);
  assert.ok(factoryContext.mediaCatalogFile.startsWith(workingDirectory));
  assert.deepEqual(
    JSON.parse(await fs.readFile(factoryContext.mediaCatalogFile, 'utf8')),
    [
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'follow-up-image',
        filename: 'follow-up.png',
      },
    ],
  );
  assert.equal(startInputs.length, 1);
  assert.equal(steerInputs.length, 1);
  assert.match(steerInputs[0].input, /调整/u);
  assert.match(steerInputs[0].input, /只说最终结论/u);
  assert.equal(
    steerInputs[0].options.clientUserMessageId,
    'customer-follow-up',
  );

  resolveRun({
    finalResponse: '',
    usage: null,
    lastSteerSequence: 10,
    items: [
      {
        id: 'send-before-steer',
        type: 'mcp_tool_call',
        server: 'wechat_kf',
        tool: 'send_text',
        arguments: { content: '转向前的详细介绍' },
        status: 'completed',
        startedSequence: 5,
        result: {
          structured_content: {
            deferred: true,
            receipts: [
              {
                wecomMsgId: 'staged-before',
                sentType: 'text',
                status: 'staged',
              },
            ],
          },
        },
      },
      {
        id: 'send-one',
        type: 'mcp_tool_call',
        server: 'wechat_kf',
        tool: 'send_text',
        arguments: { content: '最终结论' },
        status: 'completed',
        startedSequence: 11,
        result: {
          structured_content: {
            deferred: true,
            receipts: [
              {
                wecomMsgId: 'wechat-one',
                sentType: 'text',
                status: 'accepted',
              },
            ],
          },
        },
      },
    ],
  });

  const reply = await first.completion;
  assert.equal(reply.type, 'tool_dispatch');
  assert.equal(reply.dispatches.length, 1);
  assert.deepEqual(reply.dispatches[0].arguments, { content: '最终结论' });
  assert.equal(reply.deferred, true);
  assert.equal(await store.getThreadId('wk-one:wm-one'), 'steer-thread');
  assert.equal(closeCalls, 1);
  await assert.rejects(() => fs.access(factoryContext.mediaCatalogFile), {
    code: 'ENOENT',
  });
});

test('Codex responder prefers the last successful generated image over fallback text', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-generated-image-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const generatedDirectory = path.join(workingDirectory, 'generated_images');
  await fs.mkdir(generatedDirectory);
  const generatedPath = path.join(generatedDirectory, 'generated.png');
  const imageBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  await fs.writeFile(generatedPath, imageBytes);
  const store = new MemoryThreadStore();
  const thread = {
    id: 'generated-image-thread',
    async startRun() {
      return {
        turnId: 'generated-image-turn',
        completion: Promise.resolve({
          finalResponse: '',
          usage: null,
          items: [
            {
              id: 'generated-one',
              type: 'imageGeneration',
              status: 'completed',
              revisedPrompt: '换脸并自然融合',
              result: imageBytes.toString('base64'),
              failure: null,
              savedPath: generatedPath,
              startedSequence: 3,
              completedSequence: 4,
            },
            {
              id: 'fallback-text',
              type: 'mcp_tool_call',
              server: 'wechat_kf',
              tool: 'send_text',
              arguments: { content: '生成失败' },
              status: 'completed',
              startedSequence: 5,
              result: {
                structured_content: {
                  deferred: true,
                  receipts: [
                    {
                      wecomMsgId: 'staged-text',
                      sentType: 'text',
                      status: 'staged',
                    },
                  ],
                },
              },
            },
          ],
        }),
      };
    },
    async close() {},
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
    config: testConfig(workingDirectory),
  });
  const message = createDomainMessage({
    id: 'generate-image-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '请编辑这两张图片',
  });

  const submission = await responder.submit({ message });
  const reply = await submission.completion;

  assert.equal(reply.type, 'generated_image');
  assert.equal(reply.generationId, 'generated-one');
  assert.equal(reply.media.contentType, 'image/png');
  assert.deepEqual(reply.media.bytes, imageBytes);
  await assert.rejects(() => fs.access(generatedPath), { code: 'ENOENT' });
});

test('Codex responder forces one image-generation retry when the model skips it', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-image-retry-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const imageBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const store = new MemoryThreadStore();
  store.generatedDelivery = {
    delivered: true,
    revisedPrompt: 'previous successful edit',
    byteLength: imageBytes.length,
    updatedAt: Date.now(),
  };
  const startInputs = [];
  const results = [
    {
      finalResponse: '',
      usage: null,
      items: [
        {
          id: 'premature-fallback',
          type: 'mcp_tool_call',
          server: 'wechat_kf',
          tool: 'send_text',
          arguments: { content: '图片生成失败' },
          status: 'completed',
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
    },
    {
      finalResponse: '',
      usage: null,
      items: [
        {
          id: 'retried-generation',
          type: 'imageGeneration',
          status: 'completed',
          revisedPrompt: '换脸',
          result: imageBytes.toString('base64'),
          failure: null,
          startedSequence: 1,
          completedSequence: 2,
        },
      ],
    },
  ];
  const thread = {
    id: 'image-retry-thread',
    async startRun(input) {
      startInputs.push(input);
      return {
        turnId: `turn-${startInputs.length}`,
        completion: Promise.resolve(results.shift()),
      };
    },
    async close() {},
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
    config: testConfig(workingDirectory),
  });
  const message = createDomainMessage({
    id: 'image-retry-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '调整一下图片中人物的表情',
  });

  const submission = await responder.submit({ message });
  const reply = await submission.completion;

  assert.equal(startInputs.length, 2);
  assert.match(startInputs[1], /现在必须调用/u);
  assert.equal(reply.type, 'generated_image');
  assert.equal(reply.generationId, 'retried-generation');
});

test('Codex responder corrects a false failure claim after confirmed image delivery', async (t) => {
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-codex-delivery-context-'),
  );
  t.after(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const store = new MemoryThreadStore();
  store.generatedDelivery = {
    delivered: true,
    revisedPrompt: 'change only the requested visual attribute',
    byteLength: 1024,
    updatedAt: Date.now(),
  };
  const startInputs = [];
  const results = [
    {
      finalResponse: '',
      usage: null,
      items: [
        {
          id: 'false-failure',
          type: 'mcp_tool_call',
          server: 'wechat_kf',
          tool: 'send_text',
          arguments: { content: '刚才的图片编辑没有返回成品，合成失败。' },
          status: 'completed',
          result: {
            structured_content: {
              deferred: true,
              receipts: [
                {
                  wecomMsgId: 'staged-false-failure',
                  sentType: 'text',
                  status: 'staged',
                },
              ],
            },
          },
        },
      ],
    },
    {
      finalResponse: '',
      usage: null,
      items: [
        {
          id: 'corrected-feedback',
          type: 'mcp_tool_call',
          server: 'wechat_kf',
          tool: 'send_text',
          arguments: {
            content:
              '上一张图已经送达，你指出的是编辑结果与预期不符。',
          },
          status: 'completed',
          result: {
            structured_content: {
              deferred: true,
              receipts: [
                {
                  wecomMsgId: 'staged-correction',
                  sentType: 'text',
                  status: 'staged',
                },
              ],
            },
          },
        },
      ],
    },
  ];
  const thread = {
    id: 'delivery-context-thread',
    async startRun(input) {
      startInputs.push(input);
      return {
        turnId: `delivery-turn-${startInputs.length}`,
        completion: Promise.resolve(results.shift()),
      };
    },
    async close() {},
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
    config: testConfig(workingDirectory),
  });
  const message = createDomainMessage({
    id: 'quality-feedback-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text: '怎么整个人物都变了？',
  });

  const submission = await responder.submit({ message });
  const reply = await submission.completion;

  assert.equal(startInputs.length, 2);
  assert.match(startInputs[0], /最近一张 Codex 生成\/编辑图已经成功/u);
  assert.match(startInputs[1], /渠道状态已确认/u);
  assert.equal(reply.type, 'tool_dispatch');
  assert.match(reply.dispatches[0].arguments.content, /已经送达/u);
  assert.doesNotMatch(reply.dispatches[0].arguments.content, /生成失败|合成失败/u);
});
