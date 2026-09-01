import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { runIlinkCliLogin } from '../../src/ilink/cli-login.ts';
import type { IlinkLoginStatus } from '../../src/ilink/login-store.ts';

function config() {
  const root = path.join(os.tmpdir(), 'kintio-ilink-cli-config');
  return loadConfig({
    root,
    environment: {
      ILINK_ENABLED: 'true',
      KINTIO_CONFIG_FILE: path.join(root, 'missing.env'),
    },
  });
}

function control(statuses: IlinkLoginStatus[] = ['confirmed']) {
  const calls = { begin: 0, status: 0, cancel: 0, close: 0 };
  return {
    calls,
    value: {
      async begin() {
        calls.begin += 1;
        return {
          offerId: `qo_${'a'.repeat(20)}`,
          qrContent: 'weixin://ilink/login/terminal-test',
          expiresAt: 1_300_000,
        };
      },
      async status() {
        calls.status += 1;
        return { status: statuses.shift() || 'waiting' };
      },
      async cancel() {
        calls.cancel += 1;
        return true;
      },
      async close() { calls.close += 1; },
    },
  };
}

test('terminal login prints one QR, reports status changes, and hides its content', async () => {
  const fake = control(['waiting', 'scanned', 'scanned', 'confirmed']);
  const output: string[] = [];
  let now = 1_000_000;
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    clock: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    openControl: async () => fake.value,
  });
  assert.equal(result, 0);
  assert.deepEqual(fake.calls, { begin: 1, status: 4, cancel: 0, close: 1 });
  const text = output.join('');
  assert.match(text, /within 5 minutes/u);
  assert.equal(text.match(/QR scanned/gu)?.length, 1);
  assert.match(text, /login succeeded/u);
  assert.match(text, /[█▀▄]/u);
  assert.doesNotMatch(text, /weixin:\/\/|terminal-test/u);
});

test('an already-connected local account is a successful host authorization', async () => {
  const fake = control(['already_connected']);
  const output: string[] = [];
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    clock: () => 1_000_000,
    openControl: async () => fake.value,
  });
  assert.equal(result, 0);
  assert.match(output.join(''), /host authorization is confirmed/u);
});

test('terminal login refuses non-TTY before requesting an iLink offer', async () => {
  let opened = false;
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    openControl: async () => {
      opened = true;
      return control().value;
    },
  }), /interactive terminal/u);
  assert.equal(opened, false);
});

test('terminal login cancels a QR that cannot fit the terminal', async () => {
  const fake = control();
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: true,
    stdoutColumns: 10,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /Terminal is too narrow/u);
  assert.deepEqual(fake.calls, { begin: 1, status: 0, cancel: 1, close: 1 });
});

test('terminal login enforces the five-minute deadline and releases polling', async () => {
  const fake = control([]);
  const output: string[] = [];
  let now = 1_000_000;
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    clock: () => now,
    sleep: async () => { now = 1_300_000; },
    openControl: async () => fake.value,
  });
  assert.equal(result, 1);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.close, 1);
  assert.match(output.join(''), /expired/u);
});

test('Ctrl-C cancels the exact terminal offer and returns 130', async () => {
  const fake = control([]);
  const controller = new AbortController();
  const output: string[] = [];
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: controller.signal,
    clock: () => 1_000_000,
    sleep: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
    openControl: async () => fake.value,
  });
  assert.equal(result, 130);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.close, 1);
  assert.match(output.join(''), /cancelled/u);
});

test('confirmed enrollment wins a Ctrl-C cancellation race', async () => {
  const fake = control(['waiting', 'confirmed']);
  fake.value.cancel = async () => {
    fake.calls.cancel += 1;
    return false;
  };
  const controller = new AbortController();
  const output: string[] = [];
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: controller.signal,
    clock: () => 1_000_000,
    sleep: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
    openControl: async () => fake.value,
  });
  assert.equal(result, 0);
  assert.equal(fake.calls.cancel, 1);
  assert.match(output.join(''), /login succeeded/u);
  assert.doesNotMatch(output.join(''), /was cancelled/u);
});

test('confirmed enrollment wins a five-minute timeout race', async () => {
  const fake = control(['waiting', 'waiting', 'confirmed']);
  fake.value.cancel = async () => {
    fake.calls.cancel += 1;
    return false;
  };
  const output: string[] = [];
  let now = 1_000_000;
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    clock: () => now,
    sleep: async () => { now = 1_300_000; },
    openControl: async () => fake.value,
  });
  assert.equal(result, 0);
  assert.equal(fake.calls.cancel, 1);
  assert.match(output.join(''), /login succeeded/u);
  assert.doesNotMatch(output.join(''), /expired/u);
});

test('terminal control failure cancels the offer before surfacing the error', async () => {
  const fake = control([]);
  fake.value.status = async () => {
    fake.calls.status += 1;
    throw new Error('local control disconnected');
  };
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: true,
    stdoutColumns: 200,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /local control disconnected/u);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.close, 1);
});
