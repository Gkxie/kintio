import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'vitest';

import {
  CodexAppServer,
  type CodexInput,
  type CodexThreadOptions,
  type SpawnProcess,
} from '../../src/services/codex-app-server.ts';

type RpcMessage = Record<string, unknown>;

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  killedWith: NodeJS.Signals | null = null;
  #buffer = '';

  constructor(handler: (message: RpcMessage, child: FakeProcess) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#buffer += chunk.toString();
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line) handler(JSON.parse(line) as RpcMessage, this);
          newline = this.#buffer.indexOf('\n');
        }
        callback();
      },
    });
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(code: number, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    queueMicrotask(() => this.emit('exit', code, signal));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return true;
    this.killedWith = signal;
    this.exit(0, signal);
    return true;
  }
}

const threadOptions: CodexThreadOptions = {
  workingDirectory: '/workspace',
  approvalPolicy: 'never',
};

function fakeSpawn(
  handler: (message: RpcMessage, child: FakeProcess) => void,
): { spawn: SpawnProcess; child: () => FakeProcess; requests: RpcMessage[] } {
  let process!: FakeProcess;
  const requests: RpcMessage[] = [];
  const spawn = (() => {
    process = new FakeProcess((message, child) => {
      requests.push(message);
      handler(message, child);
    });
    return process as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  return { spawn, child: () => process, requests };
}

function standardHandler(message: RpcMessage, child: FakeProcess): void {
  if (message.method === 'initialize') {
    child.send({ id: message.id, result: { userAgent: 'mock' } });
  } else if (message.method === 'thread/start') {
    child.send({ id: message.id, result: { thread: { id: 'thread-one' } } });
  } else if (message.method === 'thread/resume') {
    child.send({ id: message.id, result: { thread: { id: 'thread-resumed' } } });
  } else if (message.method === 'thread/read') {
    child.send({ id: message.id, result: { thread: { id: 'thread-resumed', turns: [] } } });
  } else if (message.method === 'turn/start') {
    child.send({ id: message.id, result: { turn: { id: `turn-${String(message.id)}` } } });
  } else if (message.method === 'turn/interrupt') {
    child.send({ id: message.id, result: {} });
  }
}

test('JSON-RPC errors retain the code but suppress the server message', async () => {
  for (const [code, expected] of [
    [-32001, -32001],
    [{ providerSecretCanary: true }, undefined],
  ] as const) {
    const fake = fakeSpawn((message, child) => {
      if (message.method === 'initialize') {
        child.send({
          id: message.id,
          error: { code, message: 'authentication-secret-canary' },
        });
      }
    });
    const server = new CodexAppServer({ spawnProcess: fake.spawn });
    await assert.rejects(server.initialize(), (error: unknown) =>
      error instanceof Error &&
      error.message === (
        expected === undefined
          ? 'Codex app-server request failed: initialize'
          : `Codex app-server request failed: initialize (code ${expected})`
      ) &&
      !error.message.includes('authentication-secret-canary') &&
      ('code' in error ? error.code : undefined) === expected
    );
    await server.close();
  }
});

test('request failures expose only safe code and category diagnostics', async () => {
  const fake = fakeSpawn((message, child) => {
    if (message.method === 'initialize') {
      child.send({ id: message.id, result: { userAgent: 'mock' } });
    } else if (message.method === 'thread/start') {
      child.send({
        id: message.id,
        error: {
          code: -32001,
          message: 'thread-secret-canary /private/thread',
          data: {
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
          },
        },
      });
    }
  });
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  const thread = server.startThread(threadOptions);
  await assert.rejects(
    thread.startRun('hello'),
    (error: unknown) => error instanceof Error &&
      error.message === 'Codex app-server request failed: thread/start ' +
        '(code -32001; category httpConnectionFailed (HTTP 401))' &&
      !/secret-canary|\/private/u.test(error.message),
  );
  await server.close();
});

test('request timeout rejects and close terminates the unresponsive child', async () => {
  const fake = fakeSpawn(() => {});
  const server = new CodexAppServer({
    spawnProcess: fake.spawn,
    requestTimeoutMs: 15,
  });
  await assert.rejects(server.initialize(), /request timed out: initialize/u);
  await server.close();
  assert.equal(fake.child().killedWith, 'SIGTERM');
});

test('spawn errors retain the operating-system diagnostic', async () => {
  const fake = fakeSpawn(() => {});
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  const initializing = server.initialize();
  queueMicrotask(() => fake.child().emit('error', new Error('spawn codex ENOENT')));
  await assert.rejects(initializing, /process error: spawn codex ENOENT/u);
  await server.close();
});

test('unexpected exit discards raw stderr in every pending rejection', async () => {
  const fake = fakeSpawn(() => {});
  const warnings: string[] = [];
  const server = new CodexAppServer({
    spawnProcess: fake.spawn,
    logger: { warn(message) { warnings.push(message); } },
  });
  const initializing = server.initialize();
  fake.child().stderr.write('fatal app-server detail');
  fake.child().exit(7);
  await assert.rejects(initializing, (error: unknown) =>
    error instanceof Error && error.message === 'Codex app-server exited with code 7' &&
    !error.message.includes('fatal app-server detail')
  );
  assert.deepEqual(warnings, []);
  await server.close();
});

for (const fault of ['exit', 'process-error', 'invalid-json', 'output-eof', 'input-error', 'output-error'] as const) {
  test(`fatal ${fault} exposes one owner failure and rejects pending requests`, async (t) => {
    const fake = fakeSpawn(standardHandler);
    const server = new CodexAppServer({ spawnProcess: fake.spawn });
    t.onTestFinished(() => server.close());
    await server.initialize();
    assert.ok(server.failure instanceof Promise);
    const rejected = assert.rejects(server.request('synthetic/pending', {}));
    if (fault === 'exit') fake.child().exit(7);
    else if (fault === 'process-error') fake.child().emit('error', new Error('synthetic process error'));
    else if (fault === 'output-eof') fake.child().stdout.end();
    else if (fault === 'input-error') fake.child().stdin.emit('error', new Error('synthetic input error'));
    else if (fault === 'output-error') fake.child().stdout.emit('error', new Error('synthetic output error'));
    else fake.child().stdout.write('not-json\n');
    const failure = await server.failure;
    await rejected;
    assert.match(failure.message, /Codex app-server|Invalid JSON/u);
    fake.child().emit('error', new Error('later failure must not replace the first'));
    assert.equal(await server.failure, failure);
    await assert.rejects(server.request('thread/start', {}), /app-server is closed/u);
  });
}

test('initialization failure notifies the owner even when spawn throws synchronously', async () => {
  let spawns = 0;
  const server = new CodexAppServer({
    spawnProcess: (() => { spawns += 1; throw new Error('synthetic spawn failure'); }) as SpawnProcess,
  });
  await assert.rejects(server.initialize(), /synthetic spawn failure/u);
  assert.ok(server.failure instanceof Promise);
  assert.match((await server.failure).message, /initialization failed/u);
  await assert.rejects(server.initialize(), /app-server is closed/u);
  assert.equal(spawns, 1);
  await server.close();
});

test('failure before turn/start acknowledges early notifications without an unhandled rejection', async (t) => {
  const fake = fakeSpawn((message, child) => {
    if (message.method === 'turn/start') {
      child.send({ method: 'item/started', params: {
        turnId: 'synthetic-unacknowledged-turn', item: { id: 'synthetic-item' },
      } });
    } else standardHandler(message, child);
  });
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  t.onTestFinished(() => server.close());
  const rejected = assert.rejects(server.startThread(threadOptions).startRun('synthetic input'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  fake.child().exit(7);
  assert.match((await server.failure).message, /exited with code 7/u);
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('ordinary RPC errors and intentional close do not request a worker restart', async () => {
  const fake = fakeSpawn((message, child) => {
    if (message.method === 'thread/start') {
      child.send({ id: message.id, error: { code: -32602, message: 'invalid synthetic request' } });
    } else standardHandler(message, child);
  });
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  let fatal = false;
  try {
    assert.ok(server.failure instanceof Promise);
    void server.failure.then(() => { fatal = true; });
    await server.initialize();
    await assert.rejects(server.startThread(threadOptions).ensure!(), /request failed: thread\/start/u);
  } finally {
    await server.close();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fatal, false);
  await assert.rejects(server.initialize(), /app-server is closed/u);
  assert.equal(fake.requests.filter((request) => request.method === 'initialize').length, 1);
});

test('command approval waits for an explicit handler decision without blocking protocol responses', async (t) => {
  const fake = fakeSpawn(standardHandler);
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  t.onTestFinished(() => server.close());
  let allow!: () => void;
  const decision = new Promise<void>((resolve) => { allow = resolve; });
  server.setApprovalHandler(async (request) => {
    assert.equal(request.id, 'approval-one');
    assert.equal(request.threadId, 'thread-one');
    assert.equal(request.turnId, 'turn-one');
    assert.equal(request.item?.command, 'git status');
    await decision;
    return { decision: 'accept', isAllowed: () => true };
  });
  await server.initialize();
  fake.child().send({ method: 'item/started', params: {
    threadId: 'thread-one', turnId: 'turn-one',
    item: { id: 'command-one', type: 'commandExecution', command: 'git status', cwd: '/workspace' },
  } });
  fake.child().send({ id: 'approval-one', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'command-one', command: 'git status', cwd: '/workspace',
  } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.requests.some((request) => request.id === 'approval-one'), false);
  await server.request('thread/read', { threadId: 'thread-one' });
  allow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.requests.find((request) => request.id === 'approval-one'), {
    id: 'approval-one', result: { decision: 'accept' },
  });
});

test('request ID zero can be reused after resolution without its old asynchronous handler answering the new request', async (t) => {
  const fake = fakeSpawn(standardHandler);
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  t.onTestFinished(() => server.close());
  const release: (() => void)[] = [];
  server.setApprovalHandler(async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return { decision: 'accept', isAllowed: () => true };
  });
  await server.initialize();
  const request = { id: 0, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'command-one',
  } };
  fake.child().send(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  fake.child().send({ method: 'serverRequest/resolved', params: { threadId: 'thread-one', requestId: 0 } });
  fake.child().send(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.requests.some((message) => message.id === 0), false);
  release[1]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.requests.filter((message) => message.id === 0), [{ id: 0, result: { decision: 'accept' } }]);
});

test('the last synchronous guard can revoke a decision before it reaches the wire', async (t) => {
  const fake = fakeSpawn(standardHandler);
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  t.onTestFinished(() => server.close());
  let allowed = true;
  server.setApprovalHandler(async () => {
    queueMicrotask(() => { allowed = false; });
    return { decision: 'accept', isAllowed: () => allowed };
  });
  await server.initialize();
  fake.child().send({ id: 0, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'command-one',
  } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.requests.find((message) => message.id === 0), { id: 0, result: { decision: 'cancel' } });
});

for (const method of ['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']) {
  test(`${method} stays explicitly unsupported rather than being treated as command approval`, async (t) => {
    const fake = fakeSpawn(standardHandler);
    const server = new CodexAppServer({ spawnProcess: fake.spawn });
    t.onTestFinished(() => server.close());
    server.setApprovalHandler(async () => { throw new Error('Unsupported request reached approval handling'); });
    await server.initialize();
    fake.child().send({ id: 0, method, params: { threadId: 'thread-one', turnId: 'turn-one' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((fake.requests.find((message) => message.id === 0)?.error as Record<string, unknown>)?.code, -32601);
  });
}

for (const event of ['resolved', 'completed', 'closed'] as const) {
  test(`a pending approval cannot grant after its request is ${event}`, async (t) => {
    const fake = fakeSpawn(standardHandler);
    const server = new CodexAppServer({ spawnProcess: fake.spawn });
    t.onTestFinished(() => server.close());
    let captured: AbortSignal | undefined;
    let allow!: () => void;
    const decision = new Promise<void>((resolve) => { allow = resolve; });
    server.setApprovalHandler(async (request) => {
      captured = request.signal;
      await decision;
      return { decision: 'accept', isAllowed: () => true };
    });
    await server.initialize();
    fake.child().send({ id: 81, method: 'item/fileChange/requestApproval', params: {
      threadId: 'thread-one', turnId: 'turn-one', itemId: 'file-one',
    } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(captured?.aborted, false);
    if (event === 'closed') await server.close();
    else fake.child().send(event === 'resolved'
      ? { method: 'serverRequest/resolved', params: { threadId: 'thread-one', requestId: 81 } }
      : { method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
    allow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(captured?.aborted, true);
    assert.equal(fake.requests.some((request) => request.id === 81), false);
  });
}

test('resume and read use persisted IDs and include full turn history', async () => {
  const fake = fakeSpawn(standardHandler);
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  const thread = server.resumeThread('thread-persisted', threadOptions);
  const run = await thread.startRun('continue');
  fake.child().send({
    method: 'turn/completed',
    params: { turn: { id: run.turnId, status: 'completed', items: [] } },
  });
  await run.completion;
  const history = await server.readThread('thread-persisted', { includeTurns: true });
  assert.deepEqual(history, { thread: { id: 'thread-resumed', turns: [] } });
  const resume = fake.requests.find((request) => request.method === 'thread/resume');
  const read = fake.requests.find((request) => request.method === 'thread/read');
  assert.equal((resume?.params as RpcMessage).threadId, 'thread-persisted');
  assert.deepEqual(read?.params, { threadId: 'thread-persisted', includeTurns: true });
  await server.close();
});

test('thread catalog distinguishes active, archived, and deleted IDs', async () => {
  const fake = fakeSpawn((message, child) => {
    if (message.method === 'initialize') {
      child.send({ id: message.id, result: { userAgent: 'mock' } });
    } else if (message.method === 'thread/list') {
      const params = message.params as RpcMessage;
      child.send({
        id: message.id,
        result: {
          data: params.archived
            ? [{ id: 'thread-archived' }]
            : [{ id: 'thread-active' }],
          nextCursor: null,
        },
      });
    }
  });
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  assert.equal(await server.getThreadState('thread-active'), 'active');
  assert.equal(await server.getThreadState('thread-archived'), 'archived');
  assert.equal(await server.getThreadState('thread-deleted'), 'missing');
  const list = fake.requests.find((request) => request.method === 'thread/list');
  assert.deepEqual(list?.params, {
    archived: false,
    useStateDbOnly: true,
    limit: 100,
    sourceKinds: [
      'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
      'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
    ],
  });
  await server.close();
});

test('failed and interrupted turn notifications reject completion and release active state', async () => {
  const fake = fakeSpawn(standardHandler);
  const warnings: string[] = [];
  const server = new CodexAppServer({
    spawnProcess: fake.spawn,
    logger: { warn(message) { warnings.push(message); } },
  });
  const thread = server.startThread(threadOptions);
  const notifyError = (turnId: string, codexErrorInfo: unknown): void => {
    fake.child().send({
      method: 'error',
      params: {
        threadId: 'thread-one', turnId, willRetry: true,
        error: {
          message: 'notification-secret-canary',
          additionalDetails: '/private/notification',
          codexErrorInfo,
        },
      },
    });
  };
  const complete = (turnId: string, status: string, codexErrorInfo?: unknown): void => {
    fake.child().send({
      method: 'turn/completed',
      params: {
        turn: {
          id: turnId, status,
          error: {
            message: 'completion-secret-canary',
            additionalDetails: '/private/completion',
            ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }),
          },
        },
      },
    });
  };
  const failed = await thread.startRun('first');
  notifyError(failed.turnId, { providerSecretCanary: { httpStatusCode: 418 } });
  notifyError(failed.turnId, { httpConnectionFailed: { httpStatusCode: 401 } });
  complete(failed.turnId, 'failed');
  await assert.rejects(
    failed.completion,
    (error: unknown) => error instanceof Error &&
      error.message === 'Codex turn ended with status failed: httpConnectionFailed (HTTP 401)' &&
      !/secret-canary|\/private/u.test(error.message),
  );
  assert.deepEqual(warnings, [
    '[codex] app-server error category=other; content suppressed',
    '[codex] app-server error category=httpConnectionFailed (HTTP 401); ' +
      'content suppressed',
  ]);
  assert.doesNotMatch(JSON.stringify(warnings), /secret-canary|providerSecretCanary|\/private/u);

  const interrupted = await thread.startRun('second');
  notifyError(interrupted.turnId, 'serverOverloaded');
  assert.equal(await thread.interrupt?.(), true);
  const interrupt = fake.requests.find((request) => request.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, {
    threadId: 'thread-one',
    turnId: interrupted.turnId,
  });
  complete(interrupted.turnId, 'interrupted');
  await assert.rejects(
    interrupted.completion,
    (error: unknown) => error instanceof Error &&
      error.message === 'Codex turn ended with status interrupted',
  );

  const future = await thread.startRun('third');
  notifyError(future.turnId, 'usageLimitExceeded');
  complete(future.turnId, 'failed', { futureProviderError: { raw: 'secret' } });
  await assert.rejects(
    future.completion,
    (error: unknown) => error instanceof Error &&
      error.message === 'Codex turn ended with status failed: other',
  );

  const malformed = await thread.startRun('fourth');
  complete(malformed.turnId, 'failed\nturn-secret-canary');
  await assert.rejects(
    malformed.completion,
    (error: unknown) => error instanceof Error &&
      error.message === 'Codex turn ended with status unknown',
  );
  assert.doesNotMatch(JSON.stringify(warnings), /secret-canary|\/private/u);
  await server.close();
});

test('illegal input rejects before turn/start is written', async () => {
  const fake = fakeSpawn(standardHandler);
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  const thread = server.startThread(threadOptions);
  await assert.rejects(
    thread.startRun(null as unknown as CodexInput),
    /map|iterable|undefined|null/iu,
  );
  assert.equal(fake.requests.some((request) => request.method === 'turn/start'), false);
  await server.close();
});
