import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  CodexAgent,
  stagedCandidates,
} from '../../src/services/codex-agent.js';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
} from '../../src/services/codex-app-server.js';
import type {
  ConversationRecord,
  InboundRecord,
} from '../../src/state/sqlite-store.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stagedText(
  id: string,
  content: string,
  startedSequence: number,
  status = 'completed',
) {
  return {
    id,
    type: 'mcpToolCall',
    server: 'wechat_kf',
    tool: 'send_text',
    status,
    startedSequence,
    result: {
      structuredContent: {
        staged: true,
        candidate: { type: 'text', content },
      },
    },
  };
}

function message(messageKey = 'im-primary') {
  return {
    id: messageKey,
    messageKey,
    origin: 'customer',
    type: 'text',
    rawType: 'text',
    sentAt: 1,
    sync: { cursor: '', index: 0 },
    conversation: { openKfId: 'wk-test', externalUserId: 'wm-test' },
    actor: { servicerUserId: '' },
    text: '测试',
    summary: '测试',
    attributes: {},
    attachments: [],
  } as const;
}

class FakeStore {
  readonly persistedThreads: unknown[] = [];
  readonly steering = new Set<string>();

  getConversation(): undefined {
    return undefined;
  }

  setConversationThread(value: {
    readonly openKfId: string;
    readonly externalUserId: string;
    readonly threadId: string;
  }): ConversationRecord {
    this.persistedThreads.push(value);
    return {
      ...value,
      mode: 'bot', automationEpoch: 0, servicerUserId: '', source: '',
      changeType: 0, updatedAt: 0,
    };
  }

  claimInbound({ messageKey }: { readonly messageKey: string }) {
    return {
      message: {
        ...this.#inbound(messageKey, 'processing'),
      },
      heldContext: [],
    };
  }

  beginInboundSteering({ messageKey }: { readonly messageKey: string }): InboundRecord {
    this.steering.add(messageKey);
    return this.#inbound(messageKey, 'steering');
  }

  confirmInboundSteered(messageKey: string): InboundRecord {
    this.steering.delete(messageKey);
    return this.#inbound(messageKey, 'steered');
  }

  requeueInboundSteering(messageKey: string): InboundRecord {
    this.steering.delete(messageKey);
    return this.#inbound(messageKey, 'received');
  }

  #inbound(messageKey: string, status: InboundRecord['status']): InboundRecord {
    return {
      inboxSeq: 1, messageKey, openKfId: 'wk-test', msgid: messageKey,
      externalUserId: 'wm-test', origin: 'customer', type: 'text', sentAt: 1,
      status, primaryMessageKey: '', contextStatus: 'none', codexTurnId: '',
      clientInputId: messageKey, claimedConversationEpoch: 0,
      claimedRuntimeEpoch: 0, errorMessage: '', createdAt: 0, updatedAt: 0,
    };
  }
}

class FakeBoundary implements CodexBoundary {
  readonly startOptions: CodexThreadOptions[] = [];
  readonly runCalls: { input: CodexInput; options?: { clientUserMessageId?: string } }[] = [];
  readonly steerCalls: CodexInput[] = [];
  readonly results: CodexTurnResult[];
  readonly thread: CodexThread;
  history: unknown = { thread: { turns: [] } };
  closed = false;

  constructor(results: CodexTurnResult[]) {
    this.results = [...results];
    this.thread = {
      id: 'thread-test',
      startRun: async (input, options): Promise<CodexRun> => {
        this.runCalls.push({ input, ...(options ? { options: { ...options } } : {}) });
        const result = this.results.shift();
        if (!result) throw new Error('Missing fake Codex result');
        return {
          turnId: `turn-${this.runCalls.length}`,
          completion: Promise.resolve(result),
        };
      },
      steer: async (input): Promise<string> => {
        this.steerCalls.push(input);
        return 'turn-1';
      },
    };
  }

  startThread(options: CodexThreadOptions): CodexThread {
    this.startOptions.push(options);
    return this.thread;
  }

  resumeThread(): CodexThread {
    return this.thread;
  }

  async readThread(): Promise<unknown> {
    return this.history;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createAgent(
  t: TestContext,
  boundary: CodexBoundary,
  store = new FakeStore(),
  config: Partial<{
    imageTempDirectory: string;
    generatedImageDirectory: string;
  }> = {},
) {
  const agent = new CodexAgent({
    codex: boundary,
    store,
    config: {
      model: 'gpt-project',
      reasoningEffort: 'low',
      sandboxMode: 'read-only',
      workingDirectory: '/isolated-codex-workspace',
      imageTempDirectory: config.imageTempDirectory || '/dev/shm',
      generatedImageDirectory: config.generatedImageDirectory || '',
    },
  });
  t.after(() => agent.close());
  return { agent, store };
}

test('[DEP02] passes project model/effort and treats customer observation independently of accepted', async (t) => {
  const boundary = new FakeBoundary([
    { items: [stagedText('answer', '项目配置生效', 1)] },
  ]);
  const { agent, store } = createAgent(t, boundary);
  const submission = await agent.submit({
    message: message(),
    contextText: '测试项目模型配置',
    channelState: { accepted: false, customerObserved: true },
  });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;

  assert.deepEqual(boundary.startOptions, [{
    sandboxMode: 'read-only',
    workingDirectory: '/isolated-codex-workspace',
    approvalPolicy: 'never',
    developerInstructions: boundary.startOptions[0]?.developerInstructions,
    model: 'gpt-project',
    modelReasoningEffort: 'low',
  }]);
  assert.match(
    boundary.startOptions[0]?.developerInstructions || '',
    /Never read.*local files.*Never access localhost/su,
  );
  assert.equal(completed.candidates[0]?.type, 'text');
  assert.match(String(boundary.runCalls[0]?.input), /客户已明确评价/u);
  assert.deepEqual(store.persistedThreads.at(-1), {
    openKfId: 'wk-test',
    externalUserId: 'wm-test',
    threadId: 'thread-test',
  });
});

test('[R04] a live turn rejection stays observed when thread persistence fails', async (t) => {
  const turn = deferred<CodexTurnResult>();
  const thread: CodexThread = {
    id: 'thread-persistence-failure',
    async startRun(): Promise<CodexRun> {
      return { turnId: 'turn-persistence-failure', completion: turn.promise };
    },
    async steer(): Promise<string> { return 'turn-persistence-failure'; },
  };
  const boundary: CodexBoundary = {
    startThread() { return thread; },
    resumeThread() { return thread; },
    async readThread() { return {}; },
    async close() {},
  };
  class FailingThreadStore extends FakeStore {
    override setConversationThread(): ConversationRecord {
      throw new Error('thread persistence failed');
    }
  }
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const { agent } = createAgent(t, boundary, new FailingThreadStore());
  await assert.rejects(
    agent.submit({ message: message('persist-failure'), contextText: '测试' }),
    /thread persistence failed/u,
  );
  turn.reject(new Error('turn later rejected'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unhandled, 0);
});

test('[S04] keeps only completed staging candidates after the last steering boundary', () => {
  assert.deepEqual(stagedCandidates({
    lastSteerSequence: 10,
    items: [
      stagedText('before', '旧方向', 4),
      stagedText('at-boundary', '边界草稿', 10),
      stagedText('after-one', '最终第一条', 11),
      stagedText('failed', '失败工具', 12, 'failed'),
      stagedText('after-two', '最终第二条', 13),
      { ...stagedText('other', '其他服务', 14), server: 'other' },
    ],
  }), [
    { type: 'text', content: '最终第一条' },
    { type: 'text', content: '最终第二条' },
  ]);
});

test('[I02][I04] selects the last valid generated image and removes every trusted generated path', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-generated-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = ['pre.png', 'failed.png', 'invalid.png', 'selected.png'].map((name) =>
    path.join(directory, name),
  );
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, 'temporary')));
  const png = Buffer.from('89504e470d0a1a0a02020202', 'hex');
  const boundary = new FakeBoundary([{
    lastSteerSequence: 10,
    items: [
      {
        id: 'pre', type: 'imageGeneration', status: 'completed',
        result: png.toString('base64'), startedSequence: 5, savedPath: paths[0],
      },
      {
        id: 'failed', type: 'imageGeneration', status: 'failed', failure: 'x',
        result: '', startedSequence: 11, savedPath: paths[1],
      },
      {
        id: 'invalid', type: 'imageGeneration', status: 'completed',
        result: Buffer.from('invalid').toString('base64'),
        startedSequence: 12, completedSequence: 13, savedPath: paths[2],
      },
      {
        id: 'oversized', type: 'imageGeneration', status: 'completed',
        result: Buffer.concat([
          Buffer.from('89504e470d0a1a0a', 'hex'),
          Buffer.alloc(2 * 1024 * 1024),
        ]).toString('base64'),
        startedSequence: 13, completedSequence: 14,
      },
      {
        id: 'selected', type: 'imageGeneration', status: 'completed',
        result: png.toString('base64'), revisedPrompt: 'latest',
        startedSequence: 14, completedSequence: 15, savedPath: paths[3],
      },
    ],
  }]);
  const { agent } = createAgent(t, boundary, new FakeStore(), {
    generatedImageDirectory: directory,
  });
  const submission = await agent.submit({ message: message('im-image'), contextText: '编辑图片' });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;
  assert.equal(completed.candidates[0]?.type, 'generated_image');
  await Promise.all(paths.map((filePath) =>
    assert.rejects(fs.access(filePath), { code: 'ENOENT' }),
  ));
});

test('[I04][SEC04] generated cleanup rejects symlinked roots and escape components', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-generated-link-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside');
  const trusted = path.join(directory, 'trusted');
  await fs.mkdir(outside);
  await fs.mkdir(trusted);
  const png = Buffer.from('89504e470d0a1a0a02020202', 'hex');

  const escapedFile = path.join(outside, 'escaped.png');
  await fs.writeFile(escapedFile, png);
  await fs.symlink(outside, path.join(trusted, 'escape'));
  const escapedBoundary = new FakeBoundary([{
    items: [{
      id: 'escaped', type: 'imageGeneration', status: 'completed',
      result: png.toString('base64'), savedPath: path.join(trusted, 'escape/escaped.png'),
    }],
  }]);
  const escapedAgent = createAgent(t, escapedBoundary, new FakeStore(), {
    generatedImageDirectory: trusted,
  }).agent;
  const escaped = await escapedAgent.submit({
    message: message('escaped-generated'), contextText: '生成图',
  });
  assert.equal(escaped.kind, 'started');
  if (escaped.kind === 'started') await escaped.completion;
  await fs.access(escapedFile);

  const linkedRoot = path.join(directory, 'linked-root');
  const linkedFile = path.join(outside, 'linked-root.png');
  await fs.writeFile(linkedFile, png);
  await fs.symlink(outside, linkedRoot);
  const linkedBoundary = new FakeBoundary([{
    items: [{
      id: 'linked-root', type: 'imageGeneration', status: 'completed',
      result: png.toString('base64'), savedPath: path.join(linkedRoot, 'linked-root.png'),
    }],
  }]);
  const linkedAgent = createAgent(t, linkedBoundary, new FakeStore(), {
    generatedImageDirectory: linkedRoot,
  }).agent;
  const linked = await linkedAgent.submit({
    message: message('linked-generated'), contextText: '生成图',
  });
  assert.equal(linked.kind, 'started');
  if (linked.kind === 'started') await linked.completion;
  await fs.access(linkedFile);
});

test('[I01][I03] explicit image edit discards premature failure text and forces exactly one generation retry', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a03030303', 'hex');
  const boundary = new FakeBoundary([
    { items: [stagedText('premature-text', '图片处理失败', 1)] },
    {
      items: [{
        id: 'retried-image',
        type: 'imageGeneration',
        status: 'completed',
        result: png.toString('base64'),
        revisedPrompt: 'apply the requested edit',
        startedSequence: 2,
        completedSequence: 3,
      }],
    },
  ]);
  const { agent } = createAgent(t, boundary);
  const submission = await agent.submit({
    message: {
      ...message('im-image-retry'),
      text: '请编辑这张图片，只改变背景颜色',
      summary: '请编辑这张图片，只改变背景颜色',
    },
    contextText: '请编辑这张图片，只改变背景颜色',
    resolvedMedia: [{ kind: 'image', bytes: png, contentType: 'image/png' }],
  });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;
  assert.equal(completed.candidates.length, 1);
  assert.equal(completed.candidates[0]?.type, 'generated_image');
  assert.equal(boundary.runCalls.length, 2);
  assert.match(String(boundary.runCalls[1]?.input), /必须调用图像生成能力/u);
});

test('rejects before turn/start when local image staging fails', async (t) => {
  const boundary = new FakeBoundary([]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stage-reject-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { agent } = createAgent(t, boundary, new FakeStore(), {
    imageTempDirectory: directory,
  });
  await assert.rejects(
    agent.submit({
      message: message('im-empty-image'),
      contextText: '识别图片',
      resolvedMedia: [{ kind: 'image', bytes: Buffer.alloc(0), contentType: 'image/png' }],
    }),
    /empty/u,
  );
  assert.equal(boundary.runCalls.length, 0);
});

test('waits for steering persistence and returns the latest media catalog', async (t) => {
  const raw = deferred<CodexTurnResult>();
  const steerEntered = deferred<void>();
  const steerRelease = deferred<void>();
  const store = new FakeStore();
  const thread: CodexThread = {
    id: 'thread-steer',
    async startRun(): Promise<CodexRun> {
      return { turnId: 'turn-steer', completion: raw.promise };
    },
    async steer(): Promise<string> {
      steerEntered.resolve();
      await steerRelease.promise;
      return 'turn-steer';
    },
  };
  const boundary: CodexBoundary = {
    startThread: () => thread,
    resumeThread: () => thread,
    readThread: async () => ({ thread: { turns: [] } }),
    close: async () => undefined,
  };
  const { agent } = createAgent(t, boundary, store);
  const primary = await agent.submit({ message: message('primary'), contextText: '先回答' });
  assert.equal(primary.kind, 'started');
  if (primary.kind !== 'started') return;
  const latestMedia = [{
    ref: 'media:0', messageKey: 'follow-up', openKfId: 'wk-test',
    externalUserId: 'wm-test', kind: 'image' as const, mediaId: 'secret',
    filename: 'new.png', sentAt: 2, rememberedAt: 2,
  }];
  const steerPromise = agent.submit({
    message: message('follow-up'),
    contextText: '用最新图片',
    mediaCatalog: latestMedia,
  });
  await steerEntered.promise;
  raw.resolve({ items: [stagedText('answer', '最终回答', 2)] });
  let completed = false;
  void primary.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  steerRelease.resolve();
  assert.equal((await steerPromise).kind, 'steered');
  const result = await primary.completion;
  assert.deepEqual(result.mediaCatalog, latestMedia);
});

test('does not finalize candidates from a failed historical turn', async (t) => {
  const boundary = new FakeBoundary([]);
  boundary.history = {
    thread: {
      turns: [{
        id: 'failed-turn',
        status: 'failed',
        items: [
          { type: 'userMessage', clientId: 'input-one' },
          stagedText('unsafe', '不应发送', 2),
        ],
      }],
    },
  };
  const { agent } = createAgent(t, boundary);
  const inspection = await agent.inspectHistory('thread-one', ['input-one'], 'input-one');
  assert.equal(inspection.state, 'failed');
  assert.deepEqual(inspection.candidates, []);
});

test('performs at most one format retry', async (t) => {
  const boundary = new FakeBoundary([{ items: [] }, { items: [] }]);
  const { agent } = createAgent(t, boundary);
  const submission = await agent.submit({ message: message('im-retry'), contextText: '请回答' });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  await assert.rejects(submission.completion, /valid final WeChat batch/u);
  assert.equal(boundary.runCalls.length, 2);
});
