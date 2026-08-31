import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import {
  normalizeSendIntent,
} from '../../src/domain/send-contract.ts';
import {
  normalizeWecomMessage,
  renderMessageForCodex,
} from '../../src/domain/wecom-message.ts';
import type { AgentInput } from '../../src/agent/runtime.ts';
import { CodexAgent } from '../../src/services/codex-agent.ts';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
} from '../../src/services/codex-app-server.ts';
import { withStagedImages } from '../../src/services/image-stager.ts';
import { WecomMediaGateway } from '../../src/services/media-gateway.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';

const base = {
  open_kfid: 'wk-acceptance',
  external_userid: 'wm-acceptance',
  origin: 3,
  send_time: 1,
};

async function tempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('link title, description, and URL enter the Codex summary', () => {
  const message = normalizeWecomMessage({
    ...base,
    msgid: 'link-one',
    msgtype: 'link',
    link: {
      title: '@示例博主主页',
      desc: '主要分享 AI 编程与开源项目',
      url: 'https://example.com/creator',
    },
  });
  const summary = renderMessageForCodex(message);
  assert.match(summary, /@示例博主主页/u);
  assert.match(summary, /AI 编程与开源项目/u);
  assert.match(summary, /https:\/\/example\.com\/creator/u);
});

test('voice, video, and file remain explicit unresolved summaries with zero downloads', async () => {
  let downloads = 0;
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia() {
        downloads += 1;
        return { bytes: Buffer.from('unused'), contentType: 'application/octet-stream' };
      },
      async uploadMedia() { return { media_id: 'unused' }; },
    },
  });
  const fixtures = [
    ['voice', { voice: { media_id: 'voice-secret' } }, /not downloaded or transcribed/u],
    ['video', { video: { media_id: 'video-secret' } }, /not downloaded, watched, or transcribed/u],
    [
      'file',
      { file: { media_id: 'file-secret', filename: '合同.pdf' } },
      /content not downloaded or opened/u,
    ],
  ] as const;
  for (const [msgtype, payload, expected] of fixtures) {
    const message = normalizeWecomMessage({
      ...base,
      msgid: `${msgtype}-one`,
      msgtype,
      ...payload,
    });
    assert.match(renderMessageForCodex(message), expected);
    assert.deepEqual(await gateway.resolveForCodex(message), []);
  }
  assert.equal(downloads, 0);
});

test('multiple images stage in input order and clean on success and failure', async (t) => {
  const directory = await tempDirectory(t, 'ordered-images-');
  const png = Buffer.from('89504e470d0a1a0a01010101', 'hex');
  const jpeg = Buffer.from('ffd8ff020202', 'hex');
  let successfulPaths: readonly string[] = [];
  await withStagedImages(
    [
      { bytes: png },
      { bytes: jpeg },
    ],
    { temporaryRoot: directory },
    async (paths) => {
      successfulPaths = [...paths];
      assert.deepEqual(await fs.readFile(paths[0]!), png);
      assert.deepEqual(await fs.readFile(paths[1]!), jpeg);
      assert.match(paths[0]!, /image-0\.png$/u);
      assert.match(paths[1]!, /image-1\.jpg$/u);
    },
  );
  for (const filePath of successfulPaths) {
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  }

  let failedPaths: readonly string[] = [];
  await assert.rejects(
    withStagedImages(
      [{ bytes: png }],
      { temporaryRoot: directory },
      async (paths) => {
        failedPaths = [...paths];
        throw new Error('operation failed');
      },
    ),
    /operation failed/u,
  );
  for (const filePath of failedPaths) {
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  }
});

function stagedText(content: string) {
  return {
    id: `tool-${content}`,
    type: 'mcpToolCall',
    server: 'wechat_kf',
    tool: 'send_text',
    status: 'completed',
    startedSequence: 1,
    result: {
      structuredContent: {
        status: 'accepted',
        attemptId: `sa_${content}`,
        sendIndex: 0,
        type: 'text',
        msgid: `wx-${content}`,
      },
    },
  };
}

class PromptBoundary implements CodexBoundary {
  readonly prompts: CodexInput[] = [];
  readonly thread: CodexThread = {
    id: 'thread-channel-prompt',
    startRun: async (input): Promise<CodexRun> => {
      this.prompts.push(input);
      return {
        turnId: `turn-${this.prompts.length}`,
        completion: Promise.resolve({ items: [stagedText('ack')] }),
      };
    },
    steer: async () => { throw new Error('no active steer expected'); },
  };
  startThread(_options: CodexThreadOptions): CodexThread { return this.thread; }
  resumeThread(_threadId: string, _options: CodexThreadOptions): CodexThread {
    return this.thread;
  }
  async readThread(): Promise<unknown> { return { thread: { turns: [] } }; }
  async close(): Promise<void> {}
}

test('API acceptance and customer observation remain distinct image facts', async (t) => {
  const directory = await tempDirectory(t, 'channel-prompt-');
  const boundary = new PromptBoundary();
  const agent = new CodexAgent({
    codex: boundary,
    config: {
      workingDirectory: directory, imageTempDirectory: directory,
      generatedImageDirectory: path.join(directory, 'generated'),
    },
  });
  t.onTestFinished(() => agent.close());
  const states: NonNullable<AgentInput['channelState']>[] = [
    { accepted: true },
    { accepted: true, customerObserved: true },
  ];
  for (const [index, channelState] of states.entries()) {
    const msgid = `channel-${index}`;
    const submission = await agent.submit({
      mode: 'start',
      conversationId: 'cv-channel',
      threadId: '',
      message: {
        messageKey: msgid, text: msgid, summary: msgid,
      },
      contextText: msgid,
      channelState,
      toolSessionToken: `ws_${String(index).repeat(32)}`,
    });
    assert.equal(submission.kind, 'started');
    if (submission.kind === 'started') await submission.completion;
  }
  assert.match(String(boundary.prompts[0]), /channel API accepted/u);
  assert.match(String(boundary.prompts[0]), /does not prove client display/u);
  assert.doesNotMatch(String(boundary.prompts[0]), /participant explicitly commented/u);
  assert.match(String(boundary.prompts[1]), /participant explicitly commented/u);
});

test('map URL remains a link, never a location, and private URLs are rejected', () => {
  const link = normalizeSendIntent('send_link', {
    title: '地图',
    description: '导航链接',
    url: 'https://maps.example.com/place/one',
  });
  assert.equal(link.type, 'link');
  assert.throws(
    () => normalizeSendIntent('send_link', {
      title: '内网地图', description: '', url: 'http://127.0.0.1/map',
    }),
    /public HTTP/u,
  );
});

test('unverifiable mini-program fields reject while text fallback remains valid', () => {
  assert.throws(
    () => normalizeSendIntent('send_miniprogram', {
      appId: '', title: '猜测入口', pagePath: '', sourceUrl: 'https://example.com',
    }),
    /appId|pagePath/u,
  );
  assert.deepEqual(normalizeSendIntent('send_text', {
    content: '暂时找不到可核验的小程序入口。',
  }), {
    type: 'text',
    content: '暂时找不到可核验的小程序入口。',
  });
});

test("SQLite state remains private without a host image spool", async (t) => {
  const directory = await tempDirectory(t, "private-state-");
  const databaseFile = path.join(directory, "private", "wecom.sqlite");
  const store = new SqliteStore({ filePath: databaseFile });
  t.onTestFinished(() => store.close());
  if (process.platform === 'win32') {
    assert.equal((await fs.stat(databaseFile)).isFile(), true);
  } else {
    assert.equal((await fs.stat(path.dirname(databaseFile))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(databaseFile)).mode & 0o777, 0o600);
  }
});
