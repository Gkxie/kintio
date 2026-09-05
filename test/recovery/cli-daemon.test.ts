import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
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
  readonly signal: NodeJS.Signals | null;
}

interface RunningCommand {
  readonly child: ChildProcess;
  readonly exited: Promise<CommandResult>;
  readonly output: () => string;
}

function startCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly ipc?: boolean;
  },
): RunningCommand {
  const child = crossSpawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.ipc
      ? ['ignore', 'pipe', 'pipe', 'ipc']
      : ['ignore', 'pipe', 'pipe'],
  });
  if (!child.stdout || !child.stderr) {
    child.kill('SIGKILL');
    throw new Error('Command was started without captured output');
  }
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<CommandResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, output, signal }));
  });
  return Object.freeze({ child, exited, output: () => output });
}

function command(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return startCommand(file, args, options).exited;
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

async function waitForRemoval(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await fs.access(filePath).then(() => true, () => false))) return;
    await delay(50);
  }
  throw new Error(`Path was not removed: ${filePath}`);
}

test('installed global CLI owns background and foreground lifecycles from any cwd', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-native-daemon-'));
  const packageRoot = path.join(root, 'package');
  const profileRoot = path.join(root, 'profile');
  const callerRoot = path.join(root, 'unrelated-caller');
  const instanceRoot = path.join(profileRoot, 'instances', 'background');
  const defaultInstanceRoot = path.join(profileRoot, '.kintio', 'wecom');
  await Promise.all([
    fs.mkdir(packageRoot, { recursive: true }),
    fs.mkdir(callerRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.cp('src', path.join(packageRoot, 'src'), { recursive: true }),
    fs.cp('bin', path.join(packageRoot, 'bin'), { recursive: true }),
    fs.cp('assets', path.join(packageRoot, 'assets'), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
      recursive: true,
    }),
    fs.copyFile('cli.ts', path.join(packageRoot, 'cli.ts')),
    fs.copyFile('daemon.ts', path.join(packageRoot, 'daemon.ts')),
    fs.copyFile('wecom.ts', path.join(packageRoot, 'wecom.ts')),
    fs.copyFile('ilink.ts', path.join(packageRoot, 'ilink.ts')),
    fs.copyFile('tsconfig.json', path.join(packageRoot, 'tsconfig.json')),
    fs.copyFile('package.json', path.join(packageRoot, 'package.json')),
    fs.symlink(
      path.resolve('node_modules'),
      path.join(packageRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ),
  ]);
  const buildEnvironment: NodeJS.ProcessEnv = { ...process.env };
  let cleanupEnvironment = buildEnvironment;
  let launcher: string | undefined;
  const foregrounds = new Set<RunningCommand>();
  t.onTestFinished(async () => {
    for (const foreground of foregrounds) {
      if (foreground.child.exitCode === null && foreground.child.signalCode === null) {
        foreground.child.kill('SIGKILL');
      }
      await foreground.exited.catch(() => undefined);
    }
    if (launcher) {
      await command(launcher, ['wecom', 'stop', '--home', instanceRoot], {
        cwd: callerRoot,
        env: cleanupEnvironment,
      }).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const compiled = await command(
    process.execPath,
    [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: packageRoot, env: buildEnvironment },
  );
  assert.equal(compiled.code, 0, compiled.output);
  const packed = await command(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
    { cwd: packageRoot, env: buildEnvironment },
  );
  assert.equal(packed.code, 0, packed.output);
  const manifestStart = /\[\r?\n/u.exec(packed.output)?.index ?? -1;
  assert.notEqual(manifestStart, -1, packed.output);
  const manifest = JSON.parse(packed.output.slice(manifestStart)) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const packedFiles = manifest[0]?.files.map((file) => file.path) || [];
  for (const required of [
    'dist/cli.js',
    'dist/daemon.js',
    'dist/wecom.js',
    'dist/ilink.js',
    'bin/kintio.js',
    'assets/ilink-login-card.png',
  ]) assert.equal(packedFiles.includes(required), true, required);
  const tarball = path.join(root, manifest[0]?.filename || '');
  await fs.access(tarball);
  const packedPackage = path.join(root, 'packed-package');
  await Promise.all(packedFiles.map(async (file) => {
    const source = path.resolve(packageRoot, file);
    const destination = path.resolve(packedPackage, file);
    const relative = path.relative(packageRoot, source);
    assert.equal(
      relative === '' || (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ),
      true,
      file,
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }));
  await fs.symlink(
    path.resolve('node_modules'),
    path.join(packedPackage, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const prefix = path.join(root, 'global');
  const installed = await command(
    'npm',
    [
      'install', '--global', '--prefix', prefix,
      packedPackage, '--ignore-scripts', '--offline',
    ],
    { cwd: packageRoot, env: buildEnvironment },
  );
  assert.equal(installed.code, 0, installed.output);
  launcher = process.platform === 'win32'
    ? path.join(prefix, 'kintio.cmd')
    : path.join(prefix, 'bin/kintio');
  const packageDirectory = ['@kin-tio', 'cli'];
  const installedBin = path.join(
    prefix,
    ...(process.platform === 'win32'
      ? ['node_modules', ...packageDirectory, 'bin', 'kintio.js']
      : ['lib', 'node_modules', ...packageDirectory, 'bin', 'kintio.js']),
  );
  await fs.access(installedBin);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: profileRoot,
    USERPROFILE: profileRoot,
  };
  delete environment.KINTIO_HOME;
  delete environment.KINTIO_CONFIG_FILE;
  cleanupEnvironment = environment;
  const kintio = (
    args: readonly string[],
    commandEnvironment: NodeJS.ProcessEnv = environment,
  ) => command(
    launcher!,
    args,
    { cwd: callerRoot, env: commandEnvironment },
  );
  const version = await kintio(['--version']);
  assert.equal(version.code, 0, version.output);
  assert.equal(version.output.trim(), KINTIO_VERSION);

  const configuredDefault = await kintio(['wecom', 'setup']);
  assert.equal(configuredDefault.code, 0, configuredDefault.output);
  const defaultConfig = path.join(defaultInstanceRoot, '.env');
  await fs.access(defaultConfig);
  await assert.rejects(fs.access(path.join(callerRoot, '.env')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(callerRoot, 'data')), { code: 'ENOENT' });

  const occupied = net.createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '0.0.0.0', resolve);
  });
  t.onTestFinished(async () => {
    if (occupied.listening) {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  const occupiedAddress = occupied.address();
  if (!occupiedAddress || typeof occupiedAddress === 'string') {
    throw new Error('Missing occupied test port');
  }
  const physicalRunConfig = (await fs.readFile(defaultConfig, 'utf8'))
    .replace(/^PORT=.*$/mu, `PORT=${occupiedAddress.port}`)
    .replace(/^CODEX_ENABLED=.*$/mu, 'CODEX_ENABLED=false');
  await fs.writeFile(defaultConfig, physicalRunConfig, { mode: 0o600 });
  const physicalRun = startCommand(launcher, ['wecom', 'run'], {
    cwd: callerRoot,
    env: environment,
  });
  foregrounds.add(physicalRun);
  const physicalResult = await Promise.race([
    physicalRun.exited,
    delay(15_000).then(() => {
      throw new Error(`Global kintio wecom run did not fail its occupied port\n${physicalRun.output()}`);
    }),
  ]);
  foregrounds.delete(physicalRun);
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  assert.equal(physicalResult.code, 1, physicalResult.output);
  assert.match(physicalResult.output, /EADDRINUSE|address already in use/iu);
  await waitForRemoval(path.join(defaultInstanceRoot, 'data/kintio.lock'));

  const staleHome = path.join(profileRoot, 'ambient-home');
  const explicitEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    KINTIO_HOME: staleHome,
    KINTIO_CONFIG_FILE: path.join(staleHome, 'ambient.env'),
  };
  cleanupEnvironment = explicitEnvironment;
  const configured = await kintio(
    ['wecom', 'setup', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(configured.code, 0, configured.output);
  await fs.access(path.join(instanceRoot, '.env'));
  await assert.rejects(fs.access(staleHome), { code: 'ENOENT' });
  const port = await availablePort();
  const instanceConfig = path.join(instanceRoot, '.env');
  const source = (await fs.readFile(instanceConfig, 'utf8'))
    .replace(/^PORT=.*$/mu, `PORT=${port}`)
    .replace(/^CODEX_ENABLED=.*$/mu, 'CODEX_ENABLED=false');
  await fs.writeFile(instanceConfig, source, { mode: 0o600 });

  const started = await kintio(
    ['wecom', 'start', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(started.code, 0, started.output);
  assert.equal((await waitForResponse(port)).status, 200);
  const firstState = await requestControl(instanceRoot, 'ping');
  assert.equal(firstState?.phase, 'running');
  assert.ok(firstState?.workerPid);

  const repeated = await kintio(
    ['wecom', 'start', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(repeated.code, 0, repeated.output);
  assert.match(repeated.output, /already running/u);

  const status = await kintio(
    ['wecom', 'status', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /Kintio is running in wecom mode/u);
  const logs = await kintio(
    ['wecom', 'logs', '--home', instanceRoot, '--lines', '20', '--no-follow'],
    explicitEnvironment,
  );
  assert.equal(logs.code, 0, logs.output);
  assert.match(logs.output, /Hono server is listening/u);

  const idleStopped = await requestControl(instanceRoot, 'stop-if-idle');
  assert.equal(idleStopped.idle, true);
  assert.equal(idleStopped.phase, 'stopping');
  await waitForPortRelease(port);
  await waitForRemoval(path.join(instanceRoot, 'data/daemon.lock'));
  const resumed = await kintio(
    ['wecom', 'start', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal((await waitForResponse(port)).status, 200);

  const restarted = await kintio(
    ['wecom', 'restart', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(restarted.code, 0, restarted.output);
  const secondState = await requestControl(instanceRoot, 'ping');
  assert.notEqual(secondState?.runId, firstState.runId);
  assert.equal((await waitForResponse(port)).status, 200);

  const stopped = await kintio(
    ['wecom', 'stop', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(stopped.code, 0, stopped.output);
  await waitForPortRelease(port);
  const finalStatus = await kintio(
    ['wecom', 'status', '--home', instanceRoot],
    explicitEnvironment,
  );
  assert.equal(finalStatus.code, 0, finalStatus.output);
  assert.match(finalStatus.output, /not running/u);

  const foregroundLock = path.join(defaultInstanceRoot, 'data/kintio.lock');
  const runForeground = async (
    cause: NodeJS.Signals | 'parent disconnect',
  ): Promise<void> => {
    const foregroundPort = await availablePort();
    const foregroundConfig = (await fs.readFile(defaultConfig, 'utf8'))
      .replace(/^PORT=.*$/mu, `PORT=${foregroundPort}`)
      .replace(/^CODEX_ENABLED=.*$/mu, 'CODEX_ENABLED=false');
    await fs.writeFile(defaultConfig, foregroundConfig, { mode: 0o600 });
    const running = startCommand(
      process.execPath,
      [installedBin, 'wecom', 'run'],
      {
        cwd: callerRoot,
        env: environment,
        ipc: cause === 'parent disconnect',
      },
    );
    foregrounds.add(running);
    try {
      assert.equal((await waitForResponse(foregroundPort)).status, 200);
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n${running.output()}`);
    }
    if (cause === 'parent disconnect') {
      running.child.disconnect();
    } else {
      assert.equal(running.child.kill(cause), true);
    }
    const result = await running.exited;
    foregrounds.delete(running);
    await waitForPortRelease(foregroundPort);
    await waitForRemoval(foregroundLock);
    if (cause === 'parent disconnect' || process.platform !== 'win32') {
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 0, signal: null },
        result.output,
      );
      assert.match(result.output, /Received parent shutdown; shutting down/u);
    } else {
      assert.notDeepEqual(
        { code: result.code, signal: result.signal },
        { code: 0, signal: null },
        'Windows process.kill is forced termination, not Console Ctrl+C',
      );
    }
  };

  await runForeground('parent disconnect');
  await runForeground('SIGINT');
  await runForeground('SIGTERM');
});
