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
  const fake = fakeSpawn((message, child) => {
    if (message.method === 'initialize') {
      child.send({
        id: message.id,
        error: { code: -32001, message: 'authentication rejected' },
      });
    }
  });
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  await assert.rejects(server.initialize(), (error: unknown) =>
    error instanceof Error && error.message === 'Codex app-server request failed: initialize' &&
    'code' in error && error.code === -32001
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
  const server = new CodexAppServer({ spawnProcess: fake.spawn });
  const thread = server.startThread(threadOptions);
  const failed = await thread.startRun('first');
  fake.child().send({
    method: 'turn/completed',
    params: {
      turn: {
        id: failed.turnId,
        status: 'failed',
        error: { message: 'model failed' },
      },
    },
  });
  await assert.rejects(failed.completion, /status failed/u);

  const interrupted = await thread.startRun('second');
  assert.equal(await thread.interrupt?.(), true);
  const interrupt = fake.requests.find((request) => request.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, {
    threadId: 'thread-one',
    turnId: interrupted.turnId,
  });
  fake.child().send({
    method: 'turn/completed',
    params: { turn: { id: interrupted.turnId, status: 'interrupted' } },
  });
  await assert.rejects(interrupted.completion, /status interrupted/u);
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
