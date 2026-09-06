import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import {
  readIlinkAccountSnapshot,
  runIlinkAccountCommand,
} from '../../src/ilink/cli-accounts.ts';
import type {
  IlinkOperatorAccount,
  IlinkOperatorControl,
} from '../../src/ilink/cli-login.ts';

const ACCOUNT_A: IlinkOperatorAccount = {
  accountKey: `ia_${'a'.repeat(40)}`,
  generation: 1,
  incarnation: `ii_${'a'.repeat(64)}`,
  providerAccountId: 'bot-a@im.bot',
  runtimeEnabled: true,
};
const ACCOUNT_B: IlinkOperatorAccount = {
  accountKey: `ia_${'b'.repeat(40)}`,
  generation: 2,
  incarnation: `ii_${'b'.repeat(64)}`,
  providerAccountId: 'bot-b@im.bot',
  runtimeEnabled: false,
};

function config(name: string) {
  const root = path.join(os.tmpdir(), name);
  return {
    state: {
      databaseFile: path.join(root, 'data/kintio.sqlite'),
      lockFile: path.join(root, 'data/kintio.lock'),
    },
    ilink: {},
  } as never;
}

function control({
  mode = 'standalone',
  accounts = [ACCOUNT_A],
}: {
  readonly mode?: 'runtime' | 'standalone';
  readonly accounts?: readonly IlinkOperatorAccount[];
} = {}) {
  const calls: string[] = [];
  const value: IlinkOperatorControl = {
    mode,
    async begin() { throw new Error('not used'); },
    async status() { throw new Error('not used'); },
    async cancel() { return false; },
    async listAccounts() {
      calls.push('list');
      return accounts;
    },
    async setAccountRuntime(accountKey, enabled, expected) {
      calls.push(`${enabled ? 'start' : 'stop'}:${accountKey}`);
      const source = accounts.find((account) => account.accountKey === accountKey)!;
      assert.deepEqual(expected, {
        generation: source.generation,
        incarnation: source.incarnation,
      });
      return {
        account: { ...source, runtimeEnabled: enabled },
        runningCount: enabled ? 1 : 0,
      };
    },
    async deleteAccount(accountKey, expected) {
      calls.push(`delete:${accountKey}`);
      const source = accounts.find((account) => account.accountKey === accountKey)!;
      assert.deepEqual(expected, {
        generation: source.generation,
        incarnation: source.incarnation,
      });
      return {
        account: { ...source, runtimeEnabled: false },
        runningCount: 0,
      };
    },
    async close() { calls.push('close'); },
  };
  return { calls, value };
}

test('account snapshots close operator control before returning to interactive code', async () => {
  const fake = control({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const snapshot = await readIlinkAccountSnapshot({
    config: config('kintio-snapshot'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  });
  assert.deepEqual(snapshot, {
    accounts: [ACCOUNT_A, ACCOUNT_B],
    mode: 'standalone',
  });
  assert.deepEqual(fake.calls, ['list', 'close']);
});

test('iLink list prints directly reusable provider account IDs only', async () => {
  for (const mode of ['standalone', 'runtime'] as const) {
    const fake = control({ mode, accounts: [ACCOUNT_A, ACCOUNT_B] });
    const output: string[] = [];
    const result = await runIlinkAccountCommand({
      command: 'list',
      config: config(`kintio-list-${mode}`),
      packageRoot: path.resolve('.'),
      signal: new AbortController().signal,
      stdout: (text) => output.push(text),
      openControl: async () => fake.value,
    });
    assert.equal(result.runtimeRequired, false);
    assert.equal(output.join(''), 'bot-a@im.bot\nbot-b@im.bot\n');
    assert.doesNotMatch(output.join(''), /ia_|running|stopped|"/u);
    assert.deepEqual(fake.calls, ['list', 'close']);
  }
});

test('one account is implicit and a provider ID selects one of many accounts', async () => {
  const single = control({ accounts: [ACCOUNT_A] });
  const started = await runIlinkAccountCommand({
    command: 'start',
    config: config('kintio-single-start'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
    openControl: async () => single.value,
  });
  assert.equal(started.runtimeRequired, true);
  assert.deepEqual(single.calls, ['list', `start:${ACCOUNT_A.accountKey}`, 'close']);

  const multiple = control({ mode: 'runtime', accounts: [ACCOUNT_A, ACCOUNT_B] });
  const stopped = await runIlinkAccountCommand({
    command: 'stop',
    selector: ACCOUNT_B.providerAccountId,
    config: config('kintio-multiple-stop'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
    openControl: async () => multiple.value,
  });
  assert.equal(stopped.runtimeRequired, false);
  assert.deepEqual(multiple.calls, ['list', `stop:${ACCOUNT_B.accountKey}`, 'close']);
});

test('a deferred standalone start selects an account without mutating it before daemon readiness', async () => {
  const fake = control({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const selected = await runIlinkAccountCommand({
    command: 'start',
    selector: ACCOUNT_B.providerAccountId,
    deferStandaloneStart: true,
    config: config('kintio-deferred-start'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
    openControl: async () => fake.value,
  });
  assert.deepEqual(selected, {
    runtimeRequired: true,
    runningCount: 0,
    selectedAccountKey: ACCOUNT_B.accountKey,
  });
  assert.deepEqual(fake.calls, ['list', 'close']);
});

test('multiple accounts require an exact selector and always close control', async () => {
  for (const selector of [undefined, 'missing-account']) {
    const fake = control({ accounts: [ACCOUNT_A, ACCOUNT_B] });
    await assert.rejects(() => runIlinkAccountCommand({
      command: 'start',
      ...(selector ? { selector } : {}),
      config: config(`kintio-selector-${selector || 'missing'}`),
      packageRoot: path.resolve('.'),
      signal: new AbortController().signal,
      stdout() {},
      openControl: async () => fake.value,
    }), selector ? /Unknown or ambiguous/u : /Multiple iLink accounts/u);
    assert.deepEqual(fake.calls, ['list', 'close']);
  }
});

test('iLink delete requires --yes before permanently deleting the selected account', async () => {
  const rejected = control();
  await assert.rejects(() => runIlinkAccountCommand({
    command: 'delete',
    config: config('kintio-delete-rejected'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
    openControl: async () => rejected.value,
  }), /permanently removes.*repeat with --yes/u);
  assert.deepEqual(rejected.calls, ['list', 'close']);

  const accepted = control();
  const output: string[] = [];
  await runIlinkAccountCommand({
    command: 'delete',
    confirmed: true,
    config: config('kintio-delete-accepted'),
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout: (text) => output.push(text),
    openControl: async () => accepted.value,
  });
  assert.deepEqual(accepted.calls, ['list', `delete:${ACCOUNT_A.accountKey}`, 'close']);
  assert.match(output.join(''), /Deleted "bot-a@im\.bot"/u);
});

test('stale generation, deletion, or same-key re-enrollment cannot mutate a new account', async () => {
  for (const [index, accounts] of [
    [{ ...ACCOUNT_A, generation: ACCOUNT_A.generation + 1 }],
    [{ ...ACCOUNT_A, incarnation: `ii_${'c'.repeat(64)}` as const }],
    [],
  ].entries()) {
    const fake = control({ accounts });
    await assert.rejects(() => runIlinkAccountCommand({
      command: 'delete',
      expectedAccount: ACCOUNT_A,
      confirmed: true,
      config: config(`kintio-stale-${index}`),
      packageRoot: path.resolve('.'),
      signal: new AbortController().signal,
      stdout() {},
      openControl: async () => fake.value,
    }), /selected iLink account changed/u);
    assert.deepEqual(fake.calls, ['list', 'close']);
  }
});

test('an abort after revision read cannot dispatch an account mutation', async () => {
  const controller = new AbortController();
  const fake = control({ accounts: [ACCOUNT_A] });
  const list = fake.value.listAccounts;
  fake.value.listAccounts = async () => {
    const accounts = await list();
    controller.abort();
    return accounts;
  };
  await assert.rejects(() => runIlinkAccountCommand({
    command: 'delete',
    expectedAccount: ACCOUNT_A,
    confirmed: true,
    config: config('kintio-aborted-mutation'),
    packageRoot: path.resolve('.'),
    signal: controller.signal,
    stdout() {},
    openControl: async () => fake.value,
  }), /abort/iu);
  assert.deepEqual(fake.calls, ['list', 'close']);
});

test('an absent database is an empty list and cannot start an account', async () => {
  const absent = config(`kintio-absent-${process.pid}-${Date.now()}`);
  const output: string[] = [];
  assert.deepEqual(await runIlinkAccountCommand({
    command: 'list',
    config: absent,
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout: (text) => output.push(text),
  }), { runtimeRequired: false, runningCount: 0 });
  assert.equal(output.join(''), 'No iLink accounts enrolled.\n');
  await assert.rejects(() => runIlinkAccountCommand({
    command: 'start',
    config: absent,
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
  }), /run "kintio ilink login" first/u);
});
