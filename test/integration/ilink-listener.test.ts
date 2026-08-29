import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  IlinkListenerManager,
  type IlinkListenerCommitInput,
  type IlinkListenerHost,
  type IlinkListenerRuntimeAccount,
  type IlinkPollClient,
} from '../../src/ilink/listener.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
  type IlinkGetUpdatesResponse,
  type IlinkMessage,
} from '../../src/ilink/protocol/types.ts';
import { IlinkProtocolError } from '../../src/ilink/protocol/client.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';

function account(
  name: string,
  overrides: Partial<IlinkListenerRuntimeAccount> = {},
): IlinkListenerRuntimeAccount {
  return {
    accountKey: createIlinkAccountKey(`${name}@im.bot`),
    providerAccountId: `${name}@im.bot`,
    ownerPeerId: `${name}@im.wechat`,
    generation: 1,
    cursor: `cursor-${name}-0`,
    botToken: `token-${name}`,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    ...overrides,
  };
}

function inbound(
  runtime: IlinkListenerRuntimeAccount,
  id: number,
  overrides: Partial<IlinkMessage> = {},
): IlinkMessage {
  return {
    message_id: id,
    seq: id,
    from_user_id: runtime.ownerPeerId,
    to_user_id: runtime.providerAccountId,
    create_time_ms: 1_700_000_000_000 + id,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    context_token: `context-${id}`,
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text: `message-${id}` },
    }],
    ...overrides,
  };
}

function abortingPoll(
  signal: AbortSignal | undefined,
  started?: () => void,
): Promise<IlinkGetUpdatesResponse> {
  started?.();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({});
      return;
    }
    signal?.addEventListener('abort', () => resolve({}), { once: true });
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Timed out waiting for listener condition');
}

function hostFor(
  accounts: () => readonly IlinkListenerRuntimeAccount[],
  commitPage: IlinkListenerHost['commitPage'] = (input) => ({
    insertedMessageKeys: input.candidates.map(
      (candidate) => candidate.providerMessageId,
    ),
    cursor: input.nextCursor,
  }),
  enqueue: IlinkListenerHost['enqueue'] = () => undefined,
): IlinkListenerHost {
  return {
    listActiveRuntimeAccounts: accounts,
    commitPage,
    enqueue,
  };
}

test('accounts poll in parallel while each account has one serial request', async () => {
  const accounts = [account('one'), account('two')];
  let active = 0;
  let maximumActive = 0;
  const perAccount = new Map<string, number>();

  const manager = new IlinkListenerManager({
    host: hostFor(() => accounts),
    createClient: (runtime): IlinkPollClient => ({
      getUpdates: async (_request, options) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        perAccount.set(
          runtime.accountKey,
          (perAccount.get(runtime.accountKey) ?? 0) + 1,
        );
        await abortingPoll(options?.signal);
        active -= 1;
        return {};
      },
    }),
  });

  await manager.start();
  await until(() => active === 2);
  assert.equal(maximumActive, 2);
  assert.deepEqual([...perAccount.values()].sort(), [1, 1]);
  await manager.close();
  assert.equal(active, 0);
});

test('a page commits and enqueues before the next poll without waiting on Agent work', async () => {
  const runtime = account('ordered', { cursor: '' });
  const events: string[] = [];
  const commits: IlinkListenerCommitInput[] = [];
  let polls = 0;
  const valid = inbound(runtime, 1);
  const wrongPeer = inbound(runtime, 2, { from_user_id: 'other@im.wechat' });
  const wrongBot = inbound(runtime, 3, { to_user_id: 'other@im.bot' });

  const manager = new IlinkListenerManager({
    host: hostFor(
      () => [runtime],
      (input) => {
        events.push('commit');
        commits.push(input);
        return { insertedMessageKeys: ['stored-one'], cursor: input.nextCursor };
      },
      (keys) => {
        events.push(`enqueue:${keys.join(',')}`);
      },
    ),
    createClient: (): IlinkPollClient => ({
      getUpdates: async (request, options) => {
        polls += 1;
        events.push(`poll:${request?.get_updates_buf}`);
        if (polls === 1) {
          return {
            msgs: [valid, wrongPeer, wrongBot],
            get_updates_buf: 'cursor-ordered-1',
          };
        }
        return abortingPoll(options?.signal);
      },
    }),
  });

  await manager.start();
  await until(() => polls === 2);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.expectedGeneration, runtime.generation);
  assert.equal(commits[0]?.expectedCursor, runtime.cursor);
  assert.equal(commits[0]?.nextCursor, 'cursor-ordered-1');
  assert.deepEqual(
    commits[0]?.candidates.map((candidate) => candidate.providerMessageId),
    ['message:1'],
  );
  assert.deepEqual(events.slice(0, 4), [
    'poll:',
    'commit',
    'enqueue:stored-one',
    'poll:cursor-ordered-1',
  ]);
  await manager.close();
});

test('close aborts an in-flight long poll and waitForIdle settles', async () => {
  const runtime = account('abort');
  let observedSignal: AbortSignal | undefined;
  const manager = new IlinkListenerManager({
    host: hostFor(() => [runtime]),
    createClient: (): IlinkPollClient => ({
      getUpdates: (_request, options) => {
        observedSignal = options?.signal;
        return abortingPoll(options?.signal);
      },
    }),
  });

  await manager.start();
  await until(() => observedSignal !== undefined);
  await manager.close();
  await manager.waitForIdle();
  assert.equal(observedSignal?.aborted, true);
});

test('an expired upstream session re-notifies start before polling again', async () => {
  const runtime = account('expired-session');
  let starts = 0;
  let polls = 0;
  const delays: number[] = [];
  const manager = new IlinkListenerManager({
    host: hostFor(() => [runtime]),
    createClient: () => ({
      async notifyStart() { starts += 1; return { ret: 0 }; },
      getUpdates(_request, options) {
        polls += 1;
        if (polls === 1) {
          throw new IlinkProtocolError('business', 'session expired', {
            errcode: -14,
          });
        }
        return abortingPoll(options?.signal);
      },
    }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  await manager.start();
  await until(() => starts === 2 && polls === 2);
  assert.deepEqual(delays, [250]);
  await manager.close();
});

test('account lifecycle notification brackets polling and remains fail-open', async () => {
  const runtime = account('lifecycle');
  const events: string[] = [];
  const logs: string[] = [];
  let observedSignal: AbortSignal | undefined;
  const manager = new IlinkListenerManager({
    host: hostFor(() => [runtime]),
    createClient: (): IlinkPollClient => ({
      async notifyStart() {
        events.push('start');
        throw new Error(`${runtime.botToken} start failed`);
      },
      getUpdates(_request, options) {
        events.push('poll');
        observedSignal = options?.signal;
        return abortingPoll(options?.signal);
      },
      async notifyStop() {
        events.push(`stop:${String(observedSignal?.aborted)}`);
        throw new Error(`${runtime.botToken} stop failed`);
      },
    }),
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });

  await manager.start();
  await until(() => events.includes('poll'));
  await manager.close();

  assert.deepEqual(events, ['start', 'poll', 'stop:true']);
  assert.deepEqual(logs, [
    '[ilink-listener] notifyStart failed; continuing',
    '[ilink-listener] notifyStop failed; ignored',
  ]);
  assert.equal(logs.some((message) => message.includes(runtime.botToken)), false);
});

test('poll failures use bounded backoff and logs never include runtime secrets', async () => {
  const runtime = account('private');
  const delays: number[] = [];
  const logs: string[] = [];
  let polls = 0;
  const manager = new IlinkListenerManager({
    host: hostFor(() => [runtime]),
    createClient: (): IlinkPollClient => ({
      getUpdates: (_request, options) => {
        polls += 1;
        if (polls <= 2) {
          throw new Error(
            `${runtime.accountKey} ${runtime.providerAccountId} ` +
            `${runtime.ownerPeerId} ${runtime.botToken}`,
          );
        }
        return abortingPoll(options?.signal);
      },
    }),
    backoffMinMs: 5,
    backoffMaxMs: 8,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });

  await manager.start();
  await until(() => polls === 3);
  assert.deepEqual(delays, [5, 8]);
  assert.equal(logs.length, 2);
  for (const log of logs) {
    assert.match(log, /^\[ilink-listener\] poll cycle failed; retry_ms=\d+$/u);
    for (const secret of [
      runtime.accountKey,
      runtime.providerAccountId,
      runtime.ownerPeerId,
      runtime.botToken,
    ]) {
      assert.doesNotMatch(log, new RegExp(secret, 'u'));
    }
  }
  await manager.close();
});

test('store fencing rejection ends the stale listener without enqueue or retry', async () => {
  const runtime = account('fenced');
  let polls = 0;
  let enqueues = 0;
  let sleeps = 0;
  const manager = new IlinkListenerManager({
    host: hostFor(
      () => [runtime],
      () => {
        throw Object.assign(new Error('stale generation'), {
          code: 'generation_conflict',
        });
      },
      () => {
        enqueues += 1;
      },
    ),
    createClient: (): IlinkPollClient => ({
      getUpdates: async () => {
        polls += 1;
        return {
          msgs: [inbound(runtime, 1)],
          get_updates_buf: 'cursor-fenced-1',
        };
      },
    }),
    sleep: async () => {
      sleeps += 1;
    },
  });

  await manager.start();
  await manager.waitForIdle();
  assert.equal(polls, 1);
  assert.equal(enqueues, 0);
  assert.equal(sleeps, 0);
  await manager.close();
});

test('a non-empty page without cursor progress backs off without committing', async () => {
  const runtime = account('no-progress');
  let polls = 0;
  let commits = 0;
  const delays: number[] = [];
  const manager = new IlinkListenerManager({
    host: hostFor(
      () => [runtime],
      () => {
        commits += 1;
        return { insertedMessageKeys: [], cursor: runtime.cursor };
      },
    ),
    createClient: (): IlinkPollClient => ({
      getUpdates: (_request, options) => {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve({
            msgs: [inbound(runtime, 1)],
            get_updates_buf: runtime.cursor,
          });
        }
        return abortingPoll(options?.signal);
      },
    }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  await manager.start();
  await until(() => polls === 2);
  assert.equal(commits, 0);
  assert.deepEqual(delays, [250]);
  await manager.close();
});

test('startup backlog becomes drainable only after the listener reaches an empty page', async () => {
  const runtime = account('backlog', { cursor: 'cursor-0' });
  let polls = 0;
  let ready = 0;
  const manager = new IlinkListenerManager({
    host: {
      listActiveRuntimeAccounts: () => [runtime],
      commitPage: (input) => ({ insertedMessageKeys: [], cursor: input.nextCursor }),
      enqueue() {},
      backlogReady() { ready += 1; },
    },
    createClient: (): IlinkPollClient => ({
      getUpdates: (_request, options) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({
          msgs: [inbound(runtime, 1)], get_updates_buf: 'cursor-1',
        });
        if (polls === 2) return Promise.resolve({
          msgs: [inbound(runtime, 2)], get_updates_buf: 'cursor-2',
        });
        if (polls === 3) return Promise.resolve({
          msgs: [], get_updates_buf: 'cursor-2',
        });
        return abortingPoll(options?.signal);
      },
    }),
  });
  await manager.start();
  await until(() => polls === 4);
  assert.equal(ready, 1);
  await manager.close();
});

test('one failing account does not permanently block healthy-account backlog readiness', async () => {
  const failing = account('failing');
  const healthy = account('healthy');
  let ready = 0;
  let healthyPolls = 0;
  const manager = new IlinkListenerManager({
    host: {
      listActiveRuntimeAccounts: () => [failing, healthy],
      commitPage: (input) => ({ insertedMessageKeys: [], cursor: input.nextCursor }),
      enqueue() {},
      backlogReady() { ready += 1; },
    },
    createClient: (runtime): IlinkPollClient => ({
      getUpdates: (_request, options) => {
        if (runtime.accountKey === failing.accountKey) {
          return Promise.reject(new Error('offline'));
        }
        healthyPolls += 1;
        return healthyPolls === 1
          ? Promise.resolve({ msgs: [], get_updates_buf: runtime.cursor })
          : abortingPoll(options?.signal);
      },
    }),
    sleep: async (_milliseconds, signal) => {
      await abortingPoll(signal);
    },
  });
  await manager.start();
  await until(() => ready === 1);
  await manager.close();
});

test('refresh aborts a replaced generation before starting its successor', async () => {
  let runtimes = [account('rotate')];
  const signals: AbortSignal[] = [];
  const lifecycle: string[] = [];
  let active = 0;
  let maximum = 0;
  const generations: number[] = [];
  const manager = new IlinkListenerManager({
    host: hostFor(() => runtimes),
    createClient: (runtime): IlinkPollClient => {
      generations.push(runtime.generation);
      return {
        async notifyStart() {
          lifecycle.push(`start:${runtime.generation}`);
          return { ret: 0 };
        },
        getUpdates: async (_request, options) => {
          const signal = options?.signal;
          assert.ok(signal);
          signals.push(signal);
          active += 1;
          maximum = Math.max(maximum, active);
          await abortingPoll(signal);
          active -= 1;
          return {};
        },
        async notifyStop() {
          lifecycle.push(`stop:${runtime.generation}`);
          return { ret: 0 };
        },
      };
    },
  });

  await manager.start();
  await until(() => active === 1);
  runtimes = [{
    ...runtimes[0]!,
    generation: 2,
    cursor: 'cursor-rotate-2',
    botToken: 'token-rotate-2',
  }];
  await manager.refresh();
  await until(() => generations.length === 2 && active === 1);
  assert.deepEqual(generations, [1, 2]);
  assert.deepEqual(lifecycle, ['start:1', 'stop:1', 'start:2']);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(maximum, 1);
  await manager.close();
});
