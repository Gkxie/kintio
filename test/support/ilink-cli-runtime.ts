import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'vitest';

import type { runCli } from '../../src/cli.ts';
import { requestControl, readDaemonRecord } from '../../src/runtime/daemon-protocol.ts';
import { runNativeDaemon } from '../../src/runtime/native-daemon.ts';
import { processIsAlive } from '../../src/runtime/single-instance-lock.ts';

function processExited(pid: number): boolean {
  if (!processIsAlive(pid)) return true;
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // An adopted zombie has exited and released its files, even before PID 1 reaps it.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

export function fakeIlinkFetch(directory: string): typeof fetch {
  let nextQr = 0;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body = JSON.parse(await request.text() || '{}') as { qrcode?: string };
    const qrCode = url.searchParams.get('qrcode');
    if (qrCode) body.qrcode = qrCode;
    fs.appendFileSync(path.join(directory, 'requests.jsonl'), `${JSON.stringify({ path: url.pathname, body })}\n`);
    const replies = JSON.parse(fs.readFileSync(path.join(directory, 'replies.json'), 'utf8')) as Record<string, unknown>;
    if (url.pathname.endsWith('/get_bot_qrcode')) {
      const qrcode = `synthetic-qr-${++nextQr}`;
      return Response.json({ qrcode, qrcode_img_content: `weixin://${qrcode}` });
    }
    if (url.pathname.endsWith('/get_qrcode_status')) {
      return Response.json(replies[body.qrcode || ''] || replies.default || { status: 'wait' });
    }
    if (url.pathname.endsWith('/getupdates')) {
      const signal = init?.signal || request.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (url.pathname.endsWith('/notifystart') || url.pathname.endsWith('/notifystop')) {
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected synthetic iLink request: ${url.pathname}`);
  };
}

export async function createIlinkCliRuntime(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-cli-runtime-'));
  const home = path.join(directory, 'home');
  const packageRoot = path.join(directory, 'package');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const daemons: Promise<void>[] = [];
  const detachedProcesses = new Set<number>();
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(directory, 'replies.json'), '{}');
  fs.writeFileSync(path.join(directory, 'requests.jsonl'), '');
  fs.writeFileSync(path.join(packageRoot, 'dist/worker.js'), [
    `import { fakeIlinkFetch } from ${JSON.stringify(import.meta.url)};`,
    `globalThis.fetch = fakeIlinkFetch(${JSON.stringify(directory)});`,
    `await import(${JSON.stringify(pathToFileURL(path.resolve('worker.ts')).href)});`,
  ].join('\n'));
  fs.writeFileSync(path.join(packageRoot, 'dist/daemon.js'), [
    `import { runNativeDaemon } from ${JSON.stringify(pathToFileURL(path.resolve('src/runtime/native-daemon.ts')).href)};`,
    `await runNativeDaemon({home: process.env.KINTIO_HOME, configFile: process.env.KINTIO_CONFIG_FILE, packageRoot: ${JSON.stringify(packageRoot)}});`,
  ].join('\n'));
  fs.writeFileSync(path.join(packageRoot, 'mcp-relay.ts'),
    `await import(${JSON.stringify(pathToFileURL(path.resolve('mcp-relay.ts')).href)});\n`);
  const skill = 'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(packageRoot, skill)), { recursive: true });
  fs.copyFileSync(path.resolve(skill), path.join(packageRoot, skill));
  const overrides: NonNullable<Parameters<typeof runCli>[1]> = {
    env: { KINTIO_START_TIMEOUT_MS: '5000' },
    cwd: directory, homeDirectory: directory, packageRoot,
    stdinIsTTY: true, stdoutIsTTY: true, stdoutColumns: 200,
    stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text),
    launchDaemon(request) {
      const running = runNativeDaemon({
        home, configFile: path.join(home, '.env'), packageRoot,
        environment: request.env,
      });
      daemons.push(running);
      return { pid: process.pid, exited: running, kill: () => false };
    },
  };
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await Promise.allSettled(daemons);
    await waitForStopped();
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      ...(process.platform === 'win32' ? { maxRetries: 5, retryDelay: 50 } : {}),
    });
  });
  const eventually = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Timed out waiting for synthetic runtime: ${stderr.join('')}`);
  };
  const waitForStopped = async () => {
    await eventually(() => !readDaemonRecord(home));
    await eventually(() => [...detachedProcesses].every(processExited));
  };
  return {
    directory, home, packageRoot, stdout, stderr, overrides, eventually,
    launches: () => daemons.length,
    setReplies(replies: Record<string, unknown>) {
      const temporary = path.join(directory, 'replies.next');
      fs.writeFileSync(temporary, JSON.stringify(replies));
      fs.renameSync(temporary, path.join(directory, 'replies.json'));
    },
    requests: () => fs.readFileSync(path.join(directory, 'requests.jsonl'), 'utf8').trim()
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { path: string; body: { qrcode?: string } }),
    async captureRuntimeProcesses() {
      const current = await requestControl(home, 'ping');
      for (const pid of [current.daemonPid, current.workerPid]) {
        if (pid && pid !== process.pid) detachedProcesses.add(pid);
      }
      return [...detachedProcesses];
    },
    waitForStopped,
  };
}
