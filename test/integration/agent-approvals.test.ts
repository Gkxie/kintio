import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';

import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { AgentTurnCancelledError } from '../../src/agent/runtime.ts';
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
    if (message.method === 'thread/start' || message.method === 'thread/resume') this.send({ id: message.id, result: { thread: { id: 'thread-one' } } });
    if (message.method === 'thread/read') this.send({ id: message.id, result: { thread: { id: 'thread-one', turns: [] } } });
    if (message.method === 'thread/list') this.send({ id: message.id, result: { data: [{ id: 'thread-one' }], nextCursor: null } });
    if (message.method === 'turn/start') {
      this.token = /<channel_tool_session>([^<]+)</u.exec(message.params.input[0].text)?.[1] || this.token;
      this.turnId = ++this.turns === 1 ? 'turn-one' : `turn-${this.turns}`;
      if (this.earlyApproval) this.ask();
      this.send({ id: message.id, result: { turn: { id: this.turnId } } });
    }
    if (message.method === 'turn/steer') {
      this.token = /<channel_tool_session>([^<]+)</u.exec(message.params.input[0].text)?.[1] || '';
      if (!this.holdSteer) this.send({ id: message.id, result: { turnId: this.wrongSteer ? 'wrong-turn' : this.turnId } });
    }
    if (message.method === 'turn/interrupt') {
      this.send({ id: message.id, result: {} });
      this.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: this.turnId, status: 'interrupted' } } });
    }
    if (this.completeCancellations && message.result?.decision === 'cancel') {
      const turnId = this.turnId;
      const finish = () => this.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: turnId, status: 'interrupted' } } });
      if (this.holdCancellation) this.releaseCancellation = finish;
      else finish();
    }
    done();
  } });
  exitCode: number | null = null;
  token = '';
  turnId = 'turn-one';
  turns = 0;
  wrongSteer = false;
  holdSteer = false;
  earlyApproval = false;
  completeCancellations = false;
  holdCancellation = false;
  releaseCancellation?: () => void;
  send(message: Message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean {
    if (this.exitCode === null) { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); }
    return true;
  }
  ask(params: Message = {}) {
    this.send({ id: 'approve-one', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-one', turnId: this.turnId, itemId: 'command-one',
      command: 'git status', cwd: '/synthetic/workspace', ...params,
    } });
  }
  decision(): string | undefined { return this.messages.find((message) => message.id === 'approve-one')?.result?.decision; }
}

async function harness(t: TestContext, options: { noticeFails?: boolean; approvalTimeoutMs?: number; access?: 'host' | 'restricted'; completeCancellations?: boolean } = {}) {
  const temporary = await createTempSqlite(t, { prefix: 'agent-approvals-' });
  const now = Date.now();
  const persistence = temporary.openPersistence();
  const store = persistence.core;
  const accounts = persistence.createIlinkStore();
  const secrets = new IlinkSecretBox(Buffer.alloc(32, 22).toString('base64url'));
  const sent: string[] = [];
  const errors: string[] = [];
  const executor = new IlinkSendExecutor({
    store, ilinkStore: accounts, secretBox: secrets,
    createClient: () => ({ async sendMessage(request) {
      sent.push(request.msg.item_list?.[0]?.text_item?.text || '');
      if (options.noticeFails) throw new Error('Uncertain synthetic send');
    } }),
  });
  const peer = new Peer();
  peer.completeCancellations = options.completeCancellations === true;
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
    logger: { info() {}, error(message) { errors.push(message); } },
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
  async function finish(content = 'The requested work finished.') {
    const result = await executor.execute('send_text', { session: peer.token, content });
    assert.equal(result.status, 'accepted');
    peer.send({ method: 'item/started', params: { turnId: peer.turnId, item: { id: 'delivery', type: 'mcpToolCall' } } });
    peer.send({ method: 'item/completed', params: { turnId: peer.turnId, item: {
      id: 'delivery', type: 'mcpToolCall', server: 'weixin_ilink', tool: 'send_text', status: 'completed', result: { structuredContent: result },
    } } });
    peer.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: peer.turnId, status: 'completed' } } });
  }
  t.onTestFinished(async () => {
    processor.setChannelEnabled('weixin_ilink', false);
    await processor.abort();
    await processor.close();
    await executor.waitForIdle();
  });
  return { store, accounts, agent, processor, executor, peer, owner, sent, secrets, register, ingest, ask, finish, temporary, persistence, errors, server };
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
    assert.equal(h.agent.pendingApproval('not-the-conversation', code), undefined);
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

test('an approval during a delivery-correction turn refreshes that exact active turn', async (t) => {
  const h = await harness(t);
  await h.processor.enqueue(h.ingest('Inspect the repository'));
  h.peer.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await until(() => h.peer.turnId === 'turn-2');
  h.peer.ask();
  await until(() => h.sent.length > 0);
  await tick();
  const code = /\/kintio approval ([A-F0-9]+) 1/u.exec(h.sent[0]!)![1]!;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  assert.equal(h.peer.messages.find((message) => message.method === 'turn/steer')?.params.expectedTurnId, 'turn-2');
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'accept');
});

test('a steering ACK for a different turn cannot approve the pending action', async (t) => {
  const h = await harness(t);
  const { code } = await h.ask();
  h.peer.wrongSteer = true;
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 1`));
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'cancel');
});

for (const cancellation of ['operator', 'timeout'] as const) {
  test(`${cancellation} cancellation followed by interrupted completion never retries the old task and does not swallow new instructions`, async (t) => {
    const h = await harness(t, { completeCancellations: true,
      ...(cancellation === 'timeout' ? { approvalTimeoutMs: 20 } : {}),
    });
    const { primary, code } = await h.ask();
    if (cancellation === 'operator') await h.processor.enqueue(h.ingest(`/kintio approval ${code} 3`));
    await until(() => h.store.getInbound(primary)?.status === 'suppressed' || h.peer.turns > 1);
    assert.equal(h.peer.turns, 1, 'a cancelled task must not enter the generic retry path');
    assert.equal(h.store.getInbound(primary)?.status, 'suppressed');
    const fresh = h.ingest('Now do a different task');
    await h.processor.enqueue(fresh);
    assert.equal(h.peer.turns, 2, h.errors.join('\n'));
    await h.finish();
    await h.processor.waitForIdle();
    assert.equal(h.store.getInbound(fresh)?.status, 'completed');
  });
}

test('an unknown approval code refuses authorization but refreshes the running task instead of breaking its reply window', async (t) => {
  const h = await harness(t);
  const primary = h.ingest('Inspect the repository');
  await h.processor.enqueue(primary);
  const oldToken = h.peer.token;
  const control = h.ingest('/kintio approval ABCDEF123456 1');
  await h.processor.enqueue(control);
  assert.equal(h.peer.messages.filter((message) => message.method === 'turn/steer').length, 1);
  assert.equal(h.peer.turns, 1);
  assert.equal(h.peer.decision(), undefined);
  assert.throws(() => h.store.getAgentSession(oldToken));
  assert.equal(h.store.getAgentSession(h.peer.token).boundaryInboxSeq, h.store.getInbound(control)?.inboxSeq);
  await h.finish();
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(primary)?.status, 'completed');
  assert.equal(h.store.getInbound(control)?.status, 'absorbed');
});

test('a recovered turn can accept an approval reply through the short admission queue and finish the renewed direction', async (t) => {
  const h = await harness(t);
  const primary = h.ingest('Inspect the repository');
  h.store.claimInbound({ messageKey: primary });
  const recovered = h.processor.recover(h.store.listRecoverableInbound('weixin_ilink'), { priority: 'low' });
  await until(() => h.peer.turns === 1);
  h.peer.ask();
  await until(() => h.sent.length > 0);
  await tick();
  const code = /\/kintio approval ([A-F0-9]+) 1/u.exec(h.sent[0]!)![1]!;
  const control = h.ingest(`/kintio approval ${code} 1`);
  await h.processor.enqueue(control);
  await until(() => h.peer.decision() !== undefined);
  assert.equal(h.peer.decision(), 'accept');
  assert.equal(h.peer.turns, 1);
  await h.finish();
  await recovered;
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(primary)?.status, 'completed');
  assert.equal(h.store.getInbound(control)?.status, 'absorbed');
});

test('a new instruction arriving before cancellation completes waits without being attached to the cancelled task', async (t) => {
  const h = await harness(t, { completeCancellations: true });
  h.peer.holdCancellation = true;
  const { primary, code } = await h.ask();
  await h.processor.enqueue(h.ingest(`/kintio approval ${code} 3`));
  await until(() => Boolean(h.peer.releaseCancellation));
  const fresh = h.ingest('A new independent instruction');
  const queued = h.processor.enqueue(fresh);
  await tick();
  assert.equal(h.peer.turns, 1);
  assert.equal(h.peer.messages.filter((message) => message.method === 'turn/steer').length, 1);
  h.peer.releaseCancellation!();
  await queued;
  assert.equal(h.peer.turns, 2, h.errors.join('\n'));
  assert.equal(h.store.getInbound(primary)?.status, 'suppressed');
  await h.finish();
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(fresh)?.status, 'completed');
});

test('an unknown approval code refreshes a delivery-correction turn without granting anything or starting a new task', async (t) => {
  const h = await harness(t);
  const primary = h.ingest('Inspect the repository');
  await h.processor.enqueue(primary);
  h.peer.send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await until(() => h.peer.turnId === 'turn-2');
  const control = h.ingest('/kintio approval ABCDEF123456 1');
  await h.processor.enqueue(control);
  assert.equal(h.peer.messages.find((message) => message.method === 'turn/steer')?.params.expectedTurnId, 'turn-2');
  assert.equal(h.peer.turns, 2);
  assert.equal(h.peer.decision(), undefined);
  await h.finish();
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(primary)?.status, 'completed');
  assert.equal(h.store.getInbound(control)?.status, 'absorbed');
});

test('an unconfirmed invalid-code refresh explicitly cancels the running task without retrying it', async (t) => {
  const h = await harness(t);
  const primary = h.ingest('Inspect the repository');
  await h.processor.enqueue(primary);
  h.peer.holdSteer = true;
  await h.processor.enqueue(h.ingest('/kintio approval ABCDEF123456 1'));
  assert.equal(h.store.getInbound(primary)?.status, 'suppressed');
  assert.equal(h.peer.turns, 1);
  assert.equal(h.peer.decision(), undefined);
  assert.ok(h.sent.some((content) => content.includes('running task was cancelled')));
  h.peer.holdSteer = false;
  const fresh = h.ingest('A new independent instruction');
  await h.processor.enqueue(fresh);
  assert.equal(h.peer.turns, 2, h.errors.join('\n'));
  await h.finish();
  await h.processor.waitForIdle();
  assert.equal(h.store.getInbound(fresh)?.status, 'completed');
});

test('transport failure while an approval is pending stays a failure rather than being treated as operator cancellation', async (t) => {
  const h = await harness(t);
  const { primary } = await h.ask();
  h.peer.stdout.end();
  assert.equal((await h.server.failure) instanceof AgentTurnCancelledError, false);
  await until(() => h.errors.length > 0);
  assert.notEqual(h.store.getInbound(primary)?.status, 'suppressed');
  assert.notEqual(h.store.getInbound(primary)?.errorMessage, 'agent_approval_cancelled');
  assert.equal(h.peer.decision(), undefined);
});
