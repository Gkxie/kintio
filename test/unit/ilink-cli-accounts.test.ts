import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { runIlinkAccountCommand } from '../../src/ilink/cli-accounts.ts';
import type {
  IlinkOperatorAccount,
  IlinkOperatorControl,
} from '../../src/ilink/cli-login.ts';

const ACCOUNT_A: IlinkOperatorAccount = {
  accountKey: `ia_${'a'.repeat(40)}`,
  providerAccountId: 'bot-a@im.bot',
  runtimeEnabled: true,
};
const ACCOUNT_B: IlinkOperatorAccount = {
  accountKey: `ia_${'b'.repeat(40)}`,
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
    async setAccountRuntime(accountKey, enabled) {
      calls.push(`${enabled ? 'start' : 'stop'}:${accountKey}`);
      const source = accounts.find((account) => account.accountKey === accountKey)!;
      return {
        account: { ...source, runtimeEnabled: enabled },
        runningCount: enabled ? 1 : 0,
      };
    },
    async deleteAccount(accountKey) {
      calls.push(`delete:${accountKey}`);
      const source = accounts.find((account) => account.accountKey === accountKey)!;
      return {
        account: { ...source, runtimeEnabled: false },
        runningCount: 0,
      };
    },
    async close() { calls.push('close'); },
  };
  return { calls, value };
}

test('iLink list reports physical runtime state and closes its control', async () => {
  for (const [mode, expected] of [
    ['standalone', /bot-a@im\.bot.*\[stopped\]/u],
    ['runtime', /bot-a@im\.bot.*\[running\]/u],
  ] as const) {
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
    assert.equal(result.startForeground, false);
    assert.match(output.join(''), expected);
    assert.match(output.join(''), /bot-b@im\.bot.*\[stopped\]/u);
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
  assert.equal(started.startForeground, true);
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
  assert.equal(stopped.startForeground, false);
  assert.deepEqual(multiple.calls, ['list', `stop:${ACCOUNT_B.accountKey}`, 'close']);
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

test('an absent database is an empty list and cannot start an account', async () => {
  const absent = config(`kintio-absent-${process.pid}-${Date.now()}`);
  const output: string[] = [];
  assert.deepEqual(await runIlinkAccountCommand({
    command: 'list',
    config: absent,
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout: (text) => output.push(text),
  }), { startForeground: false, runningCount: 0 });
  assert.equal(output.join(''), 'No iLink accounts enrolled.\n');
  await assert.rejects(() => runIlinkAccountCommand({
    command: 'start',
    config: absent,
    packageRoot: path.resolve('.'),
    signal: new AbortController().signal,
    stdout() {},
  }), /run "kintio ilink login" first/u);
});
