import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import crossSpawn from 'cross-spawn';

import {
  DAEMON_STOP_TIMEOUT_MS,
  loadConfig,
  parseStartTimeout,
  resolveProjectRoot,
} from './config.ts';
import { isPathInside, samePath } from './lib/path-identity.ts';
import { ensurePrivateDirectory } from './lib/private-directory.ts';
import {
  daemonRecordPath,
  readDaemonRecord,
  requestControl,
  type ControlResponse,
} from './runtime/daemon-protocol.ts';
import {
  acquireSingleInstanceLock,
  processIsAlive,
  SingleInstanceLockError,
} from './runtime/single-instance-lock.ts';
import { KINTIO_VERSION } from './version.ts';

interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

interface DaemonLaunchRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface DaemonProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  readonly kill: (signal: NodeJS.Signals) => boolean;
}

interface CliRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly packageRoot: string;
  readonly execute: (request: ProcessRequest) => Promise<number>;
  readonly launchDaemon: (request: DaemonLaunchRequest) => DaemonProcess;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface InstanceLocation {
  readonly home: string;
  readonly configFile: string;
}

const HELP = `Usage: kintio <command> [options]

Commands:
  setup                 Create a private instance directory and configuration
  start                 Start Kintio in the background
  run                   Run Kintio in the foreground
  stop                  Stop the background Kintio process
  restart               Restart Kintio with the current installation and config
  status                Show the background process status
  logs                  Follow Kintio logs

Options:
  --home <directory>     Instance directory (default: ~/.kintio)
  --config <file>        Environment file (default: <home>/.env)
  --lines <count>        Initial lines for logs (default: 100)
  --no-follow            Print logs without following
  -h, --help             Show this help
  -v, --version          Show the Kintio version
`;

function defaultExecute(request: ProcessRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(request.file, [...request.args], {
      env: request.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function defaultLaunchDaemon(request: DaemonLaunchRequest): DaemonProcess {
  const child = crossSpawn(request.file, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', () => undefined);
  if (!child.pid) throw new Error('Kintio daemon did not return a process ID');
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  child.unref();
  return Object.freeze({
    pid: child.pid,
    exited,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  });
}

function runtimeDefaults(): CliRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    homeDirectory: os.homedir(),
    packageRoot: resolveProjectRoot(import.meta.url),
    execute: defaultExecute,
    launchDaemon: defaultLaunchDaemon,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function resolveInputPath(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

function instanceLocation(
  values: { readonly home?: string; readonly config?: string },
  runtime: CliRuntime,
): InstanceLocation {
  const hasExplicitHome = values.home !== undefined;
  const hasExplicitConfig = values.config !== undefined;
  const configuredFile = hasExplicitHome && !hasExplicitConfig
    ? undefined
    : values.config || runtime.env.KINTIO_CONFIG_FILE;
  const configuredHome = hasExplicitConfig && !hasExplicitHome
    ? undefined
    : values.home || runtime.env.KINTIO_HOME;
  const configFile = configuredFile
    ? resolveInputPath(configuredFile, runtime.cwd)
    : '';
  const home = configuredHome
    ? resolveInputPath(configuredHome, runtime.cwd)
    : configFile
      ? path.dirname(configFile)
      : path.join(runtime.homeDirectory, '.kintio');
  const location = {
    home: path.resolve(home),
    configFile: configFile || path.join(path.resolve(home), '.env'),
  };
  if (
    process.platform === 'win32' &&
    (
      !isPathInside(runtime.homeDirectory, location.home) ||
      !isPathInside(runtime.homeDirectory, location.configFile)
    )
  ) {
    throw new Error(
      'Windows instances and config files must stay inside the current user profile',
    );
  }
  return Object.freeze(location);
}

function containedDirectory(root: string, directory: string): void {
  if (!isPathInside(root, directory)) {
    throw new Error(`Instance path escapes through a symbolic link: ${directory}`);
  }
}

function assertTrustedDirectory(
  directory: string,
  label: string,
  privateContents: boolean,
): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${directory}`);
  }
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }
  const forbidden = privateContents ? 0o077 : 0o022;
  if ((stat.mode & forbidden) !== 0) {
    throw new Error(`${label} has unsafe permissions: ${directory}`);
  }
}

function ensureContainedDirectory(root: string, directory: string): string {
  const target = path.resolve(directory);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  containedDirectory(root, ancestor);
  const created = ensurePrivateDirectory(target);
  containedDirectory(root, created);
  return created;
}

function regularFile(filePath: string, label: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    return stat;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function privateFile(filePath: string, label: string): fs.Stats | undefined {
  const stat = regularFile(filePath, label);
  if (!stat || process.platform === 'win32') return stat;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
  return stat;
}

function writeNewFile(
  filePath: string,
  content: string,
  containmentRoot?: string,
): boolean {
  if (containmentRoot) {
    ensureContainedDirectory(containmentRoot, path.dirname(filePath));
    assertTrustedDirectory(path.dirname(filePath), 'Target directory', false);
  } else {
    ensurePrivateDirectory(path.dirname(filePath));
    assertTrustedDirectory(path.dirname(filePath), 'Target directory', false);
  }
  if (regularFile(filePath, 'Target file')) return false;
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temporary, filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      if (!regularFile(filePath, 'Target file')) {
        throw new Error(`Target file appeared with an invalid type: ${filePath}`);
      }
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeManagedFile(
  filePath: string,
  content: string,
  containmentRoot: string,
): 'created' | 'updated' | 'current' {
  ensureContainedDirectory(containmentRoot, path.dirname(filePath));
  assertTrustedDirectory(path.dirname(filePath), 'Managed directory', true);
  const existing = regularFile(filePath, 'Managed file');
  if (existing && fs.readFileSync(filePath, 'utf8') === content) return 'current';
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return existing ? 'updated' : 'created';
}

function prepareDirectories(home: string): void {
  assertTrustedDirectory(
    ensurePrivateDirectory(home),
    'Kintio instance directory',
    false,
  );
  assertTrustedDirectory(
    ensureContainedDirectory(home, path.join(home, 'data')),
    'Kintio data directory',
    true,
  );
  assertTrustedDirectory(
    ensureContainedDirectory(home, path.join(home, 'codex-workspace')),
    'Kintio workspace directory',
    false,
  );
}

function setup(location: InstanceLocation, runtime: CliRuntime): number {
  prepareDirectories(location.home);
  const templateFile = path.join(runtime.packageRoot, '.env.example');
  const template = fs.readFileSync(templateFile, 'utf8');
  const configInsideHome = isPathInside(location.home, location.configFile);
  const configCreated = writeNewFile(
    location.configFile,
    template,
    configInsideHome ? location.home : undefined,
  );
  const configStat = privateFile(location.configFile, 'Kintio config');
  if (!configStat) throw new Error(`Kintio config was not created: ${location.configFile}`);

  const bundledSkill = path.join(
    runtime.packageRoot,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const installedSkill = path.join(
    location.home,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const skillState = writeManagedFile(
    installedSkill,
    fs.readFileSync(bundledSkill, 'utf8'),
    location.home,
  );
  const defaultHome = path.join(runtime.homeDirectory, '.kintio');
  const defaultConfig = path.join(defaultHome, '.env');
  const nextStep =
    location.home === defaultHome && location.configFile === defaultConfig
      ? 'run "kintio start".'
      : 'run "kintio start" with the same --home and --config options.';

  runtime.stdout(
    `Kintio setup complete.\n` +
    `Home: ${location.home}\n` +
    `Config: ${location.configFile} (${configCreated ? 'created' : 'kept'})\n` +
    `Agent skill: ${installedSkill} (${skillState})\n` +
    `Edit the config, run "codex login status", then ${nextStep}\n`,
  );
  return 0;
}

function processEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
): NodeJS.ProcessEnv {
  if (!privateFile(location.configFile, 'Kintio config')) {
    throw new Error(`Kintio config is missing; run "kintio setup": ${location.configFile}`);
  }
  assertTrustedDirectory(path.dirname(location.configFile), 'Kintio config directory', false);
  prepareDirectories(location.home);
  const environment: NodeJS.ProcessEnv = {
    ...runtime.env,
    KINTIO_HOME: location.home,
    KINTIO_CONFIG_FILE: location.configFile,
    NODE_ENV: 'production',
  };
  loadConfig({
    environment: { ...environment },
    envFile: location.configFile,
    root: location.home,
  });
  return environment;
}

function removeDaemonMetadata(location: InstanceLocation): void {
  fs.rmSync(daemonRecordPath(location.home), { force: true });
}

async function probeDaemon(location: InstanceLocation): Promise<ControlResponse | undefined> {
  const record = readDaemonRecord(location.home);
  if (!record) {
    return undefined;
  }
  try {
    return await requestControl(location.home, 'ping');
  } catch (error: unknown) {
    if (processIsAlive(record.daemonPid)) {
      throw new Error(`Kintio daemon is running but unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    removeDaemonMetadata(location);
    return undefined;
  }
}

function assertDaemonInstance(
  location: InstanceLocation,
  packageRoot: string,
): void {
  const daemon = readDaemonRecord(location.home);
  if (!daemon) throw new Error('Kintio daemon record is missing');
  if (
    !samePath(daemon.configFile, location.configFile) ||
    !samePath(daemon.packageRoot, packageRoot)
  ) {
    throw new Error(
      'Kintio is running with another config or installation; use "kintio restart" to switch deliberately',
    );
  }
}

async function withLifecycleLock<T>(
  location: InstanceLocation,
  task: () => Promise<T>,
): Promise<T> {
  const dataDirectory = ensureContainedDirectory(
    location.home,
    path.join(location.home, 'data'),
  );
  let lock;
  try {
    lock = acquireSingleInstanceLock({
      filePath: path.join(dataDirectory, 'lifecycle.lock'),
      hasActiveDatabaseOwner: () => false,
    });
  } catch (error: unknown) {
    if (error instanceof SingleInstanceLockError) {
      throw new Error('Another Kintio lifecycle command is already running');
    }
    throw error;
  }
  try {
    return await task();
  } finally {
    lock.release();
  }
}

async function waitForDaemonExit(
  daemon: DaemonProcess,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    daemon.exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function removeLaunchMetadata(location: InstanceLocation, daemonPid: number): void {
  if (readDaemonRecord(location.home)?.daemonPid === daemonPid) {
    fs.rmSync(daemonRecordPath(location.home), { force: true });
  }
}

async function rollbackLaunch(
  location: InstanceLocation,
  daemon: DaemonProcess,
): Promise<void> {
  const record = readDaemonRecord(location.home);
  if (record?.daemonPid === daemon.pid) {
    await requestControl(location.home, 'stop').catch(() => undefined);
    if (await waitForDaemonExit(daemon, 5_000)) {
      removeLaunchMetadata(location, daemon.pid);
      return;
    }
  }
  if (await waitForDaemonExit(daemon, 1)) {
    removeLaunchMetadata(location, daemon.pid);
    return;
  }
  daemon.kill('SIGTERM');
  if (!(await waitForDaemonExit(daemon, 1_000))) daemon.kill('SIGKILL');
  if (!(await waitForDaemonExit(daemon, 5_000))) {
    throw new Error(`Kintio startup rollback could not terminate daemon PID ${daemon.pid}`);
  }
  removeLaunchMetadata(location, daemon.pid);
}

async function start(
  location: InstanceLocation,
  runtime: CliRuntime,
  restart: boolean,
): Promise<number> {
  const environment = processEnvironment(location, runtime);
  const timeout = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS);
  return withLifecycleLock(location, async () => {
    const existing = await probeDaemon(location);
    if (existing && !restart) {
      assertDaemonInstance(location, runtime.packageRoot);
      if (existing.phase !== 'running') {
        await waitUntilRunning(location, Date.now() + timeout);
      }
      runtime.stdout(`Kintio is already running (PID ${existing.workerPid || existing.daemonPid}).\n`);
      return 0;
    }
    if (existing) {
      await stopDaemon(location, DAEMON_STOP_TIMEOUT_MS);
    }
    const deadline = Date.now() + timeout;
    const daemon = runtime.launchDaemon({
      file: process.execPath,
      args: [path.join(runtime.packageRoot, 'dist/daemon.js')],
      cwd: location.home,
      env: environment,
    });
    try {
      await waitUntilRunning(location, deadline);
    } catch (error: unknown) {
      await rollbackLaunch(location, daemon);
      throw error;
    }
    return 0;
  });
}

async function waitUntilRunning(
  location: InstanceLocation,
  deadline: number,
): Promise<void> {
  let lastError = 'daemon did not publish control state';
  while (Date.now() < deadline) {
    let response: ControlResponse | undefined;
    try {
      response = await requestControl(
        location.home,
        'ping',
        Math.min(500, Math.max(1, deadline - Date.now())),
      );
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (response?.phase === 'running' && response.workerPid) return;
    if (response?.phase === 'failed') {
      throw new Error(response.message || 'Kintio worker failed to start');
    }
    if (response) lastError = response.message || `daemon phase is ${response.phase}`;
    const waitMs = Math.min(100, deadline - Date.now());
    if (waitMs > 0) await delay(waitMs);
  }
  throw new Error(
    `Kintio failed to become ready: ${lastError}; inspect "kintio logs --no-follow"`,
  );
}

async function stopDaemon(
  location: InstanceLocation,
  timeoutMs: number,
  onNotRunning?: () => void,
): Promise<number> {
  const record = readDaemonRecord(location.home);
  if (!record) {
    onNotRunning?.();
    return 0;
  }
  await requestControl(location.home, 'stop');
  const deadline = Date.now() + timeoutMs;
  const daemonLock = path.join(location.home, 'data/daemon.lock');
  while (
    Date.now() < deadline &&
    (readDaemonRecord(location.home) || fs.existsSync(daemonLock))
  ) {
    const waitMs = Math.min(50, deadline - Date.now());
    if (waitMs > 0) await delay(waitMs);
  }
  if (readDaemonRecord(location.home) || fs.existsSync(daemonLock)) {
    throw new Error('Kintio daemon did not stop within the shutdown budget');
  }
  removeDaemonMetadata(location);
  return 0;
}

async function stop(
  runtime: CliRuntime,
  location: InstanceLocation,
): Promise<number> {
  return withLifecycleLock(location, async () => {
    return await stopDaemon(
      location,
      DAEMON_STOP_TIMEOUT_MS,
      () => runtime.stdout('Kintio is not running.\n'),
    );
  });
}

function positiveLineCount(value: string | undefined): number {
  const count = Number(value ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new Error('--lines must be an integer between 1 and 10000');
  }
  return count;
}

function logFilePath(location: InstanceLocation): string {
  return path.join(location.home, 'data/logs/kintio.log');
}

function readLogTail(filePath: string, lines: number): {
  text: string;
  size: number;
  device: number;
  inode: number;
} {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(descriptor);
    const source = fs.readFileSync(descriptor, 'utf8');
    const values = source.split(/(?<=\n)/u);
    return {
      text: values.slice(Math.max(0, values.length - lines)).join(''),
      size: Buffer.byteLength(source),
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Kintio has no background logs');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function followLog(
  filePath: string,
  lines: number,
  output: (text: string) => void,
): Promise<never> {
  const initial = readLogTail(filePath, lines);
  if (initial.text) output(initial.text);
  let position = initial.size;
  let device: number | undefined = initial.device;
  let inode: number | undefined = initial.inode;
  while (true) {
    await delay(250);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(descriptor);
      if (stat.dev !== device || stat.ino !== inode) {
        device = stat.dev;
        inode = stat.ino;
        position = 0;
      }
      if (stat.size < position) position = 0;
      if (stat.size === position) continue;
      const buffer = Buffer.alloc(stat.size - position);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead > 0) output(buffer.subarray(0, bytesRead).toString('utf8'));
      position += bytesRead;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        position = 0;
        device = undefined;
        inode = undefined;
        continue;
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}

export async function runCli(
  args: readonly string[],
  overrides: Partial<CliRuntime> = {},
): Promise<number> {
  const runtime = { ...runtimeDefaults(), ...overrides };
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        home: { type: 'string' },
        config: { type: 'string' },
        lines: { type: 'string' },
        'no-follow': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (parsed.values.version) {
      runtime.stdout(`${KINTIO_VERSION}\n`);
      return 0;
    }
    const command = parsed.positionals[0];
    if (parsed.values.help || !command || command === 'help') {
      runtime.stdout(HELP);
      return 0;
    }
    if (parsed.positionals.length !== 1) {
      throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }
    if (
      command !== 'logs' &&
      (parsed.values.lines !== undefined || parsed.values['no-follow'])
    ) {
      throw new Error('--lines and --no-follow are valid only for "kintio logs"');
    }
    const location = instanceLocation(parsed.values, runtime);
    if (command === 'setup') return setup(location, runtime);
    if (command === 'start') return await start(location, runtime, false);
    if (command === 'restart') return await start(location, runtime, true);
    if (command === 'run') {
      const environment = processEnvironment(location, runtime);
      return await runtime.execute({
        file: process.execPath,
        args: [path.join(runtime.packageRoot, 'dist/index.js')],
        env: environment,
      });
    }
    if (command === 'stop') return await stop(runtime, location);
    if (command === 'status') {
      const existing = await probeDaemon(location);
      if (!existing) {
        runtime.stdout('Kintio is not running.\n');
        return 0;
      }
      assertDaemonInstance(location, runtime.packageRoot);
      runtime.stdout(
        `Kintio is ${existing.phase} ` +
        `(daemon PID ${existing.daemonPid}` +
        `${existing.workerPid ? `, worker PID ${existing.workerPid}` : ''}).` +
        `${existing.message ? ` ${existing.message}` : ''}\n`,
      );
      return existing.phase === 'failed' ? 1 : 0;
    }
    if (command === 'logs') {
      const filePath = logFilePath(location);
      const lines = positiveLineCount(parsed.values.lines);
      if (parsed.values['no-follow']) {
        const tail = readLogTail(filePath, lines);
        if (tail.text) runtime.stdout(tail.text);
        return 0;
      }
      return await followLog(filePath, lines, runtime.stdout);
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error: unknown) {
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
