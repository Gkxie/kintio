import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import crossSpawn from 'cross-spawn';

import { requestControl } from '../../src/runtime/daemon-protocol.ts';
import { KINTIO_VERSION } from '../../src/version.ts';

interface CommandResult {
  readonly code: number | null;
  readonly output: string;
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

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForResponse(port: number): Promise<Response> {
  const deadline = Date.now() + 15_000;
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

async function waitForPortRelease(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
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

test('built global CLI owns one portable native daemon lifecycle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-native-daemon-'));
  const packageRoot = path.join(root, 'package');
  const instanceRoot = path.join(root, 'instance');
  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    fs.cp('src', path.join(packageRoot, 'src'), { recursive: true }),
    fs.cp('bin', path.join(packageRoot, 'bin'), { recursive: true }),
    fs.cp('assets', path.join(packageRoot, 'assets'), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
      recursive: true,
    }),
    fs.copyFile('cli.ts', path.join(packageRoot, 'cli.ts')),
    fs.copyFile('daemon.ts', path.join(packageRoot, 'daemon.ts')),
    fs.copyFile('index.ts', path.join(packageRoot, 'index.ts')),
    fs.copyFile('tsconfig.json', path.join(packageRoot, 'tsconfig.json')),
    fs.copyFile('package.json', path.join(packageRoot, 'package.json')),
    fs.copyFile('.env.example', path.join(packageRoot, '.env.example')),
    fs.symlink(
      path.resolve('node_modules'),
      path.join(packageRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ),
  ]);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const cli = path.join(packageRoot, 'dist/cli.js');
  let launcher = cli;
  t.onTestFinished(async () => {
    if (await fs.access(cli).then(() => true, () => false)) {
      await command(launcher, ['stop', '--home', instanceRoot], {
        cwd: packageRoot,
        env: environment,
      }).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const compiled = await command(
    process.execPath,
    [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(compiled.code, 0, compiled.output);
  const packed = await command(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(packed.code, 0, packed.output);
  const manifestStart = /\[\r?\n/u.exec(packed.output)?.index ?? -1;
  assert.notEqual(manifestStart, -1, packed.output);
  const manifest = JSON.parse(packed.output.slice(manifestStart)) as Array<{
    files: Array<{ path: string }>;
  }>;
  const packedFiles = manifest[0]?.files.map((file) => file.path) || [];
  for (const required of [
    'dist/cli.js',
    'dist/daemon.js',
    'dist/index.js',
    'bin/kintio.js',
    'assets/ilink-login-card.png',
    '.env.example',
  ]) assert.equal(packedFiles.includes(required), true, required);

  const prefix = path.join(root, 'global');
  const installed = await command(
    'npm',
    [
      'install', '--global', '--prefix', prefix,
      packageRoot, '--ignore-scripts', '--offline',
    ],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(installed.code, 0, installed.output);
  launcher = process.platform === 'win32'
    ? path.join(prefix, 'kintio.cmd')
    : path.join(prefix, 'bin/kintio');
  const kintio = (args: readonly string[]) => command(
    launcher,
    args,
    { cwd: packageRoot, env: environment },
  );
  const version = await kintio(['--version']);
  assert.equal(version.code, 0, version.output);
  assert.equal(version.output.trim(), KINTIO_VERSION);

  const configured = await kintio(['setup', '--home', instanceRoot]);
  assert.equal(configured.code, 0, configured.output);
  const port = await availablePort();
  const instanceConfig = path.join(instanceRoot, '.env');
  const source = (await fs.readFile(instanceConfig, 'utf8'))
    .replace(/^PORT=.*$/mu, `PORT=${port}`);
  await fs.writeFile(instanceConfig, source, { mode: 0o600 });

  const started = await kintio(['start', '--home', instanceRoot]);
  assert.equal(started.code, 0, started.output);
  assert.equal((await waitForResponse(port)).status, 200);
  const firstState = await requestControl(instanceRoot, 'ping');
  assert.equal(firstState?.phase, 'running');
  assert.ok(firstState?.workerPid);

  const repeated = await kintio(['start', '--home', instanceRoot]);
  assert.equal(repeated.code, 0, repeated.output);
  assert.match(repeated.output, /already running/u);

  const status = await kintio(['status', '--home', instanceRoot]);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /Kintio is running/u);
  const logs = await kintio([
    'logs', '--home', instanceRoot, '--lines', '20', '--no-follow',
  ]);
  assert.equal(logs.code, 0, logs.output);
  assert.match(logs.output, /Hono server is listening/u);

  const restarted = await kintio(['restart', '--home', instanceRoot]);
  assert.equal(restarted.code, 0, restarted.output);
  const secondState = await requestControl(instanceRoot, 'ping');
  assert.notEqual(secondState?.runId, firstState.runId);
  assert.equal((await waitForResponse(port)).status, 200);

  const stopped = await kintio(['stop', '--home', instanceRoot]);
  assert.equal(stopped.code, 0, stopped.output);
  await waitForPortRelease(port);
  const finalStatus = await kintio(['status', '--home', instanceRoot]);
  assert.equal(finalStatus.code, 0, finalStatus.output);
  assert.match(finalStatus.output, /not running/u);
});
