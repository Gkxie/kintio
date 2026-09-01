import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { test } from 'vitest';

test('standalone login keeps a real Node process alive while waiting for a scan', async (t) => {
  const script = `
    import { runIlinkCliLogin } from './src/ilink/cli-login.ts';
    const control = {
      async begin() {
        return {
          offerId: 'qo_${'a'.repeat(20)}',
          qrContent: 'weixin://ilink/login/process-wait',
          expiresAt: Date.now() + 300000,
        };
      },
      async status() { return { status: 'waiting' }; },
      async cancel() { return true; },
      async close() {},
    };
    process.exitCode = await runIlinkCliLogin({
      config: {
        state: { databaseFile: '', lockFile: '' },
        ilink: {
          storageKey: '', storageKeyFile: '',
          baseUrl: 'https://ilinkai.weixin.qq.com/',
          apiTimeoutMs: 1, longPollTimeoutMs: 1, maxAccounts: 1,
        },
      },
      packageRoot: process.cwd(),
      stdout() {}, stdoutIsTTY: true, stdoutColumns: 200,
      signal: new AbortController().signal,
      openControl: async () => control,
    });
  `;
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    script,
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  t.onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, `standalone login exited early with ${child.exitCode}`);
  child.kill('SIGKILL');
  await exited;
});
