import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

import { KINTIO_VERSION } from '../../src/version.ts';

interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function command(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
}

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

test('built global CLI owns one isolated PM2 daemon lifecycle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-cli-daemon-'));
  const packageRoot = path.join(root, 'package');
  const instanceRoot = path.join(root, 'instance');
  const pm2Home = path.join(instanceRoot, 'data/pm2');
  let blocker: net.Server | undefined;
  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    fs.cp('src', path.join(packageRoot, 'src'), { recursive: true }),
    fs.cp('bin', path.join(packageRoot, 'bin'), { recursive: true }),
    fs.cp('assets', path.join(packageRoot, 'assets'), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
      recursive: true,
    }),
    fs.copyFile('cli.ts', path.join(packageRoot, 'cli.ts')),
    fs.copyFile('index.ts', path.join(packageRoot, 'index.ts')),
    fs.copyFile('tsconfig.json', path.join(packageRoot, 'tsconfig.json')),
    fs.copyFile('package.json', path.join(packageRoot, 'package.json')),
    fs.copyFile('.env.example', path.join(packageRoot, '.env.example')),
    fs.copyFile('ecosystem.config.cjs', path.join(packageRoot, 'ecosystem.config.cjs')),
    fs.symlink(path.resolve('node_modules'), path.join(packageRoot, 'node_modules')),
  ]);
  const port = await availablePort();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CODEX_ENABLED: 'false',
  };
  const directPm2Environment = { ...environment, PM2_HOME: pm2Home };
  const pm2Script = path.join(packageRoot, 'node_modules/pm2/bin/pm2');
  t.onTestFinished(async () => {
    if (blocker?.listening) {
      await new Promise<void>((resolve) => blocker?.close(() => resolve()));
    }
    await command(process.execPath, [pm2Script, 'kill'], {
      cwd: packageRoot,
      env: directPm2Environment,
    }).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
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
  const manifestStart = packed.output.indexOf('[\n');
  assert.notEqual(manifestStart, -1, packed.output);
  const manifest = JSON.parse(packed.output.slice(manifestStart)) as Array<{
    files: Array<{ path: string }>;
  }>;
  const packedFiles = manifest[0]?.files.map((file) => file.path) || [];
  for (const required of [
    'dist/cli.js',
    'bin/kintio.js',
    'dist/index.js',
    'assets/ilink-login-card.png',
    '.env.example',
    'ecosystem.config.cjs',
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  ]) {
    assert.equal(packedFiles.includes(required), true, `missing package file: ${required}`);
  }
  assert.equal(
    packedFiles.some((file) =>
      file.startsWith('test/') || file.startsWith('src/') || file.startsWith('.github/')
    ),
    false,
  );
  const launcher = await command(
    path.join(packageRoot, 'bin/kintio.js'),
    ['--version'],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(launcher.code, 0, launcher.output);
  assert.equal(launcher.output.trim(), KINTIO_VERSION);
  const cli = path.join(packageRoot, 'dist/cli.js');

  const configured = await command(
    process.execPath,
    [cli, 'setup', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(configured.code, 0, configured.output);
  const instanceConfig = path.join(instanceRoot, '.env');
  const configuredEnvironment = (await fs.readFile(instanceConfig, 'utf8'))
    .replace(/^PORT=.*$/mu, `PORT=${port}`)
    .replace(/^CODEX_ENABLED=.*$/mu, 'CODEX_ENABLED=false');
  await fs.writeFile(instanceConfig, configuredEnvironment, { mode: 0o600 });

  const started = await command(
    process.execPath,
    [cli, 'start', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(started.code, 0, started.output);
  const response = await waitForResponse(port);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello world');

  const repeated = await command(
    process.execPath,
    [cli, 'start', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(repeated.code, 0, repeated.output);
  assert.match(repeated.output, /already running \(PID \d+\)/u);

  const legacyRestart = await command(
    process.execPath,
    [pm2Script, 'restart', 'kintio', '--update-env'],
    {
      cwd: packageRoot,
      env: {
        ...directPm2Environment,
        SENSITIVE_UNRELATED_SECRET: 'legacy-secret',
      },
    },
  );
  assert.equal(legacyRestart.code, 0, legacyRestart.output);
  const refreshed = await command(
    process.execPath,
    [cli, 'restart', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(refreshed.code, 0, refreshed.output);
  const processList = await command(
    process.execPath,
    [pm2Script, 'jlist'],
    { cwd: packageRoot, env: directPm2Environment },
  );
  assert.equal(processList.code, 0, processList.output);
  const listStart = processList.output.indexOf('[{');
  assert.notEqual(listStart, -1, processList.output);
  const listed = JSON.parse(processList.output.slice(listStart)) as Array<{
    pm2_env?: Record<string, unknown>;
  }>;
  assert.equal(listed[0]?.pm2_env?.SENSITIVE_UNRELATED_SECRET, undefined);

  const status = await command(
    process.execPath,
    [cli, 'status', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /kintio/u);
  assert.match(status.output, /online/u);

  const stopped = await command(
    process.execPath,
    [cli, 'stop', '--home', instanceRoot],
    { cwd: packageRoot, env: environment },
  );
  assert.equal(stopped.code, 0, stopped.output);
  await waitForPortRelease(port);

  const blockedPort = await availablePort();
  const blockedServer = net.createServer();
  blocker = blockedServer;
  await new Promise<void>((resolve, reject) => {
    blockedServer.once('error', reject);
    blockedServer.listen(blockedPort, '127.0.0.1', resolve);
  });
  const blockedConfig = (await fs.readFile(instanceConfig, 'utf8'))
    .replace(/^PORT=.*$/mu, `PORT=${blockedPort}`);
  await fs.writeFile(instanceConfig, blockedConfig, { mode: 0o600 });
  const fastFailureEnvironment = {
    ...environment,
    KINTIO_START_TIMEOUT_MS: '2000',
  };
  const rejected = await command(
    process.execPath,
    [cli, 'restart', '--home', instanceRoot],
    { cwd: packageRoot, env: fastFailureEnvironment },
  );
  assert.notEqual(rejected.code, 0, rejected.output);

  const stoppedFailure = await command(
    process.execPath,
    [cli, 'stop', '--home', instanceRoot],
    { cwd: packageRoot, env: fastFailureEnvironment },
  );
  assert.equal(stoppedFailure.code, 0, stoppedFailure.output);
  assert.match(stoppedFailure.output, /Kintio is not running/u);
  await new Promise<void>((resolve) => blockedServer.close(() => resolve()));
  blocker = undefined;
});
