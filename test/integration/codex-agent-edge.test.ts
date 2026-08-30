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
      model: 'gpt-edge', reasoningEffort: 'none',
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

test('app-server isolates an explicit provider key from its config arguments', async (t) => {
  const captures: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const spawnProcess = ((command, args, options) => {
    captures.push({ command, args: [...args], env: { ...options.env } });
    return new InitProcess() as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  const providerApiKeyEnv = 'KINTIO_TEST_PROVIDER_API_KEY';
  const providerApiKey = 'provider-key-canary-value';
  const previousProviderApiKey = process.env[providerApiKeyEnv];
  process.env[providerApiKeyEnv] = providerApiKey;
  t.onTestFinished(() => {
    if (previousProviderApiKey === undefined) delete process.env[providerApiKeyEnv];
    else process.env[providerApiKeyEnv] = previousProviderApiKey;
  });
  const configured = createCodexAppServer(
    {
      pathOverride: '/custom/codex', webSearchMode: 'live',
      workingDirectory: '/custom/workspace',
    },
    {
      spawnProcess,
      mcpUrl: 'https://robot.example/mcp',
      mcpBearerToken: 'test-bearer-token',
      ilinkMcpUrl: 'https://robot.example/mcp/ilink',
      mcpToolTimeoutSec: 35,
      ilinkMcpToolTimeoutSec: 150,
      modelProvider: {
        baseUrl: 'https://www.xieyu.chat/',
        apiKeyEnv: providerApiKeyEnv,
      },
    },
  );
  const defaults = createCodexAppServer(
    {
      pathOverride: '', webSearchMode: 'disabled',
      workingDirectory: '/default/workspace',
    },
    {
      spawnProcess,
      mcpUrl: 'http://127.0.0.1:8888/mcp',
      mcpBearerToken: 'test-bearer-token',
    },
  );
  const ilinkOnly = createCodexAppServer(
    {
      pathOverride: '', webSearchMode: 'disabled',
      workingDirectory: '/ilink-only/workspace',
    },
    {
      spawnProcess,
      memoryMcpUrl: 'https://chat.example/mcp/memory',
      ilinkMcpUrl: 'https://chat.example/mcp/ilink',
      mcpBearerToken: 'test-bearer-token',
    },
  );
  t.onTestFinished(async () => {
    await Promise.all([configured.close(), defaults.close(), ilinkOnly.close()]);
  });
  await configured.initialize();
  await defaults.initialize();
  await ilinkOnly.initialize();
  assert.equal(captures[0]?.command, '/custom/codex');
  assert.equal(captures[1]?.command, 'codex');
  assert.deepEqual(captures[0]?.args.slice(0, 2), ['app-server', '--stdio']);
  assert.equal('OPENAI_API_KEY' in (captures[0]?.env || {}), false);
  assert.equal('OPENAI_BASE_URL' in (captures[0]?.env || {}), false);
  assert.equal('KINTIO_CI_API_KEY' in (captures[0]?.env || {}), false);
  assert.equal(
    captures[0]?.env[providerApiKeyEnv],
    providerApiKey,
  );
  assert.equal(
    captures[1]?.env[providerApiKeyEnv],
    providerApiKey,
  );
  assert.equal(captures[0]?.env.KINTIO_MCP_BEARER_TOKEN, 'test-bearer-token');
  assert.ok(captures[0]?.args.includes('model_provider="kintio_proxy"'));
  assert.ok(captures[0]?.args.includes('model_providers.kintio_proxy={}'));
  assert.ok(captures[0]?.args.includes(
    'model_providers.kintio_proxy.base_url="https://www.xieyu.chat"',
  ));
  assert.ok(captures[0]?.args.includes(
    `model_providers.kintio_proxy.env_key="${providerApiKeyEnv}"`,
  ));
  assert.ok(captures[0]?.args.includes(
    'model_providers.kintio_proxy.wire_api="responses"',
  ));
  assert.equal(JSON.stringify(captures[0]?.args).includes(providerApiKey), false);
  assert.ok(captures[0]?.args.includes(
    'mcp_servers.wechat_kf.url="https://robot.example/mcp"',
  ));
  assert.ok(captures[0]?.args.includes(
    'mcp_servers.conversation_memory.url="https://robot.example/mcp/memory"',
  ));
  assert.ok(captures[0]?.args.includes('mcp_servers.wechat_kf.tool_timeout_sec=35'));
  assert.ok(captures[0]?.args.includes('mcp_servers.weixin_ilink.tool_timeout_sec=150'));
  assert.ok(captures[0]?.args.includes('web_search="live"'));
  assert.ok(captures[1]?.args.includes('web_search="disabled"'));
  assert.equal(
    captures[2]?.args.some((argument) => argument.startsWith('mcp_servers.wechat_kf.')),
    false,
  );
  assert.ok(captures[2]?.args.includes(
    'mcp_servers.weixin_ilink.url="https://chat.example/mcp/ilink"',
  ));
});

test('app-server rejects unsafe explicit provider credentials and URLs', (t) => {
  const base = {
    pathOverride: '', webSearchMode: 'disabled' as const,
    workingDirectory: '/provider-validation/workspace',
  };
  const options = {
    memoryMcpUrl: 'https://chat.example/mcp/memory',
    mcpBearerToken: 'test-bearer-token',
  };
  assert.throws(() => createCodexAppServer(base, {
    ...options,
    modelProvider: { baseUrl: 'https://www.xieyu.chat', apiKeyEnv: 'invalid-name' },
  }), /environment name is invalid/u);
  const missingKeyBefore = process.env.KINTIO_MISSING_PROVIDER_API_KEY;
  const unsafeKeyBefore = process.env.KINTIO_TEST_UNSAFE_PROVIDER_API_KEY;
  delete process.env.KINTIO_MISSING_PROVIDER_API_KEY;
  t.onTestFinished(() => {
    if (missingKeyBefore === undefined) {
      delete process.env.KINTIO_MISSING_PROVIDER_API_KEY;
    } else {
      process.env.KINTIO_MISSING_PROVIDER_API_KEY = missingKeyBefore;
    }
    if (unsafeKeyBefore === undefined) {
      delete process.env.KINTIO_TEST_UNSAFE_PROVIDER_API_KEY;
    } else {
      process.env.KINTIO_TEST_UNSAFE_PROVIDER_API_KEY = unsafeKeyBefore;
    }
  });
  assert.throws(() => createCodexAppServer(base, {
    ...options,
    modelProvider: {
      baseUrl: 'https://www.xieyu.chat',
      apiKeyEnv: 'KINTIO_MISSING_PROVIDER_API_KEY',
    },
  }), /API key is missing/u);
  process.env.KINTIO_TEST_UNSAFE_PROVIDER_API_KEY = 'provider-key';
  for (const baseUrl of [
    'http://www.xieyu.chat',
    'https://user:password@www.xieyu.chat',
    'https://www.xieyu.chat?key=value',
    'https://www.xieyu.chat#fragment',
    'not a URL',
  ]) {
    assert.throws(() => createCodexAppServer(base, {
      ...options,
      modelProvider: {
        baseUrl,
        apiKeyEnv: 'KINTIO_TEST_UNSAFE_PROVIDER_API_KEY',
      },
    }), /HTTPS URL|must use HTTPS/u, baseUrl);
  }
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
