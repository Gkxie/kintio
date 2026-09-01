import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, vi, type TestContext } from 'vitest';

import type {
  AgentCompletion,
  AgentInput,
} from '../../src/agent/runtime.ts';
import { createConfig } from '../../src/config.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { CodexAgent } from '../../src/services/codex-agent.ts';
import { McpIpcHost, type LocalMcpLaunches } from '../../src/mcp/ipc-host.ts';
import {
  findMcpDescriptorFile,
  operatorMcpInstanceKey,
  readMcpDescriptor,
} from '../../src/mcp/ipc-protocol.ts';
import { createRuntime } from '../../src/runtime.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface RuntimeAccountFixture {
  readonly name: string;
  readonly providerAccountId: string;
  readonly ownerPeerId: string;
  readonly accountKey: ReturnType<typeof createIlinkAccountKey>;
  readonly botToken: string;
  readonly contextToken: string;
  readonly initialCursor: string;
  readonly nextCursor: string;
  readonly agentAccess: 'restricted' | 'host';
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for active iLink runtime state');
}

async function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out during ${label}`)), 5_000).unref?.();
    }),
  ]);
}

function account(name: string): RuntimeAccountFixture {
  const providerAccountId = `runtime-${name}@im.bot`;
  return {
    name,
    providerAccountId,
    ownerPeerId: `owner-${name}@im.wechat`,
    accountKey: createIlinkAccountKey(providerAccountId),
    botToken: `encrypted-runtime-token-${name}`,
    contextToken: `encrypted-context-token-${name}`,
    initialCursor: `cursor-${name}-0`,
    nextCursor: `cursor-${name}-1`,
    agentAccess: name === 'one' ? 'host' : 'restricted',
  };
}

async function fixture(t: TestContext) {
  const temp = await createTempSqlite(t, {
    prefix: 'ilink-active-runtime-',
  });
  const storageKey = Buffer.alloc(32, 41).toString('base64url');
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeIlinkToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-ilink-runtime',
    WECOM_KF_SECRET: 'wecom-must-not-connect',
    WECOM_ALLOWED_USER_IDS: 'wm-unrelated-user',
    WECOM_DB_FILE: temp.filePath,
    CODEX_WORKING_DIRECTORY: `${temp.directory}/codex-workspace`,
    CODEX_IMAGE_TMP_DIR: `${temp.directory}/codex-images`,
    ILINK_ENABLED: 'true',
    ILINK_STORAGE_KEY: storageKey,
    ILINK_API_TIMEOUT_MS: '5000',
    ILINK_LONG_POLL_TIMEOUT_MS: '120000',
    ILINK_MAX_ACCOUNTS: '2',
  }, temp.directory);
  const accounts = [account('one'), account('two')];
  const persistence = temp.openPersistence();
  const ilink = persistence.createIlinkStore();
  const secrets = new IlinkSecretBox(storageKey);
  const now = Date.now() - 1_000;
  for (const value of accounts) {
    ilink.registerAccount({
      providerAccountId: value.providerAccountId,
      ownerPeerId: value.ownerPeerId,
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      encryptedBotToken: secrets.seal(value.botToken, {
        secretKind: 'bot_token',
        accountId: value.accountKey,
        peerId: value.ownerPeerId,
        generation: 1,
      }),
      agentAccess: value.agentAccess,
      now,
    });
    ilink.compareAndSetCursor({
      accountKey: value.accountKey,
      expectedGeneration: 1,
      expectedCursor: '',
      nextCursor: value.initialCursor,
      now: now + 1,
    });
  }
  persistence.close();
  return { temp, config, accounts };
}

test('active runtime restores iLink listeners, routes stdio MCP sends, and shuts down', async (t) => {
  const { temp, config, accounts } = await fixture(t);
  const reader = temp.open({ readOnly: true });
  let readerClosed = false;
  const closeReader = () => {
    if (readerClosed) return;
    readerClosed = true;
    try {
      reader.close();
    } catch (error: unknown) {
      if (
        typeof error !== 'object' || error === null ||
        !('code' in error) || error.code !== 'ERR_INVALID_STATE'
      ) throw error;
    }
  };
  const rawAccountSecrets = reader.prepare(`
    SELECT nonce, ciphertext, auth_tag FROM ilink_account_secrets
    ORDER BY account_key
  `).all();
  assert.equal(rawAccountSecrets.length, 2);
  for (const value of accounts) {
    assert.doesNotMatch(JSON.stringify(rawAccountSecrets), new RegExp(value.botToken, 'u'));
  }

  const submissions: Array<{
    readonly input: AgentInput;
    readonly completion: Deferred<AgentCompletion>;
  }> = [];
  vi.spyOn(CodexAgent.prototype, 'ensureThread').mockImplementation(
    async (conversationId) => `runtime-thread-${conversationId}`,
  );
  vi.spyOn(CodexAgent.prototype, 'submit').mockImplementation(async (input) => {
    assert.equal(input.mode, 'start');
    const completion = deferred<AgentCompletion>();
    submissions.push({ input, completion });
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `runtime-turn-${submissions.length}`,
      threadId: input.threadId,
      completion: completion.promise,
    };
  });

  const pollCount = new Map<string, number>();
  const pollCursors = new Map<string, string[]>();
  const abortedPolls = new Set<string>();
  const lifecycleStarts = new Set<string>();
  const lifecycleStops = new Set<string>();
  const sends: Array<{
    readonly authorization: string;
    readonly body: Record<string, unknown>;
  }> = [];
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    const authorization = request.headers.get('authorization') || '';
    const runtimeAccount = accounts.find(
      (value) => authorization === `Bearer ${value.botToken}`,
    );
    assert.ok(runtimeAccount, `unexpected or undecrypted iLink token for ${url.pathname}`);

    if (url.pathname === '/ilink/bot/msg/notifystart') {
      lifecycleStarts.add(runtimeAccount.botToken);
      return Response.json({ ret: 0 });
    }
    if (url.pathname === '/ilink/bot/msg/notifystop') {
      lifecycleStops.add(runtimeAccount.botToken);
      return Response.json({ ret: 0 });
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      const body = await request.json() as { get_updates_buf?: unknown };
      const cursors = pollCursors.get(runtimeAccount.botToken) || [];
      cursors.push(String(body.get_updates_buf || ''));
      pollCursors.set(runtimeAccount.botToken, cursors);
      const count = (pollCount.get(runtimeAccount.botToken) || 0) + 1;
      pollCount.set(runtimeAccount.botToken, count);
      if (count === 1) {
        return Response.json({
          ret: 0,
          get_updates_buf: runtimeAccount.nextCursor,
          msgs: [{
            message_id: runtimeAccount.name === 'one' ? 101 : 202,
            seq: runtimeAccount.name === 'one' ? 101 : 202,
            from_user_id: runtimeAccount.ownerPeerId,
            to_user_id: runtimeAccount.providerAccountId,
            create_time_ms: Date.now() + 1_000,
            message_type: IlinkMessageType.USER,
            message_state: IlinkMessageState.FINISH,
            context_token: runtimeAccount.contextToken,
            item_list: [{
              type: IlinkMessageItemType.TEXT,
              text_item: { text: `hello from ${runtimeAccount.name}` },
            }],
          }],
        });
      }
      const signal = init?.signal || request.signal;
      return await new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve(Response.json({
            ret: 0,
            get_updates_buf: runtimeAccount.nextCursor,
            msgs: [],
          }));
        }, 50);
        const abort = () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          abortedPolls.add(runtimeAccount.botToken);
          reject(signal.reason || new DOMException('aborted', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }

    if (url.pathname === '/ilink/bot/sendmessage') {
      sends.push({
        authorization,
        body: await request.json() as Record<string, unknown>,
      });
      return Response.json({ ret: 0 });
    }

    assert.fail(`Unexpected network request: ${request.method} ${request.url}`);
  });
  vi.stubGlobal('fetch', fetchImpl);

  const loggerMessages: string[] = [];
  const logger = {
    info: (message: string) => loggerMessages.push(message),
    warn: (message: string) => loggerMessages.push(message),
    error: (message: string) => loggerMessages.push(message),
  };
  let mcpLaunches: LocalMcpLaunches | undefined;
  const originalStart = McpIpcHost.prototype.start;
  const startSpy = vi.spyOn(McpIpcHost.prototype, 'start').mockImplementation(
    function (this: McpIpcHost) {
      return originalStart.call(this).then((launches) => {
        if (launches.ilink) mcpLaunches = launches;
        return launches;
      });
    },
  );
  t.onTestFinished(() => startSpy.mockRestore());
  const runtime = await createRuntime({ config, logger });
  const ilinkLaunch = mcpLaunches?.ilink;
  assert.ok(ilinkLaunch);
  const operatorDescriptor = findMcpDescriptorFile(
    path.dirname(config.state.lockFile),
    operatorMcpInstanceKey(config.state.lockFile),
  );
  const operatorLaunch = {
    command: process.execPath,
    args: [
      path.resolve('mcp-relay.ts'),
      '--descriptor',
      operatorDescriptor,
      '--route',
      'operator',
    ],
  };
  const agentDescriptor = ilinkLaunch.args[
    ilinkLaunch.args.indexOf('--descriptor') + 1
  ];
  assert.ok(agentDescriptor);
  assert.notEqual(agentDescriptor, operatorDescriptor);
  assert.notEqual(
    readMcpDescriptor(agentDescriptor).token,
    readMcpDescriptor(operatorDescriptor).token,
  );
  let shutDown = false;
  t.onTestFinished(async () => {
    closeReader();
    for (const submission of submissions) {
      submission.completion.reject(new Error('active runtime test cleanup'));
    }
    if (!shutDown) {
      await runtime.abort();
      await runtime.close();
    }
  });

  await bounded('runtime start', runtime.start());
  const operator = new Client({ name: 'active-ilink-operator-test', version: '1.0.0' });
  await bounded('operator MCP connect', operator.connect(new StdioClientTransport({
    command: operatorLaunch.command,
    args: operatorLaunch.args,
    stderr: 'pipe',
  })));
  assert.deepEqual(
    (await operator.listTools()).tools.map((tool) => tool.name),
    ['begin_login', 'login_status', 'cancel_login'],
  );
  await bounded('operator MCP close', operator.close());
  await bounded('second long poll', until(() => submissions.length === 2 &&
    accounts.every((value) => (pollCount.get(value.botToken) || 0) >= 2)));

  for (const value of accounts) {
    const cursors = pollCursors.get(value.botToken) || [];
    assert.deepEqual(cursors.slice(0, 2), [
      value.initialCursor,
      value.nextCursor,
    ]);
    assert.ok(cursors.slice(2).every((cursor) => cursor === value.nextCursor));
  }
  assert.deepEqual(
    [...lifecycleStarts].sort(),
    accounts.map((value) => value.botToken).sort(),
  );
  assert.deepEqual(
    submissions.map(({ input }) => input.channel),
    ['weixin_ilink', 'weixin_ilink'],
  );
  assert.deepEqual(
    Object.fromEntries(submissions.map(({ input }) => [
      input.message.text,
      input.agentAccess,
    ])),
    {
      'hello from one': 'host',
      'hello from two': 'restricted',
    },
  );
  assert.deepEqual(
    submissions.map(({ input }) => input.message.text).sort(),
    ['hello from one', 'hello from two'],
  );

  const committed = reader.prepare(`
    SELECT open_kfid, external_userid, status, deferred
    FROM inbound_messages WHERE channel = 'weixin_ilink'
    ORDER BY open_kfid
  `).all() as unknown as Array<{
    open_kfid: string;
    external_userid: string;
    status: string;
    deferred: number;
  }>;
  assert.equal(committed.length, 2);
  assert.ok(committed.every((row) => row.status === 'preparing' && row.deferred === 0));
  assert.deepEqual(
    reader.prepare(`
      SELECT cursor FROM ilink_accounts ORDER BY account_key
    `).all().map((row) => (row as { cursor: string }).cursor).sort(),
    accounts.map((value) => value.nextCursor).sort(),
  );
  const rawWindowSecrets = reader.prepare(`
    SELECT nonce, ciphertext, auth_tag FROM ilink_reply_window_secrets
    ORDER BY reply_window_id
  `).all();
  assert.equal(rawWindowSecrets.length, 2);
  for (const value of accounts) {
    assert.doesNotMatch(
      JSON.stringify(rawWindowSecrets),
      new RegExp(value.contextToken, 'u'),
    );
  }

  const mcp = new Client({ name: 'active-ilink-runtime-test', version: '1.0.0' });
  await bounded('MCP connect', mcp.connect(
    new StdioClientTransport({
      command: ilinkLaunch.command,
      args: [...ilinkLaunch.args],
      stderr: 'pipe',
    }),
  ));
  assert.deepEqual(
    (await mcp.listTools()).tools.map((tool) => tool.name),
    ['send_text', 'send_image'],
  );

  const attempts = new Map<string, string>();
  for (const value of accounts) {
    const submission = submissions.find(
      ({ input }) => input.message.text === `hello from ${value.name}`,
    );
    assert.ok(submission);
    const result = await bounded(`MCP send for ${value.name}`, mcp.callTool({
      name: 'send_text',
      arguments: {
        session: submission.input.toolSessionToken,
        content: `reply to ${value.name}`,
      },
    }));
    const receipt = result.structuredContent as {
      status?: unknown;
      attemptId?: unknown;
    };
    assert.equal(receipt.status, 'accepted');
    assert.match(String(receipt.attemptId), /^sa_[A-Za-z0-9_-]+$/u);
    attempts.set(value.name, String(receipt.attemptId));
    submission.completion.resolve({
      executedAttemptIds: [String(receipt.attemptId)],
    });
  }
  await bounded('MCP close', mcp.close());

  assert.equal(sends.length, 2);
  for (const value of accounts) {
    const sent = sends.find(
      ({ authorization }) => authorization === `Bearer ${value.botToken}`,
    );
    assert.ok(sent);
    const message = sent.body.msg as Record<string, unknown>;
    assert.equal(message.to_user_id, value.ownerPeerId);
    assert.equal(message.context_token, value.contextToken);
    assert.equal(
      ((message.item_list as Array<{ text_item?: { text?: string } }>)[0])
        ?.text_item?.text,
      `reply to ${value.name}`,
    );
  }

  await bounded('inbound completion', until(() => {
    const statuses = reader.prepare(`
      SELECT status FROM inbound_messages WHERE channel = 'weixin_ilink'
    `).all() as unknown as Array<{ status: string }>;
    return statuses.length === 2 && statuses.every((row) => row.status === 'completed');
  }));
  const storedAttempts = reader.prepare(`
    SELECT attempt_key, status, channel FROM send_attempts
    ORDER BY attempt_key
  `).all() as unknown as Array<{
    attempt_key: string;
    status: string;
    channel: string;
  }>;
  assert.deepEqual(
    storedAttempts.map((row) => row.attempt_key).sort(),
    [...attempts.values()].sort(),
  );
  assert.ok(storedAttempts.every(
    (row) => row.status === 'accepted' && row.channel === 'weixin_ilink',
  ));

  closeReader();
  runtime.stopAccepting();
  await bounded('runtime close', runtime.close());
  shutDown = true;
  assert.deepEqual([...abortedPolls].sort(), accounts.map((value) => value.botToken).sort());
  assert.deepEqual([...lifecycleStops].sort(), accounts.map((value) => value.botToken).sort());
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });
  await runtime.close();
  assert.equal(
    loggerMessages.some((message) => /Codex|network request/iu.test(message)),
    false,
  );
});
