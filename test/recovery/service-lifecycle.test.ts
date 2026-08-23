import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { startTestChild } from '../support/child-process.js';
import { createTempSqlite } from '../support/temp-sqlite.js';

const indexFile = fileURLToPath(new URL('../../index.ts', import.meta.url));
const tsxExecArgv = ['--import', 'tsx'] as const;
const servicePort = 8888;

async function waitForResponse(
  pathname: string,
  timeoutMs = 5_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${servicePort}${pathname}`, {
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

test('[DEP01] outer service answers health and hello then SIGTERM releases port 8888 and lock', async (t) => {
  await assertPortReleased(servicePort);
  const temporary = await createTempSqlite(t, {
    prefix: 'wechat-service-lifecycle-',
    filename: 'wecom.sqlite',
  });
  const lockFile = path.join(temporary.directory, 'wecom.lock');
  const child = startTestChild(t, indexFile, {
    execArgv: tsxExecArgv,
    timeoutMs: 8_000,
    env: {
      PORT: String(servicePort),
      WECOM_CALLBACK_TOKEN: 'LifecycleToken123',
      WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      WECOM_CORP_ID: '',
      WECOM_KF_SECRET: '',
      WECOM_ALLOWED_USER_IDS: '',
      WECOM_DB_FILE: temporary.filePath,
      WECOM_STATE_FILE: path.join(temporary.directory, 'legacy-state.json'),
      WECOM_LEGACY_JOURNAL_FILE: path.join(
        temporary.directory,
        'legacy-journal.sqlite',
      ),
      WECOM_BOT_PAUSE_FILE: path.join(temporary.directory, 'legacy-pause'),
      CODEX_ENABLED: 'false',
      SHUTDOWN_TIMEOUT_MS: '2000',
    },
  });

  const health = await waitForResponse('/healthz');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  const root = await waitForResponse('/');
  assert.equal(root.status, 200);
  assert.equal(await root.text(), 'hello world');
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });

  assert.deepEqual(await child.stop('SIGTERM'), { code: 0, signal: null });
  await assertPortReleased(servicePort);
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
  assert.match(child.output().stdout, /Hono server is listening on port 8888/u);
  assert.match(child.output().stdout, /Received SIGTERM; shutting down/u);
});

test('[DEP01] npm start builds and runs dist/index.js without Baota artifacts', async (t) => {
  await assertPortReleased(servicePort);
  const temporary = await createTempSqlite(t, {
    prefix: 'wechat-npm-start-',
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
    WECOM_STATE_FILE: path.join(temporary.directory, 'legacy-state.json'),
    CODEX_ENABLED: 'false',
    SHUTDOWN_TIMEOUT_MS: '2000',
  };
  const child = spawn('npm', ['start'], {
    cwd: path.resolve('.'),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  assert.equal((await waitForResponse('/healthz')).status, 200);
  const processes = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
  }).trim().split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }
      : undefined;
  }).filter((item): item is { pid: number; ppid: number; args: string } =>
    item !== undefined,
  );
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const node = processes.find((item) => {
    if (!/(?:^|\s)node dist\/index\.js(?:\s|$)/u.test(item.args)) return false;
    let parent = item.ppid;
    while (parent > 1) {
      if (parent === child.pid) return true;
      parent = byPid.get(parent)?.ppid || 0;
    }
    return false;
  });
  assert.ok(node, `npm start did not run dist/index.js:\n${output}`);
  process.kill(node.pid, 'SIGTERM');
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(output, /node dist\/index\.js/u);
  assert.match(output, /Received SIGTERM; shutting down/u);
  await assertPortReleased(servicePort);
  await assert.rejects(fs.access(path.join(process.cwd(), '.htaccess')), {
    code: 'ENOENT',
  });
});
