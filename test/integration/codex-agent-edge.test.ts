import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import {
  CodexAgent,
  createCodexAppServer,
  type AgentInput,
} from '../../src/services/codex-agent.ts';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
  SpawnProcess,
} from '../../src/services/codex-app-server.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function tool(content: string) {
  return {
    id: `tool-${content}`,
    type: 'mcpToolCall',
    server: 'wechat_kf',
    tool: 'send_text',
    status: 'completed',
    startedSequence: 1,
    result: {
      structuredContent: {
        staged: true,
        candidate: { type: 'text', content },
      },
    },
  };
}

class Boundary implements CodexBoundary {
  readonly inputs: CodexInput[] = [];
  readonly options: CodexThreadOptions[] = [];
  readonly results: Array<Promise<CodexTurnResult>>;
  history: unknown = { thread: { turns: [] } };
  startCount = 0;
  steerCount = 0;
  closed = false;
  readonly thread: CodexThread;

  constructor(results: Array<Promise<CodexTurnResult> | CodexTurnResult>) {
    this.results = results.map((result) => Promise.resolve(result));
    this.thread = {
      id: 'thread-edge',
      startRun: async (input): Promise<CodexRun> => {
        this.inputs.push(input);
        this.startCount += 1;
        const completion = this.results.shift();
        if (!completion) throw new Error('Missing edge result');
        return { turnId: `turn-${this.startCount}`, completion };
      },
      steer: async (): Promise<string> => {
        this.steerCount += 1;
        return `turn-${this.startCount}`;
      },
    };
  }

  startThread(options: CodexThreadOptions): CodexThread {
    this.options.push(options);
    return this.thread;
  }

  resumeThread(options: string, threadOptions: CodexThreadOptions): CodexThread {
    assert.ok(options);
    this.options.push(threadOptions);
    return this.thread;
  }

  async readThread(): Promise<unknown> { return this.history; }
  async close(): Promise<void> { this.closed = true; }
}

class InitProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
        if (request.method === 'initialize') {
          this.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

async function harness(t: TestContext, boundary: Boundary) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-agent-edge-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  let cursor = '';
  function input(messageKey: string): AgentInput {
    const ingested = store.ingestSyncPage({
      openKfId: 'wk-edge',
      expectedCursor: cursor,
      nextCursor: `${cursor}-${messageKey}`,
      messages: [testWecomMessage({
        id: messageKey,
        openKfId: 'wk-edge',
        externalUserId: 'wm-edge',
      })],
    });
    cursor = `${cursor}-${messageKey}`;
    const storedKey = ingested.insertedMessageKeys[0];
    if (!storedKey) throw new Error('Expected inserted agent edge message');
    return {
      message: {
        id: messageKey, messageKey: storedKey, origin: 'customer', type: 'text', rawType: 'text',
        sentAt: 1, sync: { cursor, index: 0 },
        conversation: { openKfId: 'wk-edge', externalUserId: 'wm-edge' },
        actor: { servicerUserId: '' }, text: messageKey, summary: messageKey,
        attributes: {}, attachments: [],
      },
      contextText: messageKey,
    };
  }
  const agent = new CodexAgent({
    codex: boundary,
    store,
    config: {
      model: 'gpt-edge', reasoningEffort: 'none', sandboxMode: 'read-only',
      workingDirectory: directory, imageTempDirectory: directory,
      generatedImageDirectory: path.join(directory, 'generated'),
    },
  });
  t.after(async () => {
    await agent.abort();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { agent, input };
}

test('[C07][SEC01] prompt includes media, channel, observation, handoff, and customer boundaries', async (t) => {
  const boundary = new Boundary([{ items: [tool('reply')] }]);
  const { agent, input } = await harness(t, boundary);
  const base = input('prompt');
  const submission = await agent.submit({
    ...base,
    mediaCatalog: [{
      ref: 'media:0', messageKey: 'prompt', openKfId: 'wk-edge',
      externalUserId: 'wm-edge', kind: 'image', mediaId: 'secret',
      filename: 'photo.png', sentAt: 1, rememberedAt: 1,
    }],
    channelState: {
      accepted: false,
      customerObserved: true,
      revisedPrompt: 'only change color',
      recent: [{ sentType: 'image', status: 'uncertain' }],
    },
    handoffContext: '人工客服：此前已确认订单',
  });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  await submission.completion;
  const prompt = String(boundary.inputs[0]);
  for (const expected of [
    'media:0', '近期生成图', '客户已明确评价', 'only change color',
    'image:uncertain', '此前已确认订单', '<customer_message>',
  ]) assert.match(prompt, new RegExp(expected));
  assert.doesNotMatch(prompt, /secret/u);
});

test('[SEC01][DEP02] app-server environment handles API/base/path present and absent', async (t) => {
  const captures: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const spawnProcess = ((command, args, options) => {
    captures.push({ command, args: [...args], env: { ...options.env } });
    return new InitProcess() as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  const configured = createCodexAppServer(
    {
      apiKey: 'api-key', baseUrl: 'https://api.example.test',
      pathOverride: '/custom/codex', webSearchMode: 'live',
    },
    { spawnProcess },
  );
  const defaults = createCodexAppServer(
    { apiKey: '', baseUrl: '', pathOverride: '', webSearchMode: 'disabled' },
    { spawnProcess },
  );
  t.after(async () => Promise.all([configured.close(), defaults.close()]));
  await configured.initialize();
  await defaults.initialize();
  assert.equal(captures[0]?.command, '/custom/codex');
  assert.deepEqual(captures[0]?.args.slice(0, 2), ['app-server', '--stdio']);
  assert.equal(captures[0]?.env.OPENAI_API_KEY, 'api-key');
  assert.equal(captures[0]?.env.OPENAI_BASE_URL, 'https://api.example.test');
  assert.equal('OPENAI_API_KEY' in (captures[1]?.env || {}), false);
  assert.equal('OPENAI_BASE_URL' in (captures[1]?.env || {}), false);
  assert.ok(captures[0]?.args.includes('web_search="live"'));
  assert.ok(captures[1]?.args.includes('web_search="disabled"'));
});

test('[R04] history inspection distinguishes missing, input-only, and completed without a boundary', async (t) => {
  const boundary = new Boundary([]);
  const { agent } = await harness(t, boundary);
  assert.equal(
    (await agent.inspectHistory('thread', ['missing'], 'missing')).state,
    'missing',
  );
  boundary.history = {
    thread: {
      turns: [{
        id: 'active', status: 'inProgress',
        items: [{ type: 'userMessage', clientId: 'input' }],
      }],
    },
  };
  assert.equal(
    (await agent.inspectHistory('thread', ['input'], 'input')).state,
    'input_only',
  );
  boundary.history = {
    thread: {
      turns: [{
        id: 'complete', status: 'completed',
        items: [{ type: 'userMessage', clientId: 'input' }, tool('historical')],
      }],
    },
  };
  const completed = await agent.inspectHistory('thread', ['input'], 'absent-boundary');
  assert.equal(completed.state, 'completed');
  assert.equal(completed.candidates[0]?.type, 'text');
});

test('[S08] a message arriving after active completion starts a fresh turn', async (t) => {
  const first = deferred<CodexTurnResult>();
  const boundary = new Boundary([first.promise, { items: [tool('second')] }]);
  const { agent, input } = await harness(t, boundary);
  const submission = await agent.submit(input('first'));
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  first.resolve({ items: [tool('first')] });
  await submission.completion;
  const next = await agent.submit(input('second'));
  assert.equal(next.kind, 'started');
  if (next.kind === 'started') await next.completion;
  assert.equal(boundary.startCount, 2);
  assert.equal(boundary.steerCount, 0);
});

test('[DEP01] close waits for active completion while abort closes immediately', async (t) => {
  const active = deferred<CodexTurnResult>();
  const closeBoundary = new Boundary([active.promise]);
  const closeHarness = await harness(t, closeBoundary);
  const submission = await closeHarness.agent.submit(closeHarness.input('close-active'));
  assert.equal(submission.kind, 'started');
  const closing = closeHarness.agent.close();
  await Promise.resolve();
  assert.equal(closeBoundary.closed, false);
  active.resolve({ items: [tool('done')] });
  await closing;
  assert.equal(closeBoundary.closed, true);

  const pending = deferred<CodexTurnResult>();
  const abortBoundary = new Boundary([pending.promise]);
  const abortHarness = await harness(t, abortBoundary);
  await abortHarness.agent.submit(abortHarness.input('abort-active'));
  await abortHarness.agent.abort();
  assert.equal(abortBoundary.closed, true);
  pending.resolve({ items: [tool('ignored')] });
});
