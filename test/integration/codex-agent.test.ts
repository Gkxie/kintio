import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import {
  CodexAgent,
  executedAttemptIds,
} from '../../src/services/codex-agent.ts';
import type { AgentInput, AgentMessage } from '../../src/agent/runtime.ts';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
} from '../../src/services/codex-app-server.ts';
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

function executedText(id: string, attemptId: string, startedSequence: number) {
  return {
    id,
    type: 'mcpToolCall',
    server: 'wechat_kf',
    tool: 'send_text',
    status: 'completed',
    startedSequence,
    result: {
      structuredContent: {
        status: 'accepted',
        attemptId,
        sendIndex: 0,
        type: 'text',
        msgid: 'wx-accepted',
      },
    },
  };
}

function message(messageKey = 'im-primary'): AgentMessage {
  return {
    messageKey,
    text: '测试',
    summary: '测试',
  };
}

function agentInput(
  messageKey = 'im-primary',
  overrides: Partial<AgentInput> = {},
): AgentInput {
  const baseMessage = message(messageKey);
  const { message: overrideMessage, ...rest } = overrides;
  return {
    mode: 'start',
    conversationId: 'cv-test',
    threadId: '',
    contextText: baseMessage.summary,
    toolSessionToken: `ws_${'a'.repeat(32)}`,
    ...rest,
    message: overrideMessage || baseMessage,
  };
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
  config: Partial<{
    imageTempDirectory: string;
    generatedImageDirectory: string;
  }> = {},
) {
  const agent = new CodexAgent({
    codex: boundary,
    config: {
      model: 'gpt-project',
      reasoningEffort: 'low',
      workingDirectory: '/isolated-codex-workspace',
      imageTempDirectory: config.imageTempDirectory || os.tmpdir(),
      generatedImageDirectory: config.generatedImageDirectory || '',
    },
  });
  t.onTestFinished(() => agent.close());
  return agent;
}

test('passes project model/effort and treats customer observation independently of accepted', async (t) => {
  const boundary = new FakeBoundary([
    { items: [executedText('answer', 'sa_project_config', 1)] },
  ]);
  const agent = createAgent(t, boundary);
  const submission = await agent.submit(agentInput('im-primary', {
    contextText: '测试项目模型配置',
    channelState: { accepted: false, customerObserved: true },
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;

  assert.deepEqual(boundary.startOptions, [{
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
  assert.deepEqual(completed.executedAttemptIds, ['sa_project_config']);
  assert.match(String(boundary.runCalls[0]?.input), /participant explicitly commented/u);
  assert.equal(submission.threadId, 'thread-test');
});

test('a live turn rejection stays observed after Harness-owned thread initialization', async (t) => {
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
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  t.onTestFinished(() => {
    process.off('unhandledRejection', onUnhandled);
  });
  const agent = createAgent(t, boundary);
  assert.equal(await agent.ensureThread('cv-persist-failure', ''), thread.id);
  const submission = await agent.submit(agentInput('persist-failure', {
    conversationId: 'cv-persist-failure',
    threadId: thread.id || '',
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const rejected = assert.rejects(submission.completion, /turn later rejected/u);
  turn.reject(new Error('turn later rejected'));
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unhandled, 0);
});

test('archived thread starts fresh with memory binding while deleted thread starts clean', async (t) => {
  const calls = { starts: 0, resumes: [] as string[] };
  const makeThread = (id: string): CodexThread => ({
    id,
    async ensure() { return id; },
    async startRun(): Promise<CodexRun> {
      throw new Error('not expected');
    },
    async steer() { throw new Error('not expected'); },
  });
  const boundary: CodexBoundary = {
    startThread() {
      calls.starts += 1;
      return makeThread(`01900000-0000-7000-8000-00000000000${calls.starts}`);
    },
    resumeThread(threadId) {
      calls.resumes.push(threadId);
      return makeThread(threadId);
    },
    async getThreadState(threadId) {
      if (threadId.endsWith('001')) return 'active';
      if (threadId.endsWith('002')) return 'archived';
      return 'missing';
    },
    async readThread() { return {}; },
    async close() {},
  };
  const agent = createAgent(t, boundary);
  const active = '01900000-0000-7000-8000-000000000001';
  const archived = '01900000-0000-7000-8000-000000000002';
  const deleted = '01900000-0000-7000-8000-000000000003';

  assert.equal(await agent.ensureThread('cv-active', active), active);
  assert.equal(agent.takePendingMemoryThread('cv-active'), '');
  assert.notEqual(await agent.ensureThread('cv-archived', archived), archived);
  assert.equal(agent.takePendingMemoryThread('cv-archived'), archived);
  assert.notEqual(await agent.ensureThread('cv-deleted', deleted), deleted);
  assert.equal(agent.takePendingMemoryThread('cv-deleted'), '');
  assert.deepEqual(calls, { starts: 2, resumes: [active] });
});

test('keeps only executed MCP attempts after the last steering boundary', () => {
  assert.deepEqual(executedAttemptIds({
    lastSteerSequence: 10,
    items: [
      executedText('before', 'sa_before', 4),
      executedText('at-boundary', 'sa_boundary', 10),
      executedText('after-one', 'sa_after_one', 11),
      { id: 'failed', type: 'mcpToolCall', server: 'wechat_kf', tool: 'send_text', status: 'failed', startedSequence: 12 },
      executedText('after-two', 'sa_after_two', 13),
      { ...executedText('other', 'sa_other', 14), server: 'other' },
    ],
  }), ['sa_after_one', 'sa_after_two']);
  assert.deepEqual(executedAttemptIds({
    items: [{
      ...executedText('offer', 'sa_offer', 1),
      tool: 'offer_weixin_bot_channel',
    }],
  }, 'wechat_kf'), ['sa_offer']);
  assert.deepEqual(executedAttemptIds({
    items: [{ ...executedText('ilink', 'sa_ilink', 1), server: 'weixin_ilink' }],
  }, 'weixin_ilink'), ['sa_ilink']);
});

test('selects the last valid generated image and removes every trusted generated path', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-generated-'));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = ['pre.png', 'failed.png', 'invalid.png', 'selected.png'].map((name) =>
    path.join(directory, name),
  );
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, 'temporary')));
  const png = Buffer.from('89504e470d0a1a0a02020202', 'hex');
  const boundary = new FakeBoundary([
    {
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
    },
    { items: [executedText('send-selected', 'sa_selected_image', 16)] },
  ]);
  const published: Array<{ readonly revisedPrompt?: unknown }> = [];
  const agent = createAgent(t, boundary, {
    generatedImageDirectory: directory,
  });
  const submission = await agent.submit(agentInput('im-image', {
    contextText: '编辑图片',
    publishArtifact: async (artifact) => {
      published.push(artifact.metadata || {});
      return 'artifact:0';
    },
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;
  assert.deepEqual(completed.executedAttemptIds, ['sa_selected_image']);
  assert.equal(published[0]?.revisedPrompt, 'latest');
  await Promise.all(paths.map((filePath) =>
    assert.rejects(fs.access(filePath), { code: 'ENOENT' }),
  ));
});

test('generated cleanup rejects symlinked roots and escape components', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-generated-link-'));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside');
  const trusted = path.join(directory, 'trusted');
  await fs.mkdir(outside);
  await fs.mkdir(trusted);
  const png = Buffer.from('89504e470d0a1a0a02020202', 'hex');

  const escapedFile = path.join(outside, 'escaped.png');
  await fs.writeFile(escapedFile, png);
  await fs.symlink(
    outside,
    path.join(trusted, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const escapedBoundary = new FakeBoundary([
    {
      items: [{
        id: 'escaped', type: 'imageGeneration', status: 'completed',
        result: png.toString('base64'), savedPath: path.join(trusted, 'escape/escaped.png'),
      }],
    },
    { items: [executedText('send-escaped', 'sa_escaped_image', 2)] },
  ]);
  const escapedAgent = createAgent(t, escapedBoundary, {
    generatedImageDirectory: trusted,
  });
  const escaped = await escapedAgent.submit(agentInput('escaped-generated', {
    contextText: '生成图',
    publishArtifact: async () => 'artifact:0',
  }));
  assert.equal(escaped.kind, 'started');
  if (escaped.kind === 'started') await escaped.completion;
  await fs.access(escapedFile);

  const linkedRoot = path.join(directory, 'linked-root');
  const linkedFile = path.join(outside, 'linked-root.png');
  await fs.writeFile(linkedFile, png);
  await fs.symlink(
    outside,
    linkedRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linkedBoundary = new FakeBoundary([
    {
      items: [{
        id: 'linked-root', type: 'imageGeneration', status: 'completed',
        result: png.toString('base64'), savedPath: path.join(linkedRoot, 'linked-root.png'),
      }],
    },
    { items: [executedText('send-linked', 'sa_linked_image', 2)] },
  ]);
  const linkedAgent = createAgent(t, linkedBoundary, {
    generatedImageDirectory: linkedRoot,
  });
  const linked = await linkedAgent.submit(agentInput('linked-generated', {
    contextText: '生成图',
    publishArtifact: async () => 'artifact:0',
  }));
  assert.equal(linked.kind, 'started');
  if (linked.kind === 'started') await linked.completion;
  await fs.access(linkedFile);
});

test('explicit image edit discards premature failure text and forces exactly one generation retry', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a03030303', 'hex');
  const boundary = new FakeBoundary([
    { items: [{ id: 'premature-text', type: 'agentMessage', status: 'completed', text: '图片处理失败' }] },
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
    { items: [executedText('send-retried', 'sa_retried_image', 4)] },
  ]);
  const agent = createAgent(t, boundary);
  const published: Buffer[] = [];
  const submission = await agent.submit(agentInput('im-image-retry', {
    message: {
      ...message('im-image-retry'),
      text: '请编辑这张图片，只改变背景颜色',
      summary: '请编辑这张图片，只改变背景颜色',
    },
    contextText: '请编辑这张图片，只改变背景颜色',
    resolvedMedia: [{ kind: 'image', bytes: png, contentType: 'image/png' }],
    publishArtifact: async (artifact) => {
      published.push(artifact.bytes);
      return 'artifact:0';
    },
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completed = await submission.completion;
  assert.deepEqual(completed.executedAttemptIds, ['sa_retried_image']);
  assert.deepEqual(published, [png]);
  assert.equal(boundary.runCalls.length, 3);
  assert.match(String(boundary.runCalls[1]?.input), /image generation.*host runtime.*artifact/isu);
  assert.match(String(boundary.runCalls[2]?.input), /artifact:0.*send_image/su);
});

test('image descriptions do not treat action substrings as generation intent', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a03030303', 'hex');
  const boundary = new FakeBoundary([
    { items: [{ id: 'draft', type: 'agentMessage', text: 'draft' }] },
    { items: [executedText('send-description', 'sa_image_description', 2)] },
  ]);
  const agent = createAgent(t, boundary);
  const submission = await agent.submit(agentInput('im-image-description', {
    message: {
      ...message('im-image-description'),
      text: 'Describe the image address shown here.',
      summary: 'Describe the image address shown here.',
    },
    contextText: 'Describe the image address shown here.',
    resolvedMedia: [{ kind: 'image', bytes: png, contentType: 'image/png' }],
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  assert.deepEqual((await submission.completion).executedAttemptIds, [
    'sa_image_description',
  ]);
  assert.equal(boundary.runCalls.length, 2);
  assert.match(String(boundary.runCalls[1]?.input), /No deliverable message has been sent/u);
  assert.doesNotMatch(String(boundary.runCalls[1]?.input), /image generation only/u);
});

test('rejects before turn/start when local image staging fails', async (t) => {
  const boundary = new FakeBoundary([]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stage-reject-'));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const agent = createAgent(t, boundary, {
    imageTempDirectory: directory,
  });
  await assert.rejects(
    agent.submit(agentInput('im-empty-image', {
      contextText: '识别图片',
      resolvedMedia: [{ kind: 'image', bytes: Buffer.alloc(0), contentType: 'image/png' }],
    })),
    /empty/u,
  );
  assert.equal(boundary.runCalls.length, 0);
});

test('waits for the steering RPC and sends the latest media catalog to Codex', async (t) => {
  const raw = deferred<CodexTurnResult>();
  const steerEntered = deferred<void>();
  const steerRelease = deferred<void>();
  let steeredInput: CodexInput | undefined;
  const thread: CodexThread = {
    id: 'thread-steer',
    async startRun(): Promise<CodexRun> {
      return { turnId: 'turn-steer', completion: raw.promise };
    },
    async steer(input): Promise<string> {
      steeredInput = input;
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
  const agent = createAgent(t, boundary);
  const primary = await agent.submit(agentInput('primary', { contextText: '先回答' }));
  assert.equal(primary.kind, 'started');
  if (primary.kind !== 'started') return;
  const latestMedia = [{
    ref: 'media:0', messageKey: 'follow-up', kind: 'image' as const,
  }];
  const steerPromise = agent.submit(agentInput('follow-up', {
    mode: 'steer',
    threadId: 'thread-steer',
    contextText: '用最新图片',
    mediaCatalog: latestMedia,
    toolSessionToken: `ws_${'b'.repeat(32)}`,
  }));
  await steerEntered.promise;
  raw.resolve({ items: [executedText('answer', 'sa_steered_answer', 2)] });
  let completed = false;
  void primary.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  steerRelease.resolve();
  assert.equal((await steerPromise).kind, 'steered');
  await primary.completion;
  assert.match(String(steeredInput), /media:0/u);
});

test('does not finalize artifacts from a failed historical turn', async (t) => {
  const boundary = new FakeBoundary([]);
  boundary.history = {
    thread: {
      turns: [{
        id: 'failed-turn',
        status: 'failed',
        items: [
          { type: 'userMessage', clientId: 'input-one' },
          executedText('unsafe', 'sa_failed_history', 2),
        ],
      }],
    },
  };
  const agent = createAgent(t, boundary);
  const inspection = await agent.inspectHistory('thread-one', ['input-one'], 'input-one');
  assert.equal(inspection.state, 'failed');
  assert.deepEqual(inspection.artifacts, []);
});

test('history inspection joins generated output with its later artifact send turn', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a04040404', 'hex');
  const boundary = new FakeBoundary([]);
  boundary.history = {
    thread: {
      turns: [{
        id: 'generation-turn',
        status: 'completed',
        items: [
          { type: 'userMessage', clientId: 'input-image' },
          {
            id: 'generated', type: 'imageGeneration', status: 'completed',
            result: png.toString('base64'), revisedPrompt: 'recovered image',
          },
        ],
      }, {
        id: 'artifact-send-turn',
        status: 'completed',
        items: [
          { type: 'userMessage', clientId: 'input-image-artifact-send' },
          { ...executedText('sent-image', 'sa_history_image', 2), tool: 'send_image' },
        ],
      }],
    },
  };
  const agent = createAgent(t, boundary);
  const inspection = await agent.inspectHistory(
    'thread-image',
    ['input-image'],
    'input-image',
  );
  assert.equal(inspection.state, 'completed');
  assert.equal(inspection.artifacts[0]?.type, 'generated_image');
  assert.deepEqual(inspection.executedAttemptIds, ['sa_history_image']);
});

test('current and legacy recovery no-action markers finish without another tool call', async (t) => {
  for (const marker of [
    '[[KINTIO_NO_ADDITIONAL_ACTION]]',
    '[[TALKFERRY_NO_ADDITIONAL_ACTION]]',
    '[[HARNESS_NO_ADDITIONAL_ACTION]]',
  ]) {
    const boundary = new FakeBoundary([{
      items: [{
        id: 'no-action',
        type: 'agentMessage',
        status: 'completed',
        text: marker,
      }],
    }]);
    const agent = createAgent(t, boundary);
    const submission = await agent.submit(agentInput(`no-action-${marker}`, {
      contextText: '恢复已有渠道事实',
      allowNoAction: true,
    }));
    assert.equal(submission.kind, 'started');
    if (submission.kind !== 'started') continue;
    assert.deepEqual(await submission.completion, {
      decision: 'no_action',
    });
    assert.equal(boundary.runCalls.length, 1);
  }
});

test('performs at most one format retry', async (t) => {
  const boundary = new FakeBoundary([{ items: [] }, { items: [] }]);
  const agent = createAgent(t, boundary);
  const submission = await agent.submit(agentInput('im-retry', { contextText: '请回答' }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  await assert.rejects(
    submission.completion,
    /did not execute a channel tool or produce an image artifact/u,
  );
  assert.equal(boundary.runCalls.length, 2);
});

test('a durable iLink window rejection completes without a format retry', async (t) => {
  const boundary = new FakeBoundary([{
    items: [{
      id: 'quota-rejected',
      type: 'mcpToolCall',
      server: 'weixin_ilink',
      tool: 'send_text',
      status: 'failed',
      startedSequence: 1,
      result: {
        structuredContent: {
          status: 'failed',
          attemptId: 'sa_ilink_quota_rejected',
          sendIndex: 10,
          type: 'text',
          msgid: '',
          error: { kind: 'reply_quota_exhausted' },
        },
      },
    }],
  }]);
  const agent = createAgent(t, boundary);
  const submission = await agent.submit(agentInput('ilink-quota', {
    channel: 'weixin_ilink',
    contextText: '额度边界测试',
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  assert.deepEqual(await submission.completion, {
    executedAttemptIds: ['sa_ilink_quota_rejected'],
  });
  assert.equal(boundary.runCalls.length, 1);
});

test('transport-closed execution is never reconstructed into a duplicate host send', async (t) => {
  const boundary = new FakeBoundary([{
    items: [{
      id: 'closed-send', type: 'mcpToolCall', server: 'wechat_kf',
      tool: 'send_text', status: 'failed', startedSequence: 1,
      arguments: { content: '恢复后的客服回复' },
      error: { message: 'tool call failed: Transport closed' },
    }],
  }, {
    items: [executedText('retry-send', 'sa_retry_after_transport', 2)],
  }]);
  const agent = createAgent(t, boundary);
  const submission = await agent.submit(agentInput('transport-closed', {
    contextText: '测试传输恢复',
  }));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  const completion = await submission.completion;
  assert.deepEqual(completion.executedAttemptIds, ['sa_retry_after_transport']);
  assert.equal(boundary.runCalls.length, 2);
});
