import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { loadConfig, resolveProjectRoot } from './config.ts';
import { ensurePrivateDirectory } from './lib/private-directory.ts';
import { matchesReadyMarker } from './runtime/ready-marker.ts';
import {
  acquireSingleInstanceLock,
  SingleInstanceLockError,
} from './runtime/single-instance-lock.ts';
import { KINTIO_VERSION } from './version.ts';

interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly capture?: boolean;
  readonly timeoutMs?: number;
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly packageRoot: string;
  readonly execute: (request: ProcessRequest) => Promise<ProcessResult>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface InstanceLocation {
  readonly home: string;
  readonly configFile: string;
}

interface Pm2Process {
  readonly pid?: number;
  readonly name?: string;
  readonly pm2_env?: {
    readonly status?: string;
    readonly kill_timeout?: number;
    readonly pm_exec_path?: string;
    readonly KINTIO_HOME?: string;
    readonly KINTIO_CONFIG_FILE?: string;
    readonly KINTIO_START_TOKEN?: string;
  };
}

const PM2_COMMAND_GRACE_MS = 5_000;

const HELP = `Usage: kintio <command> [options]

Commands:
  setup                 Create a private instance directory and configuration
  start                 Start Kintio in the background with PM2
  run                   Run Kintio in the foreground
  stop                  Stop the background Kintio process
  restart               Restart Kintio with the current installation and config
  status                Show the PM2 process status
  logs                  Follow Kintio logs

Options:
  --home <directory>     Instance directory (default: ~/.kintio)
  --config <file>        Environment file (default: <home>/.env)
  --lines <count>        Initial lines for logs (default: 100)
  --no-follow            Print logs without following
  -h, --help             Show this help
  -v, --version          Show the Kintio version
`;

const HOST_ENVIRONMENT_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'PM2_HOME',
  'KINTIO_START_TIMEOUT_MS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

function defaultExecute(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.file, [...request.args], {
      env: request.env,
      stdio: request.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
          forceTimer.unref?.();
        }, request.timeoutMs);
    timer?.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        code: timedOut ? 124 : code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
}

function runtimeDefaults(): CliRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    homeDirectory: os.homedir(),
    packageRoot: resolveProjectRoot(import.meta.url),
    execute: defaultExecute,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function resolveInputPath(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

function hostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    HOST_ENVIRONMENT_KEYS.flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]]
    ),
  );
}

function lifecycleEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
): NodeJS.ProcessEnv {
  const environment = hostEnvironment(runtime.env);
  if (!environment.PM2_HOME) {
    assertTrustedDirectory(
      ensurePrivateDirectory(location.home),
      'Kintio instance directory',
      false,
    );
    assertTrustedDirectory(
      ensureContainedDirectory(location.home, path.join(location.home, 'data')),
      'Kintio data directory',
      true,
    );
    environment.PM2_HOME = ensureContainedDirectory(
      location.home,
      path.join(location.home, 'data/pm2'),
    );
    assertTrustedDirectory(environment.PM2_HOME, 'Kintio PM2 directory', true);
  } else {
    assertTrustedDirectory(
      ensurePrivateDirectory(environment.PM2_HOME),
      'PM2 directory',
      false,
    );
  }
  return environment;
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
  return Object.freeze({
    home: path.resolve(home),
    configFile: configFile || path.join(path.resolve(home), '.env'),
  });
}

function containedDirectory(root: string, directory: string): void {
  const realRoot = fs.realpathSync(root);
  const realDirectory = fs.realpathSync(directory);
  if (
    realDirectory !== realRoot &&
    !realDirectory.startsWith(`${realRoot}${path.sep}`)
  ) {
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
  const tokenLine = /^KINTIO_MCP_BEARER_TOKEN=$/gmu;
  if ([...template.matchAll(tokenLine)].length !== 1) {
    throw new Error('Packaged .env.example has an invalid MCP token placeholder');
  }
  const configured = template.replace(
    tokenLine,
    `KINTIO_MCP_BEARER_TOKEN=${randomBytes(32).toString('base64url')}`,
  );
  const configInsideHome =
    location.configFile.startsWith(`${location.home}${path.sep}`);
  const configCreated = writeNewFile(
    location.configFile,
    configured,
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
    ...hostEnvironment(runtime.env),
    KINTIO_HOME: location.home,
    KINTIO_CONFIG_FILE: location.configFile,
    NODE_ENV: 'production',
  };
  const config = loadConfig({
    environment: { ...environment },
    envFile: location.configFile,
    root: location.home,
  });
  environment.KINTIO_KILL_TIMEOUT_MS = String(
    config.state.shutdownTimeoutMs + 7_000,
  );
  return environment;
}

function backgroundEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
): NodeJS.ProcessEnv {
  return {
    ...processEnvironment(location, runtime),
    ...lifecycleEnvironment(location, runtime),
  };
}

function pm2Script(): string {
  return fileURLToPath(import.meta.resolve('pm2/bin/pm2'));
}

async function pm2(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  runtime: CliRuntime,
  capture = false,
  timeoutMs?: number,
): Promise<ProcessResult> {
  return runtime.execute({
    file: process.execPath,
    args: [pm2Script(), ...args],
    env: environment,
    capture,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function currentProcess(
  environment: NodeJS.ProcessEnv,
  runtime: CliRuntime,
  timeoutMs = 30_000,
): Promise<Pm2Process | undefined> {
  const result = await pm2(['jlist'], environment, runtime, true, timeoutMs);
  if (result.code !== 0) throw new Error('Unable to query the PM2 process list');
  const lines = result.stdout.split(/\r?\n/u);
  const start = lines.findLastIndex((line) => line.trimStart().startsWith('['));
  if (start < 0) throw new Error('PM2 returned an invalid process list');
  let processes: Pm2Process[];
  try {
    processes = JSON.parse(lines.slice(start).join('\n')) as Pm2Process[];
  } catch {
    throw new Error('PM2 returned an invalid process list');
  }
  if (!Array.isArray(processes)) throw new Error('PM2 returned an invalid process list');
  return processes.find((process) => process.name === 'kintio');
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error('Kintio lifecycle command timed out');
  return value;
}

function sameInstance(
  process: Pm2Process,
  location: InstanceLocation,
): boolean {
  return (
    path.resolve(process.pm2_env?.KINTIO_HOME || '') === location.home &&
    path.resolve(process.pm2_env?.KINTIO_CONFIG_FILE || '') ===
      location.configFile
  );
}

function ownsStart(
  process: Pm2Process,
  location: InstanceLocation,
  token: string,
  script: string,
): boolean {
  return (
    sameInstance(process, location) &&
    process.pm2_env?.KINTIO_START_TOKEN === token &&
    path.resolve(process.pm2_env?.pm_exec_path || '') === script
  );
}

function assertInstance(
  process: Pm2Process | undefined,
  location: InstanceLocation | undefined,
): void {
  if (process && location && !sameInstance(process, location)) {
    throw new Error(
      'The PM2 process belongs to another Kintio instance; rerun without a selector or use the matching --home/--config',
    );
  }
}

function startTimeout(environment: NodeJS.ProcessEnv): number {
  const timeout = Number(environment.KINTIO_START_TIMEOUT_MS || 30_000);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error(
      'KINTIO_START_TIMEOUT_MS must be an integer between 1000 and 120000',
    );
  }
  return timeout;
}

function pm2StopTimeout(process: Pm2Process): number {
  const killTimeout = Number(process.pm2_env?.kill_timeout);
  if (
    Number.isInteger(killTimeout)
    && killTimeout >= 1_000
    && killTimeout <= 127_000
  ) return killTimeout + PM2_COMMAND_GRACE_MS;
  return 30_000;
}

async function cleanupOwnedStart(
  location: InstanceLocation,
  token: string,
  environment: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): Promise<void> {
  const expectedScript = path.join(runtime.packageRoot, 'dist/index.js');
  const process = await currentProcess(environment, runtime, 5_000)
    .catch(() => undefined);
  if (process && ownsStart(process, location, token, expectedScript)) {
    await pm2(['stop', 'kintio'], environment, runtime, false, 5_000)
      .catch(() => undefined);
  }
}

async function waitUntilReady(
  location: InstanceLocation,
  token: string,
  deadline: number,
  environment: NodeJS.ProcessEnv,
  runtime: CliRuntime,
  cleanupOnFailure: boolean,
): Promise<Pm2Process> {
  const expectedScript = path.join(runtime.packageRoot, 'dist/index.js');
  let lastStatus = 'missing';
  try {
    while (Date.now() < deadline) {
      const process = await currentProcess(
        environment,
        runtime,
        remaining(deadline),
      );
      lastStatus = process?.pm2_env?.status || 'missing';
      if (process && !ownsStart(process, location, token, expectedScript)) {
        throw new Error('The PM2 process changed while Kintio was starting');
      }
      if (
        process?.pid &&
        lastStatus === 'online' &&
        matchesReadyMarker(location.home, token, process.pid)
      ) return process;
      if (['waiting restart', 'errored', 'stopped'].includes(lastStatus)) break;
      await delay(200);
    }
  } catch (error: unknown) {
    if (cleanupOnFailure) {
      await cleanupOwnedStart(location, token, environment, runtime);
    }
    throw error;
  }
  if (cleanupOnFailure) {
    await cleanupOwnedStart(location, token, environment, runtime);
  }
  throw new Error(
    `Kintio failed to become ready (PM2 status: ${lastStatus}); inspect "kintio logs --no-follow"`,
  );
}

async function withLifecycleLock<T>(
  environment: NodeJS.ProcessEnv,
  task: () => Promise<T>,
): Promise<T> {
  const pm2Home = environment.PM2_HOME;
  if (!pm2Home) throw new Error('PM2_HOME is required for lifecycle commands');
  let lock;
  try {
    lock = acquireSingleInstanceLock({
      filePath: path.join(pm2Home, 'kintio-cli.lock'),
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

async function start(
  location: InstanceLocation,
  runtime: CliRuntime,
  restart: boolean,
): Promise<number> {
  const environment = backgroundEnvironment(location, runtime);
  const timeout = startTimeout(environment);
  const startToken = randomBytes(32).toString('base64url');
  environment.KINTIO_START_TOKEN = startToken;
  return withLifecycleLock(environment, async () => {
    const existing = await currentProcess(
      environment,
      runtime,
      timeout,
    );
    if (!restart && existing && existing.pm2_env?.status !== 'stopped') {
      const existingEnvironment = existing.pm2_env;
      if (!existingEnvironment) {
        throw new Error('The existing PM2 process has no Kintio environment');
      }
      const expectedScript = path.join(runtime.packageRoot, 'dist/index.js');
      const matchesInstance =
        sameInstance(existing, location) &&
        path.resolve(existingEnvironment.pm_exec_path || '') === expectedScript;
      if (!matchesInstance) {
        throw new Error(
          `Kintio is already registered with another installation or instance (PID ${existing.pid || 'unknown'}); use "kintio restart" to switch deliberately`,
        );
      }
      const existingToken = existingEnvironment.KINTIO_START_TOKEN;
      if (!existingToken) {
        throw new Error(
          'The existing Kintio process has no readiness identity; use "kintio restart" to replace it',
        );
      }
      const ready = await waitUntilReady(
        location,
        existingToken,
        Date.now() + timeout,
        environment,
        runtime,
        false,
      );
      runtime.stdout(`Kintio is already running (PID ${ready.pid || existing.pid}).\n`);
      return 0;
    }
    if (existing) {
      const removed = await pm2(
        ['delete', 'kintio'],
        environment,
        runtime,
        false,
        pm2StopTimeout(existing),
      );
      if (removed.code !== 0) return removed.code;
    }
    const deadline = Date.now() + timeout;
    const configFile = path.join(runtime.packageRoot, 'ecosystem.config.cjs');
    const result = await pm2(
      ['start', configFile, '--only', 'kintio'],
      environment,
      runtime,
      false,
      remaining(deadline),
    );
    if (result.code !== 0) {
      await cleanupOwnedStart(location, startToken, environment, runtime);
      return result.code;
    }
    await waitUntilReady(
      location,
      startToken,
      deadline,
      environment,
      runtime,
      true,
    );
    return 0;
  });
}

async function stop(
  runtime: CliRuntime,
  location: InstanceLocation,
): Promise<number> {
  const environment = lifecycleEnvironment(location, runtime);
  return withLifecycleLock(environment, async () => {
    const existing = await currentProcess(environment, runtime);
    assertInstance(existing, location);
    if (!existing || existing.pm2_env?.status === 'stopped') {
      runtime.stdout('Kintio is not running.\n');
      return 0;
    }
    return (await pm2(
      ['stop', 'kintio'], environment, runtime, false, pm2StopTimeout(existing),
    )).code;
  });
}

function positiveLineCount(value: string | undefined): string {
  const count = Number(value ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new Error('--lines must be an integer between 1 and 10000');
  }
  return String(count);
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
      return (await runtime.execute({
        file: process.execPath,
        args: [path.join(runtime.packageRoot, 'dist/index.js')],
        env: environment,
      })).code;
    }
    if (command === 'stop') return await stop(runtime, location);
    if (command === 'status') {
      const environment = lifecycleEnvironment(location, runtime);
      const existing = await currentProcess(environment, runtime);
      assertInstance(existing, location);
      if (!existing) {
        runtime.stdout('Kintio is not running.\n');
        return 0;
      }
      return (await pm2(
        ['status', 'kintio'], environment, runtime, false, 30_000,
      )).code;
    }
    if (command === 'logs') {
      const environment = lifecycleEnvironment(location, runtime);
      const existing = await currentProcess(environment, runtime);
      assertInstance(existing, location);
      if (!existing) throw new Error('Kintio has no PM2 process or logs');
      const logArgs = ['logs', 'kintio', '--lines', positiveLineCount(parsed.values.lines)];
      if (parsed.values['no-follow']) logArgs.push('--nostream');
      return (await pm2(logArgs, environment, runtime)).code;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error: unknown) {
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
