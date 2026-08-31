import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'vitest';

import {
  CodexAppServer,
  type SpawnProcess,
} from '../../src/services/codex-app-server.ts';

type RpcMessage = Record<string, unknown>;

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  killedWith: NodeJS.Signals | null = null;
  #buffer = '';

  constructor(onMessage: (message: RpcMessage, process: FakeCodexProcess) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#buffer += chunk.toString();
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line) onMessage(JSON.parse(line) as RpcMessage, this);
          newline = this.#buffer.indexOf('\n');
        }
        callback();
      },
    });
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(value: string): void {
    this.stdout.write(`${value}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return true;
    this.killedWith = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('app-server starts, steers, preserves the UserMessage boundary, and releases turn state', async () => {
  const requests: RpcMessage[] = [];
  let child!: FakeCodexProcess;
  const spawnProcess = ((command: string, args: readonly string[], options: unknown) => {
    assert.equal(command, 'codex');
    assert.ok(args.includes('app-server'));
    assert.deepEqual(options, { stdio: ['pipe', 'pipe', 'pipe'] });
    child = new FakeCodexProcess((message, process) => {
      requests.push(message);
      if (message.method === 'initialize') {
        process.send({ id: message.id, result: { userAgent: 'mock' } });
      } else if (message.method === 'thread/start') {
        process.send({ id: message.id, result: { thread: { id: 'thread-one' } } });
      } else if (message.method === 'turn/start') {
        process.send({ id: message.id, result: { turn: { id: 'turn-one' } } });
      } else if (message.method === 'turn/steer') {
        process.send({ id: message.id, result: { turnId: 'turn-one' } });
      } else if (message.method === 'thread/delete') {
        process.send({ id: message.id, result: {} });
      }
    });
    return child as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  const server = new CodexAppServer({
    configOverrides: ['tools.web_search=true', 'mcp_servers={}'],
    spawnProcess,
    logger: { warn() {} },
  });
  const thread = server.startThread({
    developerInstructions: 'fixed channel policy',
    workingDirectory: '/workspace',
    approvalPolicy: 'never',
  });
  const run = await thread.startRun('first customer message');
  child.send({
    method: 'item/started',
    params: {
      turnId: 'turn-one',
      item: { id: 'old-tool', type: 'mcpToolCall' },
    },
  });
  child.send({
    method: 'item/completed',
    params: {
      turnId: 'turn-one',
      item: {
        id: 'old-tool', type: 'mcpToolCall', server: 'wechat_kf',
        tool: 'send_text', status: 'completed',
        result: {
          structuredContent: {
            status: 'accepted', attemptId: 'attempt-old', type: 'text', sendIndex: 0,
          },
        },
      },
    },
  });
  await thread.steer('second customer message', {
    clientUserMessageId: 'wechat-message-two',
  });
  child.send({
    method: 'item/completed',
    params: {
      turnId: 'turn-one',
      item: { id: 'user-two', type: 'userMessage', clientId: 'wechat-message-two' },
    },
  });
  child.send({
    method: 'item/started',
    params: { turnId: 'turn-one', item: { id: 'final-tool', type: 'mcpToolCall' } },
  });
  child.send({
    method: 'item/completed',
    params: {
      turnId: 'turn-one',
      item: {
        id: 'final-tool', type: 'mcpToolCall', server: 'wechat_kf',
        tool: 'send_text', status: 'completed',
        result: {
          structuredContent: {
            status: 'accepted', attemptId: 'attempt-final', type: 'text', sendIndex: 0,
          },
        },
      },
    },
  });
  child.send({
    method: 'turn/completed',
    params: { turn: { id: 'turn-one', status: 'completed', items: [] } },
  });

  const result = await run.completion;
  assert.equal(result.lastSteerSequence, 3);
  assert.equal(result.items[0]?.type, 'mcpToolCall');
  assert.equal(result.items[1]?.type, 'userMessage');
  assert.equal(result.items[2]?.startedSequence, 4);
  const internals = server as unknown as { '#turns'?: Map<string, unknown> };
  assert.equal(internals['#turns'], undefined, 'native private state is not externally exposed');

  const start = requests.find((message) => message.method === 'turn/start');
  const threadStart = requests.find((message) => message.method === 'thread/start');
  const steer = requests.find((message) => message.method === 'turn/steer');
  assert.equal('model' in (start?.params as RpcMessage), false);
  assert.equal('effort' in (start?.params as RpcMessage), false);
  assert.equal(
    (threadStart?.params as RpcMessage).developerInstructions,
    'fixed channel policy',
  );
  assert.equal((steer?.params as RpcMessage).clientUserMessageId, 'wechat-message-two');
  await server.deleteThread('thread-one');
  assert.equal(
    (requests.find((message) => message.method === 'thread/delete')?.params as RpcMessage)
      .threadId,
    'thread-one',
  );
  await server.close();
});

test('invalid JSON suppresses raw input and terminates the child process', async () => {
  let child!: FakeCodexProcess;
  const spawnProcess = (() => {
    child = new FakeCodexProcess((message, process) => {
      if (message.method === 'initialize') {
        process.sendRaw('{"invalid-secret-canary"');
      }
    });
    return child as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
  const server = new CodexAppServer({ spawnProcess });
  await assert.rejects(
    server.initialize(),
    (error: unknown) => error instanceof Error &&
      error.message === 'Invalid JSON from Codex app-server' &&
      !error.message.includes('invalid-secret-canary'),
  );
  await server.close();
  assert.equal(child.killedWith, 'SIGTERM');
});
