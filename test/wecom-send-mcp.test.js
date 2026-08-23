import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createWecomSendMcpServer,
  createWecomSendToolsFromEnvironment,
} from '../src/mcp/wecom-send-server.js';

test('MCP exposes only bound-content send tools and delegates calls', async (t) => {
  const calls = [];
  const tools = {
    async sendText(input) {
      calls.push({ method: 'sendText', input });
      return {
        receipts: [
          { wecomMsgId: 'text-one', sentType: 'text', status: 'accepted' },
        ],
        remainingSends: 4,
      };
    },
    async sendLocation(input) {
      calls.push({ method: 'sendLocation', input });
      return {
        receipts: [
          {
            wecomMsgId: 'location-one',
            sentType: 'location',
            status: 'accepted',
          },
        ],
        remainingSends: 3,
      };
    },
    async sendLink() {},
    async sendMiniProgram() {},
    async sendImage(input) {
      calls.push({ method: 'sendImage', input });
      return { receipts: [], remainingSends: 2 };
    },
  };
  const server = createWecomSendMcpServer({ tools });
  const client = new Client({ name: 'wechat-kf-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'send_image',
    'send_link',
    'send_location',
    'send_miniprogram',
    'send_text',
  ]);
  for (const tool of listed.tools) {
    const properties = tool.inputSchema.properties || {};
    assert.equal('toUser' in properties, false);
    assert.equal('externalUserId' in properties, false);
    assert.equal('openKfId' in properties, false);
  }

  const result = await client.callTool({
    name: 'send_location',
    arguments: {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.receipts[0].sentType, 'location');
  assert.deepEqual(calls, [
    {
      method: 'sendLocation',
      input: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    },
  ]);
});

test('MCP reports tool failures without turning them into successful content', async (t) => {
  const server = createWecomSendMcpServer({
    tools: {
      async sendText() {
        const error = new Error('mock send rejected');
        error.code = 'mock_rejected';
        throw error;
      },
      async sendLocation() {},
      async sendLink() {},
      async sendMiniProgram() {},
      async sendImage() {},
    },
  });
  const client = new Client({ name: 'wechat-kf-error-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => client.close());

  const result = await client.callTool({
    name: 'send_text',
    arguments: { content: '测试' },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: 'mock_rejected',
    message: 'mock send rejected',
  });
});

test('environment assembly binds the target outside model-controlled arguments', async (t) => {
  const calls = [];
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-tool-env-test-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tools = createWecomSendToolsFromEnvironment(
    {
      WECOM_TOOL_CORP_ID: 'ww-env',
      WECOM_TOOL_KF_SECRET: 'env-secret',
      WECOM_TOOL_OPEN_KFID: 'wk-env-bound',
      WECOM_TOOL_EXTERNAL_USER_ID: 'wm-env-bound',
      WECOM_TOOL_MEDIA_CATALOG: '[]',
      WECOM_TOOL_MAX_SENDS: '5',
      WECOM_TOOL_API_BASE_URL: 'https://wecom.invalid',
      WECOM_TOOL_TURN_ID: 'turn-env-test',
      WECOM_TOOL_JOURNAL_FILE: path.join(directory, 'journal.sqlite'),
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        const body = String(url).includes('/gettoken?')
          ? { access_token: 'mock-access', expires_in: 7200 }
          : { errcode: 0, errmsg: 'ok', msgid: 'env-message' };
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  );

  await tools.sendText({ content: '环境绑定测试' });
  tools.close();

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/wecom\.invalid\/cgi-bin\/gettoken\?/);
  const sentBody = JSON.parse(calls[1].options.body);
  assert.deepEqual({ ...sentBody, msgid: undefined }, {
    touser: 'wm-env-bound',
    open_kfid: 'wk-env-bound',
    msgtype: 'text',
    text: { content: '环境绑定测试' },
    msgid: undefined,
  });
  assert.match(sentBody.msgid, /^wb_[0-9a-f]{29}$/);
});

test('environment-backed tools reload a steered media catalog file', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-tool-media-context-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const catalogFile = path.join(directory, 'media-catalog.json');
  await fs.writeFile(catalogFile, '[]', { mode: 0o600 });
  const tools = createWecomSendToolsFromEnvironment({
    WECOM_TOOL_CORP_ID: 'ww-env',
    WECOM_TOOL_KF_SECRET: 'env-secret',
    WECOM_TOOL_OPEN_KFID: 'wk-env-bound',
    WECOM_TOOL_EXTERNAL_USER_ID: 'wm-env-bound',
    WECOM_TOOL_MEDIA_CATALOG: '[]',
    WECOM_TOOL_MEDIA_CATALOG_FILE: catalogFile,
    WECOM_TOOL_MAX_SENDS: '5',
    WECOM_TOOL_TURN_ID: 'turn-env-media',
    WECOM_TOOL_JOURNAL_FILE: path.join(directory, 'journal.sqlite'),
  });

  await fs.writeFile(
    catalogFile,
    JSON.stringify([
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'follow-up-image',
        filename: 'follow-up.png',
      },
    ]),
  );

  assert.deepEqual(await tools.mediaCatalogProvider(), [
    {
      ref: 'media:0',
      kind: 'image',
      mediaId: 'follow-up-image',
      filename: 'follow-up.png',
    },
  ]);
  tools.close();
});
