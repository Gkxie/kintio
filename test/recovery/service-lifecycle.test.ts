import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { startTestChild } from '../support/child-process.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

const indexFile = fileURLToPath(new URL('../../index.ts', import.meta.url));

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForResponse(
  port: number,
  pathname: string,
  timeoutMs = 10_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}${pathname}`, {
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error(
    `Service did not answer ${pathname}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function assertPortReleased(port: number): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForPortReleased(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertPortReleased(port);
      return;
    } catch (error: unknown) {
      lastError = error;
      await delay(20);
    }
  }
  throw lastError;
}

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid!, signal);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

test('outer service answers hello then SIGTERM releases its port and lock', async (t) => {
  const servicePort = await availablePort();
  await waitForPortReleased(servicePort);
  const temporary = await createTempSqlite(t, {
    prefix: 'wechat-service-lifecycle-',
    filename: 'wecom.sqlite',
  });
  const lockFile = path.join(temporary.directory, 'wecom.lock');
  const child = startTestChild(t, indexFile, {
    timeoutMs: 8_000,
    env: {
      PORT: String(servicePort),
      WECOM_CALLBACK_TOKEN: 'LifecycleToken123',
      WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      WECOM_CORP_ID: '',
      WECOM_KF_SECRET: '',
      WECOM_ALLOWED_USER_IDS: '',
      WECOM_DB_FILE: temporary.filePath,
      CODEX_ENABLED: 'false',
      SHUTDOWN_TIMEOUT_MS: '2000',
    },
  });

  const root = await waitForResponse(servicePort, '/');
  assert.equal(root.status, 200);
  assert.equal(await root.text(), 'hello world');
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });

  assert.deepEqual(await child.stop('SIGTERM'), { code: 0, signal: null });
  await waitForPortReleased(servicePort);
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
  assert.match(child.output().stdout, new RegExp(`Hono server is listening on port ${servicePort}`, 'u'));
  assert.match(child.output().stdout, /Received SIGTERM; shutting down/u);
});

test('pnpm start builds and runs dist/index.js', async (t) => {
  const servicePort = await availablePort();
  await assertPortReleased(servicePort);
  const temporary = await createTempSqlite(t, {
    prefix: 'wechat-pnpm-start-',
    filename: 'wecom.sqlite',
  });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(servicePort),
    WECOM_CALLBACK_TOKEN: 'LifecycleToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: '',
    WECOM_KF_SECRET: '',
    WECOM_ALLOWED_USER_IDS: '',
    WECOM_DB_FILE: temporary.filePath,
    CODEX_ENABLED: 'false',
    SHUTDOWN_TIMEOUT_MS: '2000',
  };
  const child = spawn('pnpm', ['start'], {
    cwd: path.resolve('.'),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  t.onTestFinished(() => {
    if (child.exitCode !== null) return;
    signalProcessTree(child, 'SIGKILL');
  });

  assert.equal((await waitForResponse(servicePort, '/')).status, 200);
  assert.match(output, /node dist\/index\.js/u);
  signalProcessTree(child, 'SIGTERM');
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.equal(
    (exit.code === 0 && exit.signal === null) ||
      (exit.code === null && exit.signal === 'SIGTERM'),
    true,
    `unexpected pnpm wrapper exit: ${JSON.stringify(exit)}`,
  );
  await waitForPortReleased(servicePort);
});
