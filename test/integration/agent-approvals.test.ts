import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';

import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { normalizeIlinkInboundMessage } from '../../src/ilink/message.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey, type IlinkAccountKey } from '../../src/ilink/store-types.ts';
import { CodexAgent } from '../../src/services/codex-agent.ts';
import { CodexAppServer } from '../../src/services/codex-app-server.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

type Message = Record<string, any>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Synthetic approval did not settle');
    await tick();
  }
}

class Peer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Message[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(String(chunk)) as Message;
    this.messages.push(message);
    if (message.method === 'initialize') this.send({ id: message.id, result: {} });
    if (message.method === 'thread/start') this.send({ id: message.id, result: { thread: { id: 'thread-one' } } });
    if (message.method === 'turn/start') {
      this.token = /<channel_tool_session>([^<]+)</u.exec(message.params.input[0].text)?.[1] || '';
      if (this.earlyApproval) this.ask();
      this.send({ id: message.id, result: { turn: { id: 'turn-one' } } });
    }
    if (message.method === 'turn/steer') {
      this.token = /<channel_tool_session>([^<]+)</u.exec(message.params.input[0].text)?.[1] || '';
      if (!this.holdSteer) this.send({ id: message.id, result: { turnId: 'turn-one' } });
    }
    if (message.method === 'turn/interrupt') {
      this.send({ id: message.id, result: {} });
      this.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'interrupted' } } });
    }
    done();
  } });
  exitCode: number | null = null;
  token = '';
  holdSteer = false;
  earlyApproval = false;
  send(message: Message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean {
    if (this.exitCode === null) { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); }
    return true;
  }
  ask(params: Message = {}) {
    this.send({ id: 'approve-one', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-one', turnId: 'turn-one', itemId: 'command-one',
      command: 'git status', cwd: '/synthetic/workspace', ...params,
    } });
  }
  decision(): string | undefined { return this.messages.find((message) => message.id === 'approve-one')?.result?.decision; }
}

async function harness(t: TestContext, options: { noticeFails?: boolean; approvalTimeoutMs?: number; access?: 'host' | 'restricted' } = {}) {
  const temporary = await createTempSqlite(t, { prefix: 'agent-approvals-' });
  const now = Date.now();
  const persistence = temporary.openPersistence();
  const store = persistence.core;
  const accounts = persistence.createIlinkStore();
  const secrets = new IlinkSecretBox(Buffer.alloc(32, 22).toString('base64url'));
  const sent: string[] = [];
  const executor = new IlinkSendExecutor({
    store, ilinkStore: accounts, secretBox: secrets,
    createClient: () => ({ async sendMessage(request) {
      sent.push(request.msg.item_list?.[0]?.text_item?.text || '');
      if (options.noticeFails) throw new Error('Uncertain synthetic send');
    } }),
  });
  const peer = new Peer();
  const server = new CodexAppServer({ spawnProcess: () => peer, requestTimeoutMs: 25,
    ...(options.approvalTimeoutMs ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
  const agent = new CodexAgent({ codex: server, trustedCodex: server,
    config: { workingDirectory: temporary.directory, imageTempDirectory: temporary.directory, generatedImageDirectory: '' },
  });
  const processor = new ConversationProcessor({
    store, agent, agentAccess: () => options.access || 'host',
    approvals: {
      binding(record) {
        const account = accounts.getAccount(record.accountKey as IlinkAccountKey);
        return account?.status === 'active' && account.runtimeEnabled && account.ownerPeerId === record.peerId
          ? String(account.generation) : undefined;
      },
      notify: (record, content, signal) => executor.notifyApproval(record.messageKey, content, signal),
    },
    mediaGateway: { async resolveForCodex() { return []; } }, channel: { async kick() {} },
    logger: { info() {}, error() {} },
  });
  const cursors = new Map<string, string>();
  let sequence = 0;
  function register(label: string) {
    const botId = `${label}@im.bot`;
    const peerId = `${label}@im.wechat`;
    const accountKey = createIlinkAccountKey(botId);
    const registration = { providerAccountId: botId, ownerPeerId: peerId,
      now,
      baseUrl: 'https://ilinkai.weixin.qq.com/', agentAccess: options.access || 'host' as const,
      encryptedBotToken: secrets.seal(`synthetic-bot-token-${label}`, { secretKind: 'bot_token', accountId: accountKey, peerId, generation: 1 }),
    };
    accounts.registerAccount(registration);
    accounts.setRuntimeEnabled(accountKey, true);
    return { accountKey, botId, peerId, registration };
  }
  const owner = register('owner');
  function ingest(text: string, account = owner) {
    const index = ++sequence;
    const cursor = cursors.get(account.accountKey) || '';
    const nextCursor = `cursor-${index}`;
    const normalized = normalizeIlinkInboundMessage({
      message_id: index, seq: index, from_user_id: account.peerId, to_user_id: account.botId,
      message_type: 1, message_state: 2, create_time_ms: now + index,
      context_token: `synthetic-context-${index}`, item_list: [{ type: 1, text_item: { text } }],
    }, { accountKey: account.accountKey, botId: account.botId, ownerUserId: account.peerId }, { cursor, index: 0 });
    assert.ok(normalized);
    const generation = accounts.getAccount(account.accountKey)!.generation;
    const result = accounts.commitPollPage({
      accountKey: account.accountKey, expectedGeneration: generation, expectedCursor: cursor, nextCursor,
      messages: [{ message: normalized.message, secretGeneration: index,
        sealedContextToken: secrets.seal(normalized.facts.contextToken, {
          secretKind: 'context_token', accountId: account.accountKey, peerId: account.peerId, generation: index,
        }),
      }],
    });
    cursors.set(account.accountKey, nextCursor);
    return result.insertedMessageKeys[0]!;
  }
  async function ask() {
    const primary = ingest('Inspect the repository');
    await processor.enqueue(primary);
    peer.ask();
    await until(() => sent.length > 0 || peer.decision() !== undefined);
    await tick();
    return { primary, code: /\/kintio approval ([A-F0-9]+) 1/u.exec(sent[0] || '')?.[1] || '' };
  }
  t.onTestFinished(async () => {
    processor.setChannelEnabled('weixin_ilink', false);
    await processor.abort();
    await processor.close();
    await executor.waitForIdle();
  });
  return { store, accounts, agent, processor, executor, peer, owner, sent, secrets, register, ingest, ask, temporary, persistence };
}

test('approval reply renews the iLink capability before its wire decision and final MCP delivery', async (t) => {
  const h = await harness(t);
  const { primary, code } = await h.ask();
  assert.ok(code);
  const oldToken = h.peer.token;
  assert.equal(h.store.listMessageAttempts(primary)[0]?.source, 'agent_approval');
  assert.notEqual(h.store.getInbound(primary)?.status, 'completed');
  const reply = h.ingest(`/kintio approval ${code} 1`);
  await h.processor.enqueue(reply);
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'accept');
  assert.throws(() => h.store.getAgentSession(oldToken));
  assert.notEqual(h.peer.token, oldToken);
  assert.equal(h.store.getAgentSession(h.peer.token).boundaryInboxSeq, h.store.getInbound(reply)?.inboxSeq);
  const steer = h.peer.messages.findIndex((message) => message.method === 'turn/steer');
  const decision = h.peer.messages.findIndex((message) => message.id === 'approve-one');
  assert.ok(steer >= 0 && decision > steer);
  const result = await h.executor.execute('send_text', { session: h.peer.token, content: 'The approved action finished.' });
  h.peer.send({ method: 'item/started', params: { turnId: 'turn-one', item: { id: 'delivery', type: 'mcpToolCall' } } });
  h.peer.send({ method: 'item/completed', params: { turnId: 'turn-one', item: {
    id: 'delivery', type: 'mcpToolCall', server: 'weixin_ilink', tool: 'send_text', status: 'completed', result: { structuredContent: result },
  } } });
  h.peer.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(primary)?.status, 'completed');
  assert.equal(h.store.getInbound(reply)?.status, 'absorbed');
  assert.equal(h.sent.length, 2);
});

test('a different iLink account cannot answer a pending approval or wake a new Agent turn', async (t) => {
  const h = await harness(t);
  const { code } = await h.ask();
  const outsider = h.register('outsider');
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`, outsider));
  assert.equal(h.peer.decision(), undefined);
  assert.equal(h.peer.messages.filter((message) => message.method === 'turn/start').length, 1);
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 2`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'decline');
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  assert.equal(h.peer.messages.filter((message) => message.id === 'approve-one').length, 1);
});

for (const change of ['stop', 'delete', 'relogin'] as const) {
  test(`${change} invalidates the pending identity before its approval can be used`, async (t) => {
    const h = await harness(t);
    const { code } = await h.ask();
    if (change === 'stop') h.accounts.setRuntimeEnabled(h.owner.accountKey, false);
    else if (change === 'delete') h.accounts.deleteAccountCompletely(h.owner.accountKey);
    else h.accounts.rotateAccount({ ...h.owner.registration, accountKey: h.owner.accountKey, expectedGeneration: 1,
      encryptedBotToken: h.secrets.seal('rotated-token', { secretKind: 'bot_token', accountId: h.owner.accountKey, peerId: h.owner.peerId, generation: 2 }),
    });
    h.agent.invalidateApprovals();
    await until(() => h.peer.decision() !== undefined);
    assert.equal(h.peer.decision(), 'cancel');
    assert.equal(h.agent.hasApproval('not-the-conversation', code), false);
  });
}

test('unconfirmed steering cancels approval instead of deadlocking on the blocked Agent turn', async (t) => {
  const h = await harness(t);
  const { code } = await h.ask();
  h.peer.holdSteer = true;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
});

test('an approval timeout cancels without granting or waiting indefinitely', async (t) => {
  const h = await harness(t, { approvalTimeoutMs: 20 });
  await h.ask();
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
});

test('an uncertain approval notice cannot turn into a permission grant', async (t) => {
  const h = await harness(t, { noticeFails: true });
  const { primary } = await h.ask();
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
  assert.equal(h.store.listMessageAttempts(primary)[0]?.status, 'uncertain');
});

test('restricted conversations do not receive an approval capability', async (t) => {
  const h = await harness(t, { access: 'restricted' });
  await h.ask();
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
  assert.equal(h.sent.length, 0);
});

test('an oversized command is declined, not silently shortened into an approvable action', async (t) => {
  const h = await harness(t);
  await h.processor.enqueue(h.ingest('Inspect the repository'));
  h.peer.ask({ command: `echo ${'x'.repeat(2_100)}; unexpected-command` });
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'decline');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /complete approval preview/u);
  assert.doesNotMatch(h.sent[0]!, /\/kintio approval/u);
});

test('file approval presents the complete path and diff before requesting a decision', async (t) => {
  const h = await harness(t);
  await h.processor.enqueue(h.ingest('Edit the configuration'));
  h.peer.send({ method: 'item/started', params: { threadId: 'thread-one', turnId: 'turn-one', item: {
    id: 'file-one', type: 'fileChange', changes: [{ path: '/workspace/config.json', kind: { type: 'update', move_path: null }, diff: '- false\n+ true' }],
  } } });
  h.peer.send({ id: 'approve-one', method: 'item/fileChange/requestApproval', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'file-one',
  } });
  await until(() => h.sent.length > 0);
  await tick();
  assert.match(h.sent[0]!, /\/workspace\/config\.json[\s\S]*- false\n\+ true/u);
  const code = /\/kintio approval ([A-F0-9]+) 1/u.exec(h.sent[0]!)![1]!;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'accept');
});

test('the runtime operator stops an account and cancels its approval immediately while another account stays online', async (t) => {
  const seeded = await harness(t);
  seeded.register('other');
  seeded.persistence.close();
  const peer = new Peer();
  vi.resetModules();
  vi.doMock('cross-spawn', () => ({ default: () => peer }));
  t.onTestFinished(() => { vi.doUnmock('cross-spawn'); vi.resetModules(); });
  const { createRuntime } = await import('../../src/runtime.ts');
  const { loadSharedRuntimeConfig } = await import('../../src/config.ts');
  const { RuntimeOperatorClient } = await import('../../src/runtime/operator-client.ts');
  const config = loadSharedRuntimeConfig({ root: seeded.temporary.directory, environment: {
    KINTIO_DB_FILE: seeded.temporary.filePath,
    ILINK_STORAGE_KEY: Buffer.alloc(32, 22).toString('base64url'),
    CODEX_WORKING_DIRECTORY: path.join(seeded.temporary.directory, 'workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(seeded.temporary.directory, 'images'),
  } });
  let delivered = false;
  let notified = false;
  const stopped: string[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    const owner = request.headers.get('Authorization') === 'Bearer synthetic-bot-token-owner';
    if (url.pathname.endsWith('/notifystart')) return Response.json({ ret: 0 });
    if (url.pathname.endsWith('/notifystop')) {
      stopped.push(owner ? 'owner' : 'other');
      return Response.json({ ret: 0 });
    }
    if (url.pathname.endsWith('/sendmessage')) {
      notified = true;
      return Response.json({ ret: 0 });
    }
    assert.ok(url.pathname.endsWith('/getupdates'), `Unexpected synthetic request ${url.pathname}`);
    if (owner && !delivered) {
      delivered = true;
      return Response.json({ ret: 0, get_updates_buf: 'after-message', msgs: [{
        message_id: 91, seq: 91, from_user_id: seeded.owner.peerId, to_user_id: seeded.owner.botId,
        message_type: 1, message_state: 2, create_time_ms: Date.now() + 100,
        context_token: 'runtime-approval-window', item_list: [{ type: 1, text_item: { text: 'Inspect the repository' } }],
      }] });
    }
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal || request.signal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  let stoppedWorker = false;
  const runtime = await createRuntime({ config, logger: { info() {}, warn() {}, error() {} },
    onStopRequested: () => { stoppedWorker = true; },
  });
  t.onTestFinished(async () => { runtime.stopAccepting(); await runtime.abort(); await runtime.close(); });
  await runtime.start();
  await until(() => peer.messages.some((message) => message.method === 'turn/start'));
  peer.ask();
  await until(() => notified);
  const operator = await RuntimeOperatorClient.connect(config, path.resolve('.'));
  t.onTestFinished(() => operator.close());
  const target = (await operator.listAccounts()).find((account) => account.accountKey === seeded.owner.accountKey)!;
  const result = await operator.setAccountRuntime(target.accountKey, false, target);
  await until(() => peer.decision() !== undefined);
  assert.equal(peer.decision(), 'cancel');
  assert.equal(result.runningCount, 1);
  assert.equal(stoppedWorker, false);
  assert.deepEqual(stopped, ['owner']);
});

test('an approval before turn/start acknowledges its exact turn rather than being dropped or deadlocking', async (t) => {
  const h = await harness(t);
  h.peer.earlyApproval = true;
  await h.processor.enqueue(h.ingest('Inspect the repository'));
  await until(() => h.sent.length > 0);
  await tick();
  const code = /\/kintio approval ([A-F0-9]+) 1/u.exec(h.sent[0]!)![1]!;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'accept');
});

test('a newer inbound after steering ACK but before the decision write invalidates the refreshed capability', async (t) => {
  const h = await harness(t);
  const { code } = await h.ask();
  const respond = h.agent.respondApproval.bind(h.agent);
  h.agent.respondApproval = (...args) => {
    const result = respond(...args);
    h.ingest('a newer direction');
    return result;
  };
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
});

test('a changed file patch invalidates the preview already awaiting approval', async (t) => {
  const h = await harness(t);
  await h.processor.enqueue(h.ingest('Edit the configuration'));
  const change = { path: '/workspace/config.json', kind: { type: 'delete' }, diff: '- original' };
  h.peer.send({ method: 'item/started', params: { threadId: 'thread-one', turnId: 'turn-one', item: {
    id: 'file-one', type: 'fileChange', changes: [change],
  } } });
  h.peer.send({ id: 'approve-one', method: 'item/fileChange/requestApproval', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'file-one',
  } });
  await until(() => h.sent.length > 0);
  h.peer.send({ method: 'item/fileChange/patchUpdated', params: {
    threadId: 'thread-one', turnId: 'turn-one', itemId: 'file-one', changes: [{ ...change, path: '/workspace/other-file' }],
  } });
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
  const code = /\/kintio approval ([A-F0-9]+) 1/u.exec(h.sent[0]!)![1]!;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  assert.equal(h.peer.messages.filter((message) => message.id === 'approve-one').length, 1);
});
