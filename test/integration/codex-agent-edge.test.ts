import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import {
  CodexAgent,
  createCodexAppServer,
} from '../../src/services/codex-agent.ts';
import type { AgentInput } from '../../src/agent/runtime.ts';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
  CodexTurnResult,
  SpawnProcess,
} from '../../src/services/codex-app-server.ts';

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
  const attemptId = `sa_${content.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
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
        attemptId,
        sendIndex: 0,
        type: 'text',
        msgid: `wx-${content}`,
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
  function input(messageKey: string): AgentInput {
    return {
      channel: 'wechat_kf',
      mode: 'start',
      conversationId: 'cv-edge',
      threadId: '',
      message: {
        messageKey, text: messageKey, summary: messageKey,
      },
      contextText: messageKey,
      toolSessionToken: `ws_${'e'.repeat(32)}`,
    };
  }
  const agent = new CodexAgent({
    codex: boundary,
    config: {
      workingDirectory: directory, imageTempDirectory: directory,
      generatedImageDirectory: path.join(directory, 'generated'),
    },
  });
  t.onTestFinished(async () => {
    await agent.abort();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { agent, input };
}

test('prompt includes media, channel, observation, and customer boundaries', async (t) => {
  const boundary = new Boundary([{ items: [tool('reply')] }]);
  const { agent, input } = await harness(t, boundary);
  const base = input('prompt');
  const submission = await agent.submit({
    ...base,
    archivedThreadId: '01900000-0000-7000-8000-000000000001',
    mediaCatalog: [{
      ref: 'media:0', messageKey: 'prompt', kind: 'image',
    }],
    channelState: {
      accepted: false,
      customerObserved: true,
      revisedPrompt: 'only change color',
    },
  });
  assert.equal(submission.kind, 'started');
  if (submission.kind !== 'started') return;
  await submission.completion;
  const prompt = String(boundary.inputs[0]);
  for (const expected of [
    'media:0', 'recent generated image', 'participant explicitly commented', 'only change color',
    '<conversation_context>', '01900000-0000-7000-8000-000000000001',
    'conversation_memory.read_archived_thread',
  ]) assert.match(prompt, new RegExp(expected));
  assert.doesNotMatch(prompt, /open_kfid|external_userid|media_id/iu);
});

test('app-server registers channel-specific stdio MCP launches', async (t) => {
  const captures: Array<{ args: readonly string[] }> = [];
  const spawnProcess = ((_command, args) => {
    captures.push({ args: [...args] });
    return new InitProcess() as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  const configured = createCodexAppServer({
    spawnProcess,
    mcpLaunches: {
      wechatKf: { command: '/node', args: ['/relay', '--route', 'wechat_kf'] },
      memory: { command: '/node', args: ['/relay', '--route', 'conversation_memory'] },
      ilink: { command: '/node', args: ['/relay', '--route', 'weixin_ilink'] },
    },
    mcpToolTimeoutSec: 35,
    ilinkMcpToolTimeoutSec: 150,
  });
  const ilinkOnly = createCodexAppServer({
    spawnProcess,
    mcpLaunches: {
      memory: { command: '/node', args: ['/relay', '--route', 'conversation_memory'] },
      ilink: { command: '/node', args: ['/relay', '--route', 'weixin_ilink'] },
    },
  });
  t.onTestFinished(async () => {
    await Promise.all([configured.close(), ilinkOnly.close()]);
  });
  await configured.initialize();
  await ilinkOnly.initialize();
  assert.ok(captures[0]?.args.includes(
    'mcp_servers.wechat_kf.command="/node"',
  ));
  assert.ok(captures[0]?.args.includes(
    'mcp_servers.conversation_memory.args=["/relay","--route","conversation_memory"]',
  ));
  assert.ok(captures[0]?.args.includes('mcp_servers.wechat_kf.tool_timeout_sec=35'));
  assert.ok(captures[0]?.args.includes('mcp_servers.weixin_ilink.tool_timeout_sec=150'));
  assert.equal(
    captures[1]?.args.some((argument) => argument.startsWith('mcp_servers.wechat_kf.')),
    false,
  );
  assert.ok(captures[1]?.args.includes(
    'mcp_servers.weixin_ilink.args=["/relay","--route","weixin_ilink"]',
  ));
});

test('history inspection distinguishes missing, input-only, and completed without a boundary', async (t) => {
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
  assert.deepEqual(completed.artifacts, []);
  assert.deepEqual(completed.executedAttemptIds, ['sa_historical']);
});

test('a message arriving after active completion starts a fresh turn', async (t) => {
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

test('close waits for active completion while abort closes immediately', async (t) => {
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
