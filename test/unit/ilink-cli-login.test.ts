import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';

import { loadIlinkRuntimeConfig } from '../../src/config.ts';
import { runIlinkCliLogin } from '../../src/ilink/cli-login.ts';
import type { IlinkLoginStatus } from '../../src/ilink/login-store.ts';

function config() {
  const root = path.join(os.tmpdir(), 'kintio-ilink-cli-config');
  return loadIlinkRuntimeConfig({
    root,
    environment: {
      ILINK_ENABLED: 'true',
      KINTIO_CONFIG_FILE: path.join(root, 'missing.env'),
    },
  });
}

function temporaryQrOutput(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-cli-qr-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'login.png');
}

function control(statuses: IlinkLoginStatus[] = ['confirmed']) {
  const calls = { begin: 0, status: 0, cancel: 0, close: 0 };
  return {
    calls,
    value: {
      mode: 'standalone' as const,
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
      async listAccounts() { return []; },
      async setAccountRuntime() {
        throw new Error('not used by login tests');
      },
      async deleteAccount() {
        throw new Error('not used by login tests');
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

test('explicit QR output supports non-TTY login and removes the private PNG', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const fake = control(['confirmed']);
  const originalStatus = fake.value.status;
  let observedFile = false;
  fake.value.status = async () => {
    const bytes = fs.readFileSync(qrOutputPath);
    observedFile = bytes.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(qrOutputPath).mode & 0o777, 0o600);
    }
    return originalStatus();
  };
  const output: string[] = [];
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    clock: () => 1_000_000,
    openControl: async () => fake.value,
  });
  assert.equal(result, 0);
  assert.equal(observedFile, true);
  assert.equal(fs.existsSync(qrOutputPath), false);
  assert.match(output.join(''), /Temporary QR image/u);
  assert.match(output.join(''), /file will be removed/u);
  assert.doesNotMatch(output.join(''), /[█▀▄]|weixin:\/\/|terminal-test/u);
});

test('explicit QR output never overwrites an existing file or requests an offer', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  fs.writeFileSync(qrOutputPath, 'keep-me');
  let opened = false;
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => {
      opened = true;
      return control().value;
    },
  }), /already exists/u);
  assert.equal(opened, false);
  assert.equal(fs.readFileSync(qrOutputPath, 'utf8'), 'keep-me');
});

test('explicit QR output rejects a missing parent before requesting an offer', async (t) => {
  const qrOutputPath = path.join(
    path.dirname(temporaryQrOutput(t)),
    'missing',
    'login.png',
  );
  let opened = false;
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => {
      opened = true;
      return control().value;
    },
  }), /parent does not exist/u);
  assert.equal(opened, false);
});

test('explicit QR output requires an absolute path with a regular parent', async (t) => {
  const parentFile = temporaryQrOutput(t);
  fs.writeFileSync(parentFile, 'not-a-directory');
  for (const [qrOutputPath, expected] of [
    ['relative.png', /must be absolute/u],
    [path.join(parentFile, 'login.png'), /not a regular directory/u],
  ] as const) {
    let opened = false;
    await assert.rejects(() => runIlinkCliLogin({
      config: config(),
      packageRoot: path.resolve('.'),
      stdout() {},
      stdoutIsTTY: false,
      stdoutColumns: 0,
      qrOutputPath,
      signal: new AbortController().signal,
      openControl: async () => {
        opened = true;
        return control().value;
      },
    }), expected);
    assert.equal(opened, false);
  }
});

test('explicit QR output cleans a partial file when writing fails', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const fake = control();
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('simulated QR write failure');
  });
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /simulated QR write failure/u);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fs.existsSync(qrOutputPath), false);
});

test('explicit QR output cleans its file when file identity inspection fails', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const fake = control();
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce(() => {
    throw new Error('simulated QR identity failure');
  });
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /simulated QR identity failure/u);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fs.existsSync(qrOutputPath), false);
});

test('explicit QR output cleans its file when the first close fails', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const fake = control();
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(() => {
    throw new Error('simulated QR close failure');
  });
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /simulated QR close failure/u);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fs.existsSync(qrOutputPath), false);
});

test('QR cleanup is idempotent when the temporary file is already absent', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const fake = control(['confirmed']);
  const originalStatus = fake.value.status;
  fake.value.status = async () => {
    fs.unlinkSync(qrOutputPath);
    return originalStatus();
  };
  assert.equal(await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    clock: () => 1_000_000,
    openControl: async () => fake.value,
  }), 0);
  assert.equal(fs.existsSync(qrOutputPath), false);
});

test('QR cleanup refuses to delete a replacement file', async (t) => {
  const qrOutputPath = temporaryQrOutput(t);
  const replacementPath = path.join(path.dirname(qrOutputPath), 'replacement.png');
  fs.writeFileSync(replacementPath, 'replacement');
  const fake = control(['confirmed']);
  const originalStatus = fake.value.status;
  fake.value.status = async () => {
    if (process.platform === 'win32') fs.unlinkSync(qrOutputPath);
    fs.renameSync(replacementPath, qrOutputPath);
    return originalStatus();
  };
  await assert.rejects(() => runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout() {},
    stdoutIsTTY: false,
    stdoutColumns: 0,
    qrOutputPath,
    signal: new AbortController().signal,
    clock: () => 1_000_000,
    openControl: async () => fake.value,
  }), /was replaced and was not removed/u);
  assert.equal(fs.readFileSync(qrOutputPath, 'utf8'), 'replacement');
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

test('terminal login enforces the five-minute deadline and releases polling', async (t) => {
  const fake = control([]);
  const output: string[] = [];
  const qrOutputPath = temporaryQrOutput(t);
  let now = 1_000_000;
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    qrOutputPath,
    signal: new AbortController().signal,
    clock: () => now,
    sleep: async () => { now = 1_300_000; },
    openControl: async () => fake.value,
  });
  assert.equal(result, 1);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.close, 1);
  assert.match(output.join(''), /expired/u);
  assert.equal(fs.existsSync(qrOutputPath), false);
});

test('Ctrl-C cancels the exact terminal offer and returns 130', async (t) => {
  const fake = control([]);
  const controller = new AbortController();
  const output: string[] = [];
  const qrOutputPath = temporaryQrOutput(t);
  const result = await runIlinkCliLogin({
    config: config(),
    packageRoot: path.resolve('.'),
    stdout: (text) => output.push(text),
    stdoutIsTTY: true,
    stdoutColumns: 200,
    qrOutputPath,
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
  assert.equal(fs.existsSync(qrOutputPath), false);
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

test('terminal control failure cancels the offer before surfacing the error', async (t) => {
  const fake = control([]);
  const qrOutputPath = temporaryQrOutput(t);
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
    qrOutputPath,
    signal: new AbortController().signal,
    openControl: async () => fake.value,
  }), /local control disconnected/u);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.close, 1);
  assert.equal(fs.existsSync(qrOutputPath), false);
});
