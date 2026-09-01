import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import crossSpawn from 'cross-spawn';
import { test, type TestContext } from 'vitest';

import { requestControl, daemonRecordPath } from '../../src/runtime/daemon-protocol.ts';
import { processIsAlive } from '../../src/runtime/single-instance-lock.ts';
import { CodexAppServer } from '../../src/services/codex-app-server.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

interface CommandResult {
  readonly code: number | null;
  readonly output: string;
}

interface AgentProcesses {
  readonly invocation: number;
  readonly codexPid: number;
  readonly relayPids: readonly number[];
}

function command(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error('Command was started without captured output'));
      return;
    }
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

async function availablePort(host = '127.0.0.1'): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForResponse(port: number, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500),
      });
    } catch (error: unknown) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError;
}

async function waitForPortRelease(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    } catch {
      server.close();
      await delay(50);
    }
  }
  throw new Error(`Port ${port} was not released`);
}

async function until<T>(
  operation: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForDead(pids: readonly number[], timeoutMs = 20_000): Promise<void> {
  await until(
    () => pids.every((pid) => !processIsAlive(pid)) ? true : undefined,
    `processes to exit: ${pids.join(', ')}`,
    timeoutMs,
  );
}

function replaceEnvironment(source: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'mu');
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.replace(/\s*$/u, '\n')}${line}\n`;
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function fakeCodexSource(processFile: string, countFile: string): string {
  return String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

let invocation = 1;
try { invocation = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1; } catch {}
fs.writeFileSync(${JSON.stringify(countFile)}, String(invocation));

const settings = new Map();
for (let index = 0; index < process.argv.length - 1; index += 1) {
  if (process.argv[index] !== '--config') continue;
  const source = process.argv[index + 1] || '';
  const separator = source.indexOf('=');
  if (separator > 0) settings.set(source.slice(0, separator), source.slice(separator + 1));
}
function setting(name) {
  const source = settings.get(name);
  return source === undefined ? undefined : JSON.parse(source);
}

const relays = [];
for (const name of ['wechat_kf', 'weixin_ilink', 'conversation_memory']) {
  const command = setting('mcp_servers.' + name + '.command');
  const args = setting('mcp_servers.' + name + '.args');
  if (!command || !Array.isArray(args)) continue;
  const relay = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  relay.stdout.resume();
  relay.stderr.resume();
  relays.push(relay);
}
fs.writeFileSync(${JSON.stringify(processFile)}, JSON.stringify({
  invocation,
  codexPid: process.pid,
  relayPids: relays.map((relay) => relay.pid),
}));

function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== 'number') return;
  if (request.method === 'initialize') {
    send({ id: request.id, result: {} });
  } else if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: '00000000-0000-4000-8000-000000000001' } } });
  } else if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn-daemon-tree' } } });
    if (invocation > 1) setImmediate(() => send({
      method: 'turn/completed',
      params: { turn: { id: 'turn-daemon-tree', status: 'completed' } },
    }));
  } else {
    send({ id: request.id, result: {} });
  }
});
`;
}

test('Codex close does not wait for a process that already exited by signal', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      input += chunk.toString();
      const lines = input.split('\n');
      input = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as { id?: number; method?: string };
        if (request.method === 'initialize' && request.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
      }
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: () => true,
  });
  const server = new CodexAppServer({ spawnProcess: () => child as never });
  await server.initialize();

  child.emit('exit', null, 'SIGKILL');
  await Promise.race([
    server.close(),
    delay(250).then(() => { throw new Error('Codex close waited after signal exit'); }),
  ]);
});

test('daemon SIGKILL leaves no Worker, Codex, or stdio relay process', {
  timeout: 120_000,
}, async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-daemon-tree-'));
  const packageRoot = path.join(root, 'package');
  const globalPrefix = path.join(root, 'global');
  const instanceHome = path.join(root, 'instance');
  const fakeAgentDirectory = path.join(root, 'fake-agent');
  const agentProcessFile = path.join(instanceHome, 'data/fake-agent-processes.json');
  const agentCountFile = path.join(instanceHome, 'data/fake-agent-count');
  const ownedPids = new Set<number>();
  let launcher = '';
  let environment: NodeJS.ProcessEnv = { ...process.env };
  let upstream: HttpServer | undefined;

  t.onTestFinished(async () => {
    if (launcher) {
      await command(launcher, ['stop', '--home', instanceHome], {
        cwd: packageRoot,
        env: environment,
      }).catch(() => undefined);
    }
    for (const pid of ownedPids) {
      if (processIsAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    if (upstream) await closeServer(upstream).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    fs.cp('src', path.join(packageRoot, 'src'), { recursive: true }),
    fs.cp('bin', path.join(packageRoot, 'bin'), { recursive: true }),
    fs.cp('assets', path.join(packageRoot, 'assets'), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), { recursive: true }),
    ...['cli.ts', 'daemon.ts', 'index.ts', 'ilink.ts', 'mcp-relay.ts', 'tsconfig.json',
      'package.json', '.env.example'].map((file) =>
      fs.copyFile(file, path.join(packageRoot, file))),
    fs.symlink(
      path.resolve('node_modules'),
      path.join(packageRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ),
  ]);
  const compiled = await command(
    process.execPath,
    [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: packageRoot, env: process.env },
  );
  assert.equal(compiled.code, 0, compiled.output);
  const installed = await command(
    'npm',
    ['install', '--global', '--prefix', globalPrefix, packageRoot,
      '--ignore-scripts', '--offline'],
    { cwd: packageRoot, env: process.env },
  );
  assert.equal(installed.code, 0, installed.output);
  launcher = process.platform === 'win32'
    ? path.join(globalPrefix, 'kintio.cmd')
    : path.join(globalPrefix, 'bin/kintio');

  await fs.mkdir(fakeAgentDirectory, { recursive: true });
  const fakeCodexFile = path.join(fakeAgentDirectory, 'fake-codex.cjs');
  await fs.writeFile(
    fakeCodexFile,
    fakeCodexSource(agentProcessFile, agentCountFile),
    { mode: 0o700 },
  );
  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(fakeAgentDirectory, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${fakeCodexFile}" %*\r\n`,
    );
  } else {
    await fs.writeFile(
      path.join(fakeAgentDirectory, 'codex'),
      `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeCodexFile)});\n`,
      { mode: 0o700 },
    );
  }
  environment = {
    ...process.env,
    PATH: `${fakeAgentDirectory}${path.delimiter}${process.env.PATH || ''}`,
  };

  const setup = await command(launcher, ['setup', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(setup.code, 0, setup.output);
  const servicePort = await availablePort();
  const upstreamPort = await availablePort();
  upstream = createHttpServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(
      request.url?.startsWith('/cgi-bin/gettoken?')
        ? { errcode: 0, access_token: 'tree-token', expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok', next_cursor: 'cursor-after-start',
            has_more: 0, msg_list: [] },
    ));
  });
  await new Promise<void>((resolve, reject) => {
    upstream!.once('error', reject);
    upstream!.listen(upstreamPort, '127.0.0.1', resolve);
  });

  const configFile = path.join(instanceHome, '.env');
  let config = await fs.readFile(configFile, 'utf8');
  for (const [name, value] of Object.entries({
    PORT: String(servicePort),
    WECOM_CALLBACK_TOKEN: 'TreeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-daemon-tree',
    WECOM_KF_SECRET: 'tree-secret',
    WECOM_ALLOWED_USER_IDS: 'wm-daemon-tree',
    WECOM_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    WECOM_MCP_OBSERVE_MS: '1',
    ILINK_ENABLED: 'false',
    CODEX_ENABLED: 'true',
    SHUTDOWN_TIMEOUT_MS: '1000',
  })) config = replaceEnvironment(config, name, value);
  await fs.writeFile(configFile, config, { mode: 0o600 });

  const persistence = new StatePersistence({
    filePath: path.join(instanceHome, 'data/kintio.sqlite'),
  });
  persistence.core.ingestSyncPage({
    accountKey: 'wk-daemon-tree',
    nextCursor: 'cursor-before-start',
    messages: [testWecomMessage({
      id: 'message-daemon-tree',
      openKfId: 'wk-daemon-tree',
      externalUserId: 'wm-daemon-tree',
      text: 'hold the Agent turn open',
    })],
  });
  persistence.close();

  const bootstrapDelay = path.join(root, 'delay-worker-bootstrap.mjs');
  await fs.writeFile(bootstrapDelay, [
    "const entry = (process.argv[1] || '').replaceAll('\\\\', '/');",
    "if (entry.endsWith('/dist/index.js')) {",
    '  await new Promise((resolve) => setTimeout(resolve, 1000));',
    '}',
  ].join('\n'));
  const earlyDaemon = crossSpawn(
    process.execPath,
    [path.join(packageRoot, 'dist/daemon.js')],
    {
      cwd: instanceHome,
      env: {
        ...environment,
        KINTIO_HOME: instanceHome,
        KINTIO_CONFIG_FILE: configFile,
        NODE_ENV: 'production',
        NODE_OPTIONS: [
          environment.NODE_OPTIONS,
          `--import=${pathToFileURL(bootstrapDelay).href}`,
        ].filter(Boolean).join(' '),
      },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  if (!earlyDaemon.pid) throw new Error('Early daemon did not return a PID');
  const earlyExit = new Promise<void>((resolve, reject) => {
    earlyDaemon.once('error', reject);
    earlyDaemon.once('exit', () => resolve());
  });
  ownedPids.add(earlyDaemon.pid);
  const earlyState = await until(async () => {
    const state = await requestControl(instanceHome, 'ping').catch(() => undefined);
    return state?.phase === 'starting' && state.workerPid ? state : undefined;
  }, 'delayed managed Worker');
  assert.equal(earlyState.daemonPid, earlyDaemon.pid);
  ownedPids.add(earlyState.workerPid!);
  assert.equal(earlyDaemon.kill('SIGKILL'), true);
  await earlyExit;
  const earlyTree = [earlyState.daemonPid, earlyState.workerPid!];
  await waitForDead(earlyTree);
  earlyTree.forEach((pid) => ownedPids.delete(pid));
  const earlyStatus = await command(launcher, ['status', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(earlyStatus.code, 0, earlyStatus.output);
  assert.match(earlyStatus.output, /not running/u);
  await assert.rejects(fs.access(daemonRecordPath(instanceHome)), { code: 'ENOENT' });

  const started = await command(launcher, ['start', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(started.code, 0, started.output);
  assert.equal((await waitForResponse(servicePort)).status, 200);
  const daemon = await requestControl(instanceHome, 'ping');
  assert.equal(daemon.phase, 'running');
  assert.ok(daemon.workerPid);
  const agent = await until(async () => {
    try {
      const value = JSON.parse(await fs.readFile(agentProcessFile, 'utf8')) as AgentProcesses;
      return value.invocation === 1 && value.relayPids.length >= 2 &&
        value.relayPids.every((pid) => processIsAlive(pid))
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }, 'Codex and MCP relay processes');
  const firstTree = [daemon.daemonPid, daemon.workerPid, agent.codexPid, ...agent.relayPids];
  assert.equal(new Set(firstTree).size, firstTree.length);
  assert.equal(firstTree.every((pid) => processIsAlive(pid)), true);
  firstTree.forEach((pid) => ownedPids.add(pid));

  // A relay that cannot authenticate or connect exits within two seconds.
  // Surviving that boundary proves these are live stdio-to-IPC sessions, not
  // merely PIDs observed between spawn and an immediate startup failure.
  await delay(2_250);
  assert.equal(agent.relayPids.every((pid) => processIsAlive(pid)), true);

  process.kill(daemon.daemonPid, 'SIGKILL');
  await waitForDead(firstTree);
  firstTree.forEach((pid) => ownedPids.delete(pid));
  await waitForPortRelease(servicePort);

  const status = await command(launcher, ['status', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /not running/u);
  await assert.rejects(fs.access(daemonRecordPath(instanceHome)), { code: 'ENOENT' });

  const restarted = await command(launcher, ['start', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(restarted.code, 0, restarted.output);
  assert.equal((await waitForResponse(servicePort)).status, 200);
  const secondDaemon = await requestControl(instanceHome, 'ping');
  const secondTree = [
    secondDaemon.daemonPid,
    ...(secondDaemon.workerPid ? [secondDaemon.workerPid] : []),
  ];
  secondTree.forEach((pid) => ownedPids.add(pid));
  const stopped = await command(launcher, ['stop', '--home', instanceHome], {
    cwd: packageRoot,
    env: environment,
  });
  assert.equal(stopped.code, 0, stopped.output);
  await waitForPortRelease(servicePort);
  await waitForDead(secondTree);
  secondTree.forEach((pid) => ownedPids.delete(pid));
});
