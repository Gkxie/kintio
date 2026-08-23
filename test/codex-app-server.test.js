import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { CodexAppServer } from '../src/services/codex-app-server.js';

class FakeCodexProcess extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.buffer = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.buffer += chunk.toString('utf8');
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line) onMessage(JSON.parse(line), this);
          newline = this.buffer.indexOf('\n');
        }
        callback();
      },
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('Codex app-server starts and steers one active turn over JSONL', async () => {
  const messages = [];
  let child;
  let spawnCall;
  const spawnProcess = (command, args, options) => {
    spawnCall = { command, args, options };
    child = new FakeCodexProcess((message, process) => {
      messages.push(message);
      if (message.method === 'initialize') {
        process.send({ id: message.id, result: { userAgent: 'mock' } });
      } else if (message.method === 'thread/start') {
        process.send({
          id: message.id,
          result: { thread: { id: 'thread-one' } },
        });
      } else if (message.method === 'turn/start') {
        process.send({
          id: message.id,
          result: {
            turn: { id: 'turn-one', status: 'inProgress', items: [] },
          },
        });
      } else if (message.method === 'turn/steer') {
        process.send({ id: message.id, result: { turnId: 'turn-one' } });
      }
    });
    return child;
  };
  const server = new CodexAppServer({
    codexPathOverride: '/mock/codex',
    env: { PATH: '/usr/bin' },
    config: { tools: { web_search: true } },
    configOverrides: ['mcp_servers={}'],
    spawnProcess,
    logger: { warn() {} },
  });
  const thread = server.startThread({
    model: 'gpt-test',
    modelReasoningEffort: 'low',
    workingDirectory: '/workspace',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });

  const run = await thread.startRun('first customer message');
  assert.equal(run.turnId, 'turn-one');
  assert.equal(thread.id, 'thread-one');
  child.send({
    method: 'item/started',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: { id: 'tool-before-steer', type: 'mcpToolCall' },
    },
  });
  child.send({
    method: 'item/completed',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: {
        id: 'tool-before-steer',
        type: 'mcpToolCall',
        server: 'wechat_kf',
        tool: 'send_text',
        arguments: { content: 'superseded reply' },
        status: 'completed',
        result: { content: [], structuredContent: { receipts: [] } },
      },
    },
  });
  assert.equal(
    await thread.steer('second customer message', {
      clientUserMessageId: 'wechat-message-two',
    }),
    'turn-one',
  );

  child.send({
    method: 'item/completed',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: {
        id: 'user-follow-up',
        type: 'userMessage',
        clientId: 'wechat-message-two',
        content: [],
      },
    },
  });
  child.send({
    method: 'item/started',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: { id: 'image-one', type: 'imageGeneration' },
    },
  });
  child.send({
    method: 'item/completed',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: {
        id: 'image-one',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'edit both images',
        result: 'aW1hZ2U=',
        failure: null,
        savedPath: '/tmp/generated_images/image-one.png',
      },
    },
  });
  child.send({
    method: 'item/started',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: { id: 'tool-one', type: 'mcpToolCall' },
    },
  });
  child.send({
    method: 'item/completed',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: {
        id: 'tool-one',
        type: 'mcpToolCall',
        server: 'wechat_kf',
        tool: 'send_text',
        arguments: { content: 'combined reply' },
        status: 'completed',
        result: {
          content: [],
          structuredContent: {
            receipts: [{ wecomMsgId: 'wechat-one', sentType: 'text' }],
          },
        },
      },
    },
  });
  child.send({
    method: 'item/completed',
    params: {
      threadId: 'thread-one',
      turnId: 'turn-one',
      item: {
        id: 'answer-one',
        type: 'agentMessage',
        text: 'done',
      },
    },
  });
  child.send({
    method: 'turn/completed',
    params: {
      threadId: 'thread-one',
      turn: {
        id: 'turn-one',
        status: 'completed',
        items: [],
        error: null,
      },
    },
  });

  const result = await run.completion;
  assert.equal(result.finalResponse, 'done');
  assert.equal(result.lastSteerSequence, 3);
  assert.equal(result.items[0].startedSequence, 1);
  assert.equal(result.items[1].type, 'userMessage');
  assert.equal(result.items[1].completedSequence, 3);
  assert.equal(result.items[2].type, 'imageGeneration');
  assert.equal(result.items[2].result, 'aW1hZ2U=');
  assert.equal(result.items[2].startedSequence, 4);
  assert.equal(result.items[3].startedSequence, 6);
  assert.equal(result.items[3].type, 'mcp_tool_call');
  assert.deepEqual(result.items[3].result.structured_content, {
    receipts: [{ wecomMsgId: 'wechat-one', sentType: 'text' }],
  });
  const startRequest = messages.find((message) => message.method === 'turn/start');
  const steerRequest = messages.find((message) => message.method === 'turn/steer');
  assert.deepEqual(startRequest.params.input, [
    { type: 'text', text: 'first customer message', text_elements: [] },
  ]);
  assert.equal(startRequest.params.model, 'gpt-test');
  assert.equal(startRequest.params.effort, 'low');
  assert.equal(startRequest.params.approvalPolicy, 'never');
  assert.equal(steerRequest.params.expectedTurnId, 'turn-one');
  assert.equal(steerRequest.params.clientUserMessageId, 'wechat-message-two');
  assert.equal(steerRequest.params.input[0].text, 'second customer message');
  assert.equal(spawnCall.command, '/mock/codex');
  assert.ok(spawnCall.args.includes('app-server'));
  assert.ok(spawnCall.args.includes('tools.web_search=true'));
  assert.ok(spawnCall.args.includes('mcp_servers={}'));
  assert.equal(spawnCall.options.env.PATH, '/usr/bin');

  await thread.close();
});
