import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { CodexAgent } from '../../src/services/codex-agent.ts';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
} from '../../src/services/codex-app-server.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class ImageBoundary implements CodexBoundary {
  readonly first = deferred<CodexTurnResult>();
  readonly prompts: CodexInput[] = [];
  readonly thread: CodexThread;
  starts = 0;
  steers = 0;
  startThreadCalls = 0;
  resumeThreadCalls = 0;
  executeArtifact?: (
    session: string,
    mediaRef: string,
  ) => Promise<{ readonly attemptId: string; readonly msgid: string }>;

  constructor(png: Buffer) {
    this.thread = {
      id: 'thread-generated-image',
      startRun: async (input): Promise<CodexRun> => {
        this.prompts.push(input);
        this.starts += 1;
        if (this.starts === 1) {
          return { turnId: 'turn-image', completion: this.first.promise };
        }
        if (this.starts === 3) {
          return {
            turnId: 'turn-feedback',
            completion: Promise.resolve({
              items: [{
                id: 'generation-two', type: 'imageGeneration', status: 'completed',
                result: png.toString('base64'),
                revisedPrompt: 'adjust only the requested background detail',
                startedSequence: 1, completedSequence: 2,
              }],
            }),
          };
        }
        const prompt = String(input);
        const session = prompt.match(/session (ws_[A-Za-z0-9_-]{32})/u)?.[1];
        const mediaRef = prompt.match(/(artifact:\d+)/u)?.[1];
        if (!session || !mediaRef || !this.executeArtifact) {
          throw new Error('Missing generated-image MCP execution fixture');
        }
        const receipt = await this.executeArtifact(session, mediaRef);
        return {
          turnId: `turn-send-${this.starts}`,
          completion: Promise.resolve({
            items: [{
              id: `send-${this.starts}`,
              type: 'mcpToolCall',
              server: 'wechat_kf',
              tool: 'send_image',
              status: 'completed',
              startedSequence: 3,
              result: { structuredContent: receipt },
            }],
          }),
        };
      },
      steer: async (input): Promise<string> => {
        this.prompts.push(input);
        this.steers += 1;
        return 'turn-image';
      },
    };
  }

  startThread(_options: CodexThreadOptions): CodexThread {
    this.startThreadCalls += 1;
    return this.thread;
  }
  resumeThread(_threadId: string, _options: CodexThreadOptions): CodexThread {
    this.resumeThreadCalls += 1;
    return this.thread;
  }
  async readThread(): Promise<unknown> { return { thread: { turns: [] } }; }
  async close(): Promise<void> {}
}

test('generated image flows through the channel runtime and a same-thread delta sends the final image', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generated-image-flow-'));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const generatedDirectory = path.join(directory, 'generated');
  await fs.mkdir(generatedDirectory);
  const savedPath = path.join(generatedDirectory, 'result.png');
  const png = Buffer.from('89504e470d0a1a0a04040404', 'hex');
  await fs.writeFile(savedPath, png);

  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  const boundary = new ImageBoundary(png);
  const agent = new CodexAgent({
    codex: boundary,
    config: {
      workingDirectory: directory, imageTempDirectory: directory,
      generatedImageDirectory: generatedDirectory,
    },
  });
  const uploads: Buffer[] = [];
  const mediaGateway = {
    async resolveForCodex(message: { readonly type: string }) {
      return message.type === 'image'
        ? [{ kind: 'image' as const, bytes: png, contentType: 'image/png' }]
        : [];
    },
    async upload(input: { readonly bytes: Buffer }) {
      uploads.push(input.bytes);
      return { media_id: 'generated-media-id' };
    },
    async cloneForSend(): Promise<string> { return 'unused-clone'; },
    async getCardThumbnailMediaId(): Promise<string> { return 'unused-thumb'; },
  };
  const sent: Array<{
    readonly payload: Readonly<Record<string, unknown>>;
    readonly messageId?: string;
  }> = [];
  const channel = new WechatKfToolExecutor({
    store,
    logger: { info() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input) {
        sent.push(input);
        return { msgid: `wecom-${sent.length}` };
      },
    },
    mediaGateway,
    observeMs: 0,
  });
  boundary.executeArtifact = async (session, mediaRef) =>
    channel.execute('send_image', { session, mediaRef });
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway,
    channel,
    allowedUserIds: ['wm-image'],
    logger: { info() {}, error() {} },
  });
  let cursor = '';
  function ingest(raw: Record<string, unknown>): string {
    const next = `${cursor}-${String(raw.msgid)}`;
    const page = store.ingestSyncPage({
      openKfId: 'wk-image', expectedCursor: cursor, nextCursor: next,
      messages: [normalizeWecomMessage(raw, 'wk-image', { cursor, index: 0 })],
    });
    cursor = next;
    const key = page.insertedMessageKeys[0];
    if (!key) throw new Error('Expected generated-flow message');
    return key;
  }

  t.onTestFinished(async () => {
    await processor.close();
    await channel.close();
    persistence.close();
  });

  const primaryKey = ingest({
    msgid: 'edit-request', open_kfid: 'wk-image', external_userid: 'wm-image',
    origin: 3, msgtype: 'text',
    text: { content: '请编辑这张图片，只改变背景颜色。' },
  });
  const imageKey = ingest({
    msgid: 'reference-image', open_kfid: 'wk-image', external_userid: 'wm-image',
    origin: 3, msgtype: 'image', image: { media_id: 'inbound-image-id' },
  });
  await processor.enqueue(primaryKey);
  await processor.enqueue(imageKey);
  assert.equal(boundary.steers, 1);
  boundary.first.resolve({
    lastSteerSequence: 10,
    items: [{
      id: 'generation-one', type: 'imageGeneration', status: 'completed',
      result: png.toString('base64'), revisedPrompt: 'change only background color',
      startedSequence: 11, completedSequence: 12, savedPath,
    }],
  });
  await processor.waitForIdle();
  await channel.waitForIdle();

  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], png);
  assert.deepEqual(sent[0]?.payload, {
    msgtype: 'image', image: { media_id: 'generated-media-id' },
  });
  assert.match(sent[0]?.messageId || '', /^wb_[a-f0-9]{29}$/u);
  const imageAttempt = store.listRecentConversationAttempts({
    openKfId: 'wk-image',
    externalUserId: 'wm-image',
  }).find((attempt) => attempt.messageKey === primaryKey);
  assert.equal(imageAttempt?.status, 'accepted');
  assert.equal(imageAttempt?.source, 'mcp_tool');
  assert.equal(imageAttempt?.metadata?.revisedPrompt, 'change only background color');
  assert.equal(store.getInbound(primaryKey)?.status, 'completed');
  assert.equal(store.getInbound(imageKey)?.status, 'absorbed');
  await assert.rejects(fs.access(savedPath), { code: 'ENOENT' });

  const feedbackKey = ingest({
    msgid: 'quality-feedback', open_kfid: 'wk-image', external_userid: 'wm-image',
    origin: 3, msgtype: 'text', text: { content: '上一张图的背景还需要调整。' },
  });
  await processor.enqueue(feedbackKey);
  await processor.waitForIdle();
  await channel.waitForIdle();

  const feedbackPrompt = String(boundary.prompts.at(-2));
  assert.match(feedbackPrompt, /channel API accepted/u);
  assert.match(feedbackPrompt, /participant explicitly commented/u);
  assert.match(feedbackPrompt, /change only background color/u);
  assert.doesNotMatch(feedbackPrompt, /生成失败|没有成品/u);
  assert.deepEqual(sent[1]?.payload, {
    msgtype: 'image', image: { media_id: 'generated-media-id' },
  });
  assert.doesNotMatch(JSON.stringify(sent[1]?.payload), /生成失败|没有成品/u);
  assert.equal(boundary.startThreadCalls, 1);
  assert.equal(boundary.resumeThreadCalls, 1);
  assert.equal(boundary.starts, 4);
  assert.equal(uploads.length, 2);
});
