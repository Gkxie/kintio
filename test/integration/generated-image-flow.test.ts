import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.js';
import { CodexAgent } from '../../src/services/codex-agent.js';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
} from '../../src/services/codex-app-server.js';
import { ConversationProcessor } from '../../src/services/conversation-processor.js';
import { DeliveryService } from '../../src/services/delivery-service.js';
import { OutboundPreparer } from '../../src/services/outbound-preparer.js';
import { SqliteStore } from '../../src/state/sqlite-store.js';

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

  constructor(png: Buffer) {
    this.thread = {
      id: 'thread-generated-image',
      startRun: async (input): Promise<CodexRun> => {
        this.prompts.push(input);
        this.starts += 1;
        return this.starts === 1
          ? { turnId: 'turn-image', completion: this.first.promise }
          : {
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

test('[I01][I04][I05][I07] generated image flows through spool and a same-thread delta sends the final image', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generated-image-flow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const generatedDirectory = path.join(directory, 'generated');
  const spoolDirectory = path.join(directory, 'spool');
  await fs.mkdir(generatedDirectory);
  const savedPath = path.join(generatedDirectory, 'result.png');
  const png = Buffer.from('89504e470d0a1a0a04040404', 'hex');
  await fs.writeFile(savedPath, png);

  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  const boundary = new ImageBoundary(png);
  const agent = new CodexAgent({
    codex: boundary,
    store,
    config: {
      model: 'gpt-image-test', reasoningEffort: 'none', sandboxMode: 'read-only',
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
  const preparer = new OutboundPreparer({ mediaGateway, spoolDirectory });
  const sent: Array<{
    readonly payload: Readonly<Record<string, unknown>>;
    readonly messageId?: string;
  }> = [];
  const delivery = new DeliveryService({
    store,
    logger: { info() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input) {
        sent.push(input);
        return { msgid: `wecom-${sent.length}` };
      },
    },
  });
  const processor = new ConversationProcessor({
    store,
    codexAgent: agent,
    mediaGateway,
    outboundPreparer: preparer,
    delivery,
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

  t.after(async () => {
    await processor.close();
    await delivery.close();
    store.close();
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
  await delivery.waitForIdle();

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
  assert.equal(imageAttempt?.source, 'codex_image');
  assert.equal(imageAttempt?.metadata?.revisedPrompt, 'change only background color');
  assert.equal(store.getInbound(primaryKey)?.status, 'completed');
  assert.equal(store.getInbound(imageKey)?.status, 'absorbed');
  await assert.rejects(fs.access(savedPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(spoolDirectory), []);

  const feedbackKey = ingest({
    msgid: 'quality-feedback', open_kfid: 'wk-image', external_userid: 'wm-image',
    origin: 3, msgtype: 'text', text: { content: '上一张图的背景还需要调整。' },
  });
  await processor.enqueue(feedbackKey);
  await processor.waitForIdle();
  await delivery.waitForIdle();

  const feedbackPrompt = String(boundary.prompts.at(-1));
  assert.match(feedbackPrompt, /已被微信 API 接受/u);
  assert.match(feedbackPrompt, /客户已明确评价/u);
  assert.match(feedbackPrompt, /change only background color/u);
  assert.doesNotMatch(feedbackPrompt, /生成失败|没有成品/u);
  assert.deepEqual(sent[1]?.payload, {
    msgtype: 'image', image: { media_id: 'generated-media-id' },
  });
  assert.doesNotMatch(JSON.stringify(sent[1]?.payload), /生成失败|没有成品/u);
  assert.equal(boundary.startThreadCalls, 1);
  assert.equal(boundary.resumeThreadCalls, 1);
  assert.equal(boundary.starts, 2);
  assert.equal(uploads.length, 2);
});
