import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import crossSpawn from 'cross-spawn';

import {
  DAEMON_STOP_TIMEOUT_MS,
  INSTANCE_CONFIG_TEMPLATE,
  loadConfig,
  loadIlinkEnrollmentConfig,
  loadIlinkRuntimeConfig,
  parseStartTimeout,
  resolveProjectRoot,
  WORKER_GRACEFUL_TIMEOUT_MS,
} from './config.ts';
import { isPathInside, samePath } from './lib/path-identity.ts';
import {
  assertTrustedDirectory,
  ensureContainedDirectory,
  ensurePrivateDirectory,
} from './lib/private-directory.ts';
import { runIlinkCliLogin } from './ilink/cli-login.ts';
import {
  readIlinkAccountSnapshot,
  resolveIlinkAccount,
  runIlinkAccountCommand,
} from './ilink/cli-accounts.ts';
import {
  confirmIlinkAccountDeletion,
  IlinkPromptInterruptedError,
  pickIlinkAccount,
} from './ilink/account-picker.ts';
import { startIlinkCliRuntime } from './ilink/cli-start.ts';
import {
  createUpdateRuntimeIdentity,
  daemonRecordPath,
  readDaemonRecord,
  requestControl,
  sameUpdateRuntimeIdentity,
  type ControlResponse,
  type DaemonRecord,
  type DaemonMode,
  type UpdateRuntimeIdentity,
} from './runtime/daemon-protocol.ts';
import {
  acquireSingleInstanceLock,
  type InstanceLock,
  processIsAlive,
  SingleInstanceLockError,
} from './runtime/single-instance-lock.ts';
import { installManagedSkill } from './runtime/managed-skill.ts';
import { StatePersistence } from './state/persistence.ts';
import { readInstalledPackageIdentity } from './update/global-install.ts';
import {
  installPreparedKintioUpdate,
  prepareKintioUpdate,
  ProcessTreeTerminationError,
  verifyPreparedKintioUpdate,
  type PreparedKintioUpdate,
} from './update/self-update.ts';
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
  readonly stopIfIdle: (
    home: string,
    identity: UpdateRuntimeIdentity,
  ) => Promise<ControlResponse>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stdoutColumns: number;
  readonly ilinkLogin: typeof runIlinkCliLogin;
  readonly ilinkAccount: typeof runIlinkAccountCommand;
  readonly ilinkSnapshot: typeof readIlinkAccountSnapshot;
  readonly ilinkPickAccount: typeof pickIlinkAccount;
  readonly ilinkConfirmDelete: typeof confirmIlinkAccountDeletion;
  readonly ilinkStart: typeof startIlinkCliRuntime;
  readonly updater: {
    readonly prepare: typeof prepareKintioUpdate;
    readonly install: typeof installPreparedKintioUpdate;
    readonly verify: typeof verifyPreparedKintioUpdate;
  };
}

interface InstanceLocation {
  readonly home: string;
  readonly configFile: string;
}

interface RuntimeStateIdentity {
  readonly databaseFile: string;
  readonly lockFile: string;
}

interface RuntimeUpdateSnapshot {
  readonly identity: UpdateRuntimeIdentity;
  readonly state: RuntimeStateIdentity;
}

const HELP = `Usage: kintio <command> [options]

Commands:
  wecom <command>        Configure and run the WeChat KF callback channel
  ilink <command>        Connect and run iLink accounts
  update                Update the global Kintio installation
  upgrade               Alias for update

Options:
  -h, --help             Show this help
  -v, --version          Show the Kintio version

Channels have independent configuration, data, processes, and logs.
There is no shared start or stop command.
Run "kintio wecom --help" or "kintio ilink --help" for channel commands.
`;

const WECOM_HELP = `Usage: kintio wecom <command> [options]

Commands:
  setup                 Create the private WeChat KF configuration
  start                 Start the callback channel in the background
  run                   Run the callback channel in the foreground
  stop                  Stop only the WeChat KF background process
  restart               Restart only the WeChat KF background process
  status                Show the WeChat KF process status
  logs                  Follow the WeChat KF logs

Options:
  --home <directory>     Channel instance directory (default: ~/.kintio/wecom)
  --config <file>        Environment file (default: <home>/.env)
  --lines <count>        Initial lines for logs (default: 100)
  --no-follow            Print logs without following
  -h, --help             Show this help

Run setup, fill the WECOM credentials and authorization settings, then start.
The callback listens on port 8888 by default. No iLink process is started.
`;

const UPDATE_HELP = `Usage: kintio <update|upgrade> [options]

Update a global npm or pnpm installation to the newest stable Kintio release.
If the selected instance is running and idle, Kintio restores the same WeCom
or iLink channel after verifying the installed version. Active conversation work
is never interrupted for an update.

Both default channel directories are checked. If both channels are running,
stop the other channel before updating. Custom instance homes must be stopped
separately unless selected with --home.

Options:
  --home <directory>     Instance to coordinate (default: ~/.kintio)
  --config <file>        Instance configuration (default: <home>/.env)
  -h, --help             Show this help
`;

const ILINK_LOGIN_HELP = `Usage: kintio ilink login [options]

Connect one iLink account, save its encrypted credentials, and exit. This
command does not require setup, an environment file, Hono, or a running Kintio
instance. By default, the QR code is rendered directly in an interactive
terminal and expires after five minutes.

The PNG option is required when stdout is not an interactive terminal. Whoever
scans this locally issued QR receives the capabilities allowed by the host Agent
configuration; show it only to an authorized operator.

Options:
  --qr-output <file>     Write a temporary raw QR PNG instead of terminal blocks
                         The file must be directly inside the instance directory
                         The file is removed when the login attempt ends
  --home <directory>     Instance directory (default: ~/.kintio)
  --config <file>        Optional environment overrides
  -h, --help             Show this help
`;

const ILINK_START_HELP = `Usage: kintio ilink start [options]

Run iLink long polling and the host Agent in the background without starting
Hono or opening a TCP listener. This command does not require setup or an
environment file. With no enrolled account, an interactive terminal opens the
login flow first. One account is selected automatically and multiple accounts
open a searchable picker. Additional start commands add accounts to the same process.

Options:
  --account <id>        Select explicitly for scripts or to bypass the picker
  --foreground          Keep the iLink-only Runtime attached to this terminal
  --home <directory>     Instance directory (default: ~/.kintio)
  --config <file>        Optional environment overrides
  -h, --help             Show this help
`;

const ILINK_STOP_HELP = `Usage: kintio ilink stop [options]

Stop one iLink account. Stopping the last account also stops the background
iLink-only Runtime. One account is selected automatically and multiple accounts
open a searchable picker in an interactive terminal.

Options:
  --account <id>        Select explicitly for scripts or to bypass the picker
  --home <directory>    Instance directory (default: ~/.kintio)
  --config <file>       Optional environment overrides
  -h, --help            Show this help
`;

const ILINK_LIST_HELP = `Usage: kintio ilink list [options]

List enrolled iLink provider account IDs, one per line.

Options:
  --home <directory>    Instance directory (default: ~/.kintio)
  --config <file>       Optional environment overrides
  -h, --help            Show this help
`;

const ILINK_DELETE_HELP = `Usage: kintio ilink delete [options]

Permanently delete one iLink account and all Kintio data scoped to it,
including credentials, conversations, messages, media, send records, and
enrollment audit records. This operation cannot be undone.
Interactive use asks for confirmation and defaults to No.
Non-interactive use requires both --account and --yes.

Options:
  --account <id>        Select explicitly for scripts or to bypass the picker
  --yes                 Confirm permanent deletion without a prompt
  --home <directory>    Instance directory (default: ~/.kintio)
  --config <file>       Optional environment overrides
  -h, --help            Show this help
`;

const ILINK_HELP = `Usage: kintio ilink <command>

Commands:
  login [options]        Connect an iLink account with a QR code
  list                   List enrolled accounts
  start [options]        Start one account without Hono
  stop [options]         Stop one account
  delete [options]       Permanently delete one account and its data
  restart               Restart the iLink process with its enabled accounts
  status                Show the iLink process status
  logs                  Follow iLink logs (--lines 100, --no-follow)

Options:
  --home <directory>     Channel instance directory (default: ~/.kintio)
  --config <file>        Optional environment overrides

Run "kintio ilink <command> --help" for command options.
`;

const ILINK_ACCOUNT_COMMANDS = new Set(['login', 'list', 'start', 'stop', 'delete']);
const ILINK_COMMANDS = new Set([...ILINK_ACCOUNT_COMMANDS, 'restart', 'status', 'logs']);
const WECOM_COMMANDS = new Set(['setup', 'start', 'run', 'stop', 'restart', 'status', 'logs']);

const COMMANDS = new Set(['wecom', 'ilink', 'update', 'upgrade']);

const ILINK_SIGNALS: readonly NodeJS.Signals[] = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGINT', 'SIGTERM', 'SIGHUP'];

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGHUP') return 129;
  if (signal === 'SIGTERM') return 143;
  return 130;
}

async function runWithIlinkSignals(
  operation: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy ||= signal;
    controller.abort();
  };
  const listeners = ILINK_SIGNALS.map((signal) => ({
    signal,
    listener: () => interrupt(signal),
  }));
  for (const { signal, listener } of listeners) process.on(signal, listener);
  try {
    const result = await operation(controller.signal);
    return result === 130 && interruptedBy
      ? signalExitCode(interruptedBy)
      : result;
  } finally {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  }
}

function defaultExecute(request: ProcessRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(request.file, [...request.args], {
      env: request.env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    let forceTimer: NodeJS.Timeout | undefined;
    let stopping = false;

    const cleanup = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('disconnect', stop);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, WORKER_GRACEFUL_TIMEOUT_MS);
      forceTimer.unref?.();
      try {
        if (child.connected) child.send('shutdown');
      } catch {
        // Closing the IPC channel also enters the Worker's parent-disconnect path.
      }
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('disconnect', stop);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
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
    stopIfIdle: (home, identity) =>
      requestControl(home, 'stop-if-idle', undefined, identity),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdoutColumns: process.stdout.columns || 80,
    ilinkLogin: runIlinkCliLogin,
    ilinkAccount: runIlinkAccountCommand,
    ilinkSnapshot: readIlinkAccountSnapshot,
    ilinkPickAccount: pickIlinkAccount,
    ilinkConfirmDelete: confirmIlinkAccountDeletion,
    ilinkStart: startIlinkCliRuntime,
    updater: {
      prepare: prepareKintioUpdate,
      install: installPreparedKintioUpdate,
      verify: verifyPreparedKintioUpdate,
    },
  };
}

function resolveInputPath(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

function instanceLocation(
  values: { readonly home?: string; readonly config?: string },
  runtime: CliRuntime,
  channel: DaemonMode = 'ilink',
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
      : path.join(runtime.homeDirectory, '.kintio', ...(channel === 'wecom' ? ['wecom'] : []));
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
}

function loadInstanceConfig(
  location: InstanceLocation,
  runtime: CliRuntime,
  environment: NodeJS.ProcessEnv = runtime.env,
): ReturnType<typeof loadConfig> {
  return loadConfig({
    environment: { ...environment },
    envFile: location.configFile,
    root: location.home,
  });
}

function refreshManagedSkill(
  workingDirectory: string,
  runtime: CliRuntime,
) {
  return installManagedSkill({
    packageRoot: runtime.packageRoot,
    workingDirectory,
  });
}

function setup(location: InstanceLocation, runtime: CliRuntime): number {
  prepareDirectories(location.home);
  const configInsideHome = isPathInside(location.home, location.configFile);
  const configCreated = writeNewFile(
    location.configFile,
    INSTANCE_CONFIG_TEMPLATE,
    configInsideHome ? location.home : undefined,
  );
  const configStat = privateFile(location.configFile, 'Kintio config');
  if (!configStat) throw new Error(`Kintio config was not created: ${location.configFile}`);

  const skill = refreshManagedSkill(
    loadInstanceConfig(location, runtime).codex.workingDirectory,
    runtime,
  );
  const defaultHome = path.join(runtime.homeDirectory, '.kintio', 'wecom');
  const defaultConfig = path.join(defaultHome, '.env');
  const nextStep =
    location.home === defaultHome && location.configFile === defaultConfig
      ? 'run "kintio wecom start".'
      : 'run "kintio wecom start" with the same --home and --config options.';

  runtime.stdout(
    `Kintio setup complete.\n` +
    `Home: ${location.home}\n` +
    `Config: ${location.configFile} (${configCreated ? 'created' : 'kept'})\n` +
    `Agent skill: ${skill.file} (${skill.state})\n` +
    `Edit the config, run "codex login status", then ${nextStep}\n`,
  );
  return 0;
}

function processEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
): NodeJS.ProcessEnv {
  if (!privateFile(location.configFile, 'Kintio config')) {
    throw new Error(`Kintio config is missing; run "kintio wecom setup": ${location.configFile}`);
  }
  assertTrustedDirectory(path.dirname(location.configFile), 'Kintio config directory', false);
  prepareDirectories(location.home);
  const environment: NodeJS.ProcessEnv = {
    ...runtime.env,
    KINTIO_HOME: location.home,
    KINTIO_CONFIG_FILE: location.configFile,
    NODE_ENV: 'production',
  };
  const config = loadInstanceConfig(location, runtime, environment);
  refreshManagedSkill(config.codex.workingDirectory, runtime);
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
  mode?: DaemonMode,
): void {
  const daemon = readDaemonRecord(location.home);
  if (!daemon) throw new Error('Kintio daemon record is missing');
  if (
    !samePath(daemon.configFile, location.configFile) ||
    !samePath(daemon.packageRoot, packageRoot)
  ) {
    throw new Error(
      'Kintio is running with another config or installation; stop it before switching',
    );
  }
  if (mode && daemon.mode !== mode) {
    throw new Error(
      `Kintio is already running in ${daemon.mode} mode; stop it before starting ${mode} mode`,
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

async function withInstallationUpdateLock<T>(
  runtime: CliRuntime,
  task: () => Promise<T>,
): Promise<T> {
  const directory = ensurePrivateDirectory(path.join(
    runtime.homeDirectory,
    '.kintio',
    'data',
  ));
  let lock;
  try {
    lock = acquireSingleInstanceLock({
      filePath: path.join(directory, 'installation-update.lock'),
      hasActiveDatabaseOwner: () => false,
    });
  } catch (error: unknown) {
    if (error instanceof SingleInstanceLockError) {
      throw new Error('Another Kintio update is already running');
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
  try {
    if (readDaemonRecord(location.home)?.daemonPid !== daemonPid) return;
  } catch {
    // The newly launched target may use a newer metadata schema.
  }
  fs.rmSync(daemonRecordPath(location.home), { force: true });
}

async function rollbackLaunch(
  location: InstanceLocation,
  daemon: DaemonProcess,
): Promise<void> {
  let record: DaemonRecord | null = null;
  try { record = readDaemonRecord(location.home); } catch {}
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

async function startBackgroundDaemon(
  location: InstanceLocation,
  runtime: CliRuntime,
  environment: NodeJS.ProcessEnv,
  mode: DaemonMode,
): Promise<
  | { readonly alreadyRunning: true; readonly pid: number }
  | { readonly alreadyRunning: false; readonly daemon: DaemonProcess; readonly pid: number }
> {
  const timeout = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS);
  return withLifecycleLock(location, () => startBackgroundDaemonLocked(
    location,
    runtime,
    environment,
    mode,
    timeout,
  ));
}

async function startBackgroundDaemonLocked(
  location: InstanceLocation,
  runtime: CliRuntime,
  environment: NodeJS.ProcessEnv,
  mode: DaemonMode,
  timeout = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS),
): ReturnType<typeof startBackgroundDaemon> {
  const existing = await probeDaemon(location);
  if (existing) {
    assertDaemonInstance(location, runtime.packageRoot, mode);
    if (existing.phase !== 'running') {
      await waitUntilRunning(location, Date.now() + timeout);
    }
    return {
      alreadyRunning: true,
      pid: existing.workerPid || existing.daemonPid,
    };
  }
  return await launchBackgroundDaemon(location, runtime, environment, mode, timeout);
}

async function launchBackgroundDaemon(
  location: InstanceLocation,
  runtime: CliRuntime,
  environment: NodeJS.ProcessEnv,
  mode: DaemonMode,
  timeout = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS),
): Promise<{
  readonly alreadyRunning: false;
  readonly daemon: DaemonProcess;
  readonly pid: number;
}> {
  const deadline = Date.now() + timeout;
  const daemon = runtime.launchDaemon({
    file: process.execPath,
    args: [path.join(runtime.packageRoot, 'dist/daemon.js')],
    cwd: location.home,
    env: { ...environment, KINTIO_DAEMON_MODE: mode },
  });
  try {
    await waitUntilRunning(location, deadline);
  } catch (error: unknown) {
    await rollbackLaunch(location, daemon);
    throw error;
  }
  const running = await requestControl(location.home, 'ping');
  return {
    alreadyRunning: false,
    daemon,
    pid: running.workerPid || running.daemonPid,
  };
}

async function start(
  location: InstanceLocation,
  runtime: CliRuntime,
): Promise<number> {
  const result = await startBackgroundDaemon(
    location,
    runtime,
    processEnvironment(location, runtime),
    'wecom',
  );
  if (result.alreadyRunning) {
    runtime.stdout(`Kintio is already running (PID ${result.pid}).\n`);
  }
  return 0;
}

async function restart(
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
): Promise<number> {
  return withLifecycleLock(location, async () => {
    const existing = await probeDaemon(location);
    const record = existing ? readDaemonRecord(location.home) : null;
    if (!existing || !record) {
      await launchBackgroundDaemon(
        location,
        runtime,
        daemonEnvironment(location, runtime, mode),
        mode,
      );
      return 0;
    }
    const restoredLocation = {
      home: location.home,
      configFile: record.configFile,
    } satisfies InstanceLocation;
    assertDaemonInstance(restoredLocation, runtime.packageRoot, mode);
    const environment = daemonEnvironment(restoredLocation, runtime, record.mode);
    await stopDaemon(restoredLocation, DAEMON_STOP_TIMEOUT_MS);
    await launchBackgroundDaemon(
      restoredLocation,
      runtime,
      environment,
      record.mode,
    );
    return 0;
  });
}

function ilinkDaemonEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
): NodeJS.ProcessEnv {
  loadIlinkRuntimeConfig({
    environment: { ...runtime.env },
    envFile: location.configFile,
    root: location.home,
  });
  return {
    ...runtime.env,
    KINTIO_HOME: location.home,
    KINTIO_CONFIG_FILE: location.configFile,
    NODE_ENV: 'production',
  };
}

function daemonEnvironment(
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
): NodeJS.ProcessEnv {
  return mode === 'ilink'
    ? ilinkDaemonEnvironment(location, runtime)
    : processEnvironment(location, runtime);
}

function loadDaemonRuntimeConfig(
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
): ReturnType<typeof loadConfig> | ReturnType<typeof loadIlinkRuntimeConfig> {
  return mode === 'ilink'
    ? loadIlinkRuntimeConfig({
        environment: { ...runtime.env },
        envFile: location.configFile,
        root: location.home,
      })
    : loadInstanceConfig(location, runtime);
}

function prepareDaemonRuntime(
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
) {
  const config = loadDaemonRuntimeConfig(location, runtime, mode);
  const environment = daemonEnvironment(location, runtime, mode);
  return {
    config,
    environment,
    identity: createUpdateRuntimeIdentity(config, {
      ...environment,
      KINTIO_DAEMON_MODE: mode,
    }),
  };
}

async function startIlinkDaemonLocked(
  location: InstanceLocation,
  runtime: CliRuntime,
): Promise<{ readonly created: boolean; readonly runId: string }> {
  const result = await startBackgroundDaemonLocked(
    location,
    runtime,
    ilinkDaemonEnvironment(location, runtime),
    'ilink',
  );
  if (!result.alreadyRunning) {
    runtime.stdout(`Kintio iLink runtime is running in background (PID ${result.pid}).\n`);
  }
  const record = readDaemonRecord(location.home);
  if (!record || record.mode !== 'ilink') {
    if (!result.alreadyRunning) await rollbackLaunch(location, result.daemon);
    throw new Error('Kintio iLink runtime did not publish its daemon identity');
  }
  return { created: !result.alreadyRunning, runId: record.runId };
}

async function rollbackEmptyIlinkDaemonLocked(
  location: InstanceLocation,
  runtime: CliRuntime,
  config: ReturnType<typeof loadIlinkEnrollmentConfig>,
  started: { readonly created: boolean; readonly runId: string },
): Promise<void> {
  if (!started.created) return;
  const record = readDaemonRecord(location.home);
  if (!record || record.mode !== 'ilink' || record.runId !== started.runId) return;
  const snapshot = await runtime.ilinkSnapshot({
    config,
    packageRoot: runtime.packageRoot,
    signal: AbortSignal.timeout(5_000),
  });
  if (snapshot.accounts.some((account) => account.runtimeEnabled)) return;
  await stopDaemon(location, DAEMON_STOP_TIMEOUT_MS);
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
    `Kintio failed to become ready: ${lastError}; inspect the channel logs with "kintio wecom logs" or "kintio ilink logs"`,
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
  await waitForDaemonStopped(location, timeoutMs);
  return 0;
}

async function waitForDaemonStopped(
  location: InstanceLocation,
  timeoutMs: number,
): Promise<void> {
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

type PendingKintioUpdate = Extract<
  PreparedKintioUpdate,
  { readonly kind: 'update' }
>;

interface UpdateSignalGuard {
  readonly throwIfInterrupted: () => void;
}

async function withUpdateSignalGuard<T>(
  task: (guard: UpdateSignalGuard) => Promise<T>,
): Promise<T> {
  const signals: readonly NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let interruptedBy: NodeJS.Signals | undefined;
  const listeners = signals.map((signal) => ({
    signal,
    listener: () => { interruptedBy ||= signal; },
  }));
  for (const { signal, listener } of listeners) process.on(signal, listener);
  try {
    return await task({
      throwIfInterrupted() {
        if (interruptedBy) {
          throw new Error(`Kintio update was interrupted by ${interruptedBy}`);
        }
      },
    });
  } finally {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  }
}

function runtimeAtPackage(
  runtime: CliRuntime,
  packageRoot: string,
): CliRuntime {
  return { ...runtime, packageRoot };
}

function daemonModeLabel(mode: DaemonMode): string {
  return mode === 'ilink' ? 'iLink' : 'wecom';
}

function runtimeAtState(
  runtime: CliRuntime,
  state: RuntimeStateIdentity,
): CliRuntime {
  if (path.basename(state.lockFile) !== 'kintio.lock') {
    throw new Error(`Unsupported Kintio state lock identity: ${state.lockFile}`);
  }
  return { ...runtime, env: { ...runtime.env, KINTIO_DB_FILE: state.databaseFile } };
}

function assertSameState(
  actual: RuntimeStateIdentity,
  expected: RuntimeStateIdentity,
): void {
  if (
    !samePath(actual.databaseFile, expected.databaseFile) ||
    !samePath(actual.lockFile, expected.lockFile)
  ) {
    throw new Error('Kintio could not preserve the running Runtime state identity');
  }
}

function reserveInstanceForUpdate(
  state: { readonly databaseFile: string; readonly lockFile: string },
): InstanceLock {
  try {
    return acquireSingleInstanceLock({
      filePath: state.lockFile,
      hasActiveDatabaseOwner: () =>
        StatePersistence.hasActiveWriter(state.databaseFile),
    });
  } catch (error: unknown) {
    if (error instanceof SingleInstanceLockError) {
      throw new Error(
        'A foreground Kintio Runtime or iLink login is active; stop it before updating',
      );
    }
    throw error;
  }
}

async function restoreBackgroundRuntime(
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
  expected: RuntimeUpdateSnapshot,
): Promise<void> {
  const prepared = prepareDaemonRuntime(location, runtime, mode);
  assertSameState(prepared.config.state, expected.state);
  if (!sameUpdateRuntimeIdentity(prepared.identity, expected.identity)) {
    throw new Error('Kintio configuration changed during the package update');
  }
  const launched = await launchBackgroundDaemon(
    location,
    runtime,
    prepared.environment,
    mode,
  );
  try {
    assertDaemonInstance(location, runtime.packageRoot, mode);
    const record = readDaemonRecord(location.home);
    if (!record) {
      throw new Error('Restored Kintio Runtime did not publish safe identity metadata');
    }
    assertSameState(record.state, expected.state);
    const after = prepareDaemonRuntime(location, runtime, mode);
    assertSameState(after.config.state, expected.state);
    if (!sameUpdateRuntimeIdentity(after.identity, expected.identity)) {
      throw new Error('Kintio configuration changed while restoring the Runtime');
    }
  } catch (error: unknown) {
    try {
      await rollbackLaunch(location, launched.daemon);
    } catch (stopError: unknown) {
      throw new Error(
        `Restored Kintio Runtime identity could not be verified (${
          error instanceof Error ? error.message : String(error)
        }) and the Runtime could not be stopped: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function recoverRuntimeAfterUpdateFailure(
  update: PendingKintioUpdate,
  location: InstanceLocation,
  runtime: CliRuntime,
  mode: DaemonMode,
  expected: RuntimeUpdateSnapshot,
  originalError: unknown,
): Promise<never> {
  try {
    readInstalledPackageIdentity(update.installation.packageRoot);
    await restoreBackgroundRuntime(
      location,
      runtimeAtPackage(runtime, update.installation.packageRoot),
      mode,
      expected,
    );
    runtime.stdout(
      `Kintio ${daemonModeLabel(mode)} Runtime was restored after the failed update.\n`,
    );
  } catch (recoveryError: unknown) {
    throw new Error(
      `Kintio update failed (${
        originalError instanceof Error ? originalError.message : String(originalError)
      }); the previous Runtime could not be restored: ${
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      }`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function daemonStoppedAfterUncertainGate(
  location: InstanceLocation,
  record: DaemonRecord,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = readDaemonRecord(location.home);
    if (!current) return true;
    if (current.runId !== record.runId || current.daemonPid !== record.daemonPid) {
      throw new Error('Kintio Runtime identity changed during its update gate');
    }
    if (!processIsAlive(record.daemonPid)) {
      removeDaemonMetadata(location);
      return true;
    }
    try {
      const state = await requestControl(location.home, 'ping', 500);
      if (state.phase === 'running' || state.phase === 'backoff' || state.phase === 'failed') {
        return false;
      }
      if (state.phase === 'stopping') {
        await waitForDaemonStopped(location, DAEMON_STOP_TIMEOUT_MS);
        return true;
      }
    } catch {
      // The accepted gate may already be closing the control socket.
    }
    await delay(50);
  }
  throw new Error(
    'Kintio Runtime state is uncertain after the update idle gate; no package was installed',
  );
}

async function updateKintio(
  location: InstanceLocation,
  runtime: CliRuntime,
): Promise<number> {
  runtime.stdout('Checking for Kintio updates...\n');
  const prepared = await runtime.updater.prepare({
    packageRoot: runtime.packageRoot,
    currentVersion: KINTIO_VERSION,
    cwd: runtime.homeDirectory,
    inheritedEnvironment: runtime.env,
  });
  if (prepared.kind === 'current') {
    runtime.stdout(
      `No newer Kintio version is available (installed ${KINTIO_VERSION}, ` +
      `Registry ${prepared.targetVersion}).\n`,
    );
    return 0;
  }

  const locations = [...new Map([
    location,
    instanceLocation({}, runtime, 'ilink'),
    instanceLocation({}, runtime, 'wecom'),
  ].map((item) => [path.resolve(item.home), item])).values()];

  return await withUpdateSignalGuard(async (signal) => {
    return await withInstallationUpdateLock(runtime, async () => {
      // Hold both channel lifecycle gates while changing their shared installation.
      const coordinate = async (index: number): Promise<number> => {
        const candidate = locations[index];
        if (candidate) {
          prepareDirectories(candidate.home);
          return withLifecycleLock(candidate, () => coordinate(index + 1));
        }
        const active: InstanceLocation[] = [];
        for (const item of locations) {
          if (await probeDaemon(item)) active.push(item);
        }
        if (active.length > 1) {
          throw new Error('Multiple channel runtimes are running; stop the other channel before updating. No package was changed.');
        }
        location = active[0] || location;
        signal.throwIfInterrupted();
        const diskVersion = readInstalledPackageIdentity(
          prepared.installation.packageRoot,
        ).version;
        if (
          diskVersion !== prepared.currentVersion &&
          diskVersion !== prepared.targetVersion
        ) {
          throw new Error(
            `Installed Kintio changed from ${prepared.currentVersion} to ${diskVersion} ` +
            'while this update was waiting',
          );
        }
        const existing = await probeDaemon(location);
        const record = existing ? readDaemonRecord(location.home) : null;
        let restoredLocation = location;
        let restoredRuntime = runtime;
        let state: RuntimeStateIdentity;
        let snapshot: RuntimeUpdateSnapshot | undefined;
        if (existing) {
          if (!record) throw new Error('Kintio daemon record disappeared during update');
          restoredLocation = {
            home: location.home,
            configFile: record.configFile,
          };
          state = record.state;
          restoredRuntime = runtimeAtState(runtime, state);
          assertDaemonInstance(
            restoredLocation,
            runtime.packageRoot,
            record.mode,
          );
          const daemonRuntime = prepareDaemonRuntime(
            restoredLocation,
            restoredRuntime,
            record.mode,
          );
          assertSameState(daemonRuntime.config.state, state);
          snapshot = { identity: daemonRuntime.identity, state };
        } else {
          state = loadIlinkEnrollmentConfig({
            environment: { ...runtime.env },
            envFile: restoredLocation.configFile,
            root: restoredLocation.home,
          }).state;
        }

        if (record) {
          if (!snapshot) throw new Error('Kintio update snapshot is missing');
          signal.throwIfInterrupted();
          let decision: ControlResponse;
          try {
            decision = await runtime.stopIfIdle(location.home, snapshot.identity);
          } catch (error: unknown) {
            if (await daemonStoppedAfterUncertainGate(restoredLocation, record)) {
              return await recoverRuntimeAfterUpdateFailure(
                prepared,
                restoredLocation,
                restoredRuntime,
                record.mode,
                snapshot,
                error,
              );
            }
            throw error;
          }
          if (!decision.idle) {
            signal.throwIfInterrupted();
            throw new Error(
              'Kintio has active conversation work; no update was installed',
            );
          }
          await waitForDaemonStopped(restoredLocation, DAEMON_STOP_TIMEOUT_MS);
          try {
            signal.throwIfInterrupted();
          } catch (error: unknown) {
            return await recoverRuntimeAfterUpdateFailure(
              prepared,
              restoredLocation,
              restoredRuntime,
              record.mode,
              snapshot,
              error,
            );
          }
        }

        let instanceReservation: InstanceLock;
        try {
          instanceReservation = reserveInstanceForUpdate(state);
        } catch (error: unknown) {
          if (record) {
            return await recoverRuntimeAfterUpdateFailure(
              prepared,
              restoredLocation,
              restoredRuntime,
              record.mode,
              snapshot!,
              error,
            );
          }
          throw error;
        }

        const installedRuntime = runtimeAtPackage(
          restoredRuntime,
          prepared.installation.packageRoot,
        );
        try {
          signal.throwIfInterrupted();
          if (diskVersion !== prepared.targetVersion) {
            runtime.stdout(
              `Updating Kintio ${prepared.currentVersion} -> ${prepared.targetVersion} ` +
              `with ${prepared.installation.manager}...\n`,
            );
            await runtime.updater.install(prepared);
          }
          signal.throwIfInterrupted();
          await runtime.updater.verify(prepared);
          signal.throwIfInterrupted();
        } catch (error: unknown) {
          instanceReservation.release();
          if (error instanceof ProcessTreeTerminationError) {
            throw new Error(
              `${error.message}; the Kintio Runtime remains stopped because package ` +
              'installation may still be changing',
              { cause: error },
            );
          }
          if (record) {
            return await recoverRuntimeAfterUpdateFailure(
              prepared,
              restoredLocation,
              restoredRuntime,
              record.mode,
              snapshot!,
              error,
            );
          }
          throw error;
        }
        instanceReservation.release();

        if (record) {
          try {
            await restoreBackgroundRuntime(
              restoredLocation,
              installedRuntime,
              record.mode,
              snapshot!,
            );
            runtime.stdout(
              `Kintio ${daemonModeLabel(record.mode)} Runtime was restored.\n`,
            );
          } catch (error: unknown) {
            throw new Error(
              `Kintio ${prepared.targetVersion} was installed, but the ${record.mode} ` +
              `Runtime was not restored: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
        }
        signal.throwIfInterrupted();
        runtime.stdout(
          diskVersion === prepared.targetVersion
            ? `Kintio ${prepared.targetVersion} is installed and verified.\n`
            : `Kintio ${prepared.targetVersion} was installed successfully.\n`,
        );
        return 0;
      };
      return coordinate(0);
    });
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

async function runConfiguredIlinkLogin(
  runtime: CliRuntime,
  config: ReturnType<typeof loadIlinkEnrollmentConfig>,
  signal: AbortSignal,
  qrOutputPath?: string,
): Promise<number> {
  return await runtime.ilinkLogin({
    config,
    packageRoot: runtime.packageRoot,
    stdout: runtime.stdout,
    stdoutIsTTY: runtime.stdoutIsTTY,
    stdoutColumns: runtime.stdoutColumns,
    ...(qrOutputPath ? { qrOutputPath } : {}),
    signal,
  });
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
        'qr-output': { type: 'string' },
        account: { type: 'string' },
        foreground: { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (parsed.values.version) {
      runtime.stdout(`${KINTIO_VERSION}\n`);
      return 0;
    }
    const command = parsed.positionals[0];
    const subcommand = parsed.positionals[1];
    if (!command) {
      if (parsed.values['qr-output'] !== undefined) {
        throw new Error('--qr-output is valid only for "kintio ilink login"');
      }
      runtime.stdout(HELP);
      return 0;
    }
    if (command === 'help') {
      if (parsed.positionals.length !== 1) {
        throw new Error(`Unexpected argument: ${subcommand}`);
      }
      runtime.stdout(HELP);
      return 0;
    }
    if (!COMMANDS.has(command)) {
      throw new Error(`Unknown command: ${command}. Use "kintio wecom --help" or "kintio ilink --help".`);
    }
    const lifecycleCommand = command === 'wecom' || command === 'ilink' ? subcommand : command;
    if (command === 'wecom' || command === 'ilink') {
      if ((parsed.values.help || !subcommand) && parsed.positionals.length === 1) {
        runtime.stdout(command === 'wecom' ? WECOM_HELP : ILINK_HELP);
        return 0;
      }
      if (
        !subcommand || !(command === 'wecom' ? WECOM_COMMANDS : ILINK_COMMANDS).has(subcommand) ||
        parsed.positionals.length !== 2
      ) {
        throw new Error(command === 'wecom'
          ? 'Usage: kintio wecom <setup|start|run|stop|restart|status|logs>'
          : 'Usage: kintio ilink <login|list|start|stop|delete|restart|status|logs>');
      }
    } else if (parsed.positionals.length !== 1) {
      throw new Error(`Unexpected argument: ${subcommand}`);
    }
    if (parsed.values.help) {
      runtime.stdout(
        command === 'update' || command === 'upgrade'
          ? UPDATE_HELP
          : command === 'wecom'
            ? WECOM_HELP
          : subcommand === 'login' ? ILINK_LOGIN_HELP
            : subcommand === 'list' ? ILINK_LIST_HELP
              : subcommand === 'start' ? ILINK_START_HELP
                : subcommand === 'stop' ? ILINK_STOP_HELP
                  : subcommand === 'delete' ? ILINK_DELETE_HELP : ILINK_HELP,
      );
      return 0;
    }
    if (
      lifecycleCommand !== 'logs' &&
      (parsed.values.lines !== undefined || parsed.values['no-follow'])
    ) {
      throw new Error('--lines and --no-follow are valid only for "kintio wecom logs" or "kintio ilink logs"');
    }
    if (
      (command !== 'ilink' || subcommand !== 'login') &&
      parsed.values['qr-output'] !== undefined
    ) {
      throw new Error('--qr-output is valid only for "kintio ilink login"');
    }
    if (parsed.values['qr-output'] === '') {
      throw new Error('--qr-output requires a non-empty file path');
    }
    if (
      parsed.values.account !== undefined &&
      (command !== 'ilink' || !['start', 'stop', 'delete'].includes(subcommand || ''))
    ) {
      throw new Error('--account is valid only for "kintio ilink start|stop|delete"');
    }
    if (parsed.values.account === '') {
      throw new Error('--account requires a non-empty account ID or key');
    }
    if (parsed.values.yes && (command !== 'ilink' || subcommand !== 'delete')) {
      throw new Error('--yes is valid only for "kintio ilink delete"');
    }
    if (parsed.values.foreground && (command !== 'ilink' || subcommand !== 'start')) {
      throw new Error('--foreground is valid only for "kintio ilink start"');
    }
    const location = instanceLocation(parsed.values, runtime, command === 'wecom' ? 'wecom' : 'ilink');
    if (command === 'wecom' || command === 'ilink') {
      const existing = readDaemonRecord(location.home);
      if (existing && existing.mode !== command) {
        throw new Error(`This instance belongs to ${existing.mode}; use a separate --home for ${command}`);
      }
    }
    const qrOutputPath = parsed.values['qr-output'] === undefined
      ? undefined
      : resolveInputPath(parsed.values['qr-output'], runtime.cwd);
    if (qrOutputPath && !samePath(path.dirname(qrOutputPath), location.home)) {
      throw new Error('iLink QR output must be directly inside the instance directory');
    }
    if (command === 'ilink' && ILINK_ACCOUNT_COMMANDS.has(subcommand!)) {
      if (privateFile(location.configFile, 'Kintio config')) {
        assertTrustedDirectory(
          path.dirname(location.configFile),
          'Kintio config directory',
          false,
        );
      }
      prepareDirectories(location.home);
      const foreground = Boolean(parsed.values.foreground);
      const interactive = runtime.stdinIsTTY && runtime.stdoutIsTTY;
      const operation = () => runWithIlinkSignals(async (signal) => {
        let automaticLoginSucceeded = false;
        let preserveErrorAfterAbort = false;
        try {
          const enrollmentConfig = loadIlinkEnrollmentConfig({
            environment: { ...runtime.env },
            envFile: location.configFile,
            root: location.home,
          });
          if (subcommand === 'login') {
            return await runConfiguredIlinkLogin(
              runtime,
              enrollmentConfig,
              signal,
              qrOutputPath,
            );
          }
          if (subcommand === 'list') {
            await runtime.ilinkAccount({
              command: 'list',
              config: enrollmentConfig,
              packageRoot: runtime.packageRoot,
              signal,
              stdout: runtime.stdout,
            });
            return 0;
          }

          let snapshot = await runtime.ilinkSnapshot({
            config: enrollmentConfig,
            packageRoot: runtime.packageRoot,
            signal,
          });
          const selector = parsed.values.account;
          if (
            subcommand === 'start' &&
            !selector &&
            snapshot.accounts.length === 0
          ) {
            if (!interactive) {
              throw new Error(
                'No iLink account is enrolled; run "kintio ilink login" first',
              );
            }
            const login = () => runConfiguredIlinkLogin(
              runtime,
              enrollmentConfig,
              signal,
            );
            const loginResult = foreground
              ? await login()
              : await withLifecycleLock(location, login);
            if (loginResult !== 0) return loginResult;
            signal.throwIfAborted();
            automaticLoginSucceeded = true;
            snapshot = await runtime.ilinkSnapshot({
              config: enrollmentConfig,
              packageRoot: runtime.packageRoot,
              signal,
            });
            if (snapshot.accounts.length === 0) {
              throw new Error('iLink login completed without enrolling an account');
            }
          }

          if (
            subcommand === 'delete' &&
            !interactive &&
            (!selector || !parsed.values.yes)
          ) {
            throw new Error(
              'Non-interactive iLink deletion requires --account and --yes',
            );
          }
          const selected = selector || snapshot.accounts.length <= 1 || !interactive
            ? resolveIlinkAccount(
                snapshot.accounts,
                selector,
                snapshot.mode === 'runtime',
              )
            : await runtime.ilinkPickAccount({
                accounts: snapshot.accounts,
                command: subcommand as 'start' | 'stop' | 'delete',
                runtimeActive: snapshot.mode === 'runtime',
                signal,
              });
          if (!selected) {
            runtime.stdout('Cancelled; no changes made.\n');
            return 0;
          }
          signal.throwIfAborted();

          let confirmed = Boolean(parsed.values.yes);
          if (subcommand === 'delete' && !confirmed) {
            if (!interactive) {
              throw new Error('Non-interactive iLink deletion requires --yes');
            }
            confirmed = await runtime.ilinkConfirmDelete({
              account: selected,
              signal,
            });
            if (!confirmed) {
              runtime.stdout('Cancelled; no changes made.\n');
              return 0;
            }
            signal.throwIfAborted();
          }

          const dispatchMutation = async <T>(mutation: () => Promise<T>): Promise<T> => {
            signal.throwIfAborted();
            let result: T;
            try {
              result = await mutation();
            } catch (error: unknown) {
              if (signal.aborted) preserveErrorAfterAbort = true;
              throw error;
            }
            signal.throwIfAborted();
            return result;
          };
          const mutate = async (): Promise<number> => {
            const commandResult = await dispatchMutation(() => runtime.ilinkAccount({
              command: subcommand as 'start' | 'stop' | 'delete',
              expectedAccount: selected,
              requiredMode: snapshot.mode,
              confirmed,
              config: enrollmentConfig,
              packageRoot: runtime.packageRoot,
              signal,
              stdout: runtime.stdout,
              ...(subcommand === 'start'
                ? { deferStandaloneStart: !foreground }
                : {}),
            }));
            if (subcommand !== 'start' || !commandResult.runtimeRequired) return 0;
            const runtimeConfig = loadIlinkRuntimeConfig({
              environment: { ...runtime.env },
              envFile: location.configFile,
              root: location.home,
            });
            if (foreground) {
              return await runtime.ilinkStart({
                config: runtimeConfig,
                signal,
                stdout: runtime.stdout,
              });
            }
            if (!commandResult.selectedAccountKey) {
              throw new Error('iLink start did not resolve an account identity');
            }
            signal.throwIfAborted();
            const started = await startIlinkDaemonLocked(location, runtime);
            try {
              signal.throwIfAborted();
              await dispatchMutation(() => runtime.ilinkAccount({
                command: 'start',
                expectedAccount: selected,
                requiredMode: 'runtime',
                config: enrollmentConfig,
                packageRoot: runtime.packageRoot,
                signal,
                stdout: runtime.stdout,
              }));
            } catch (error: unknown) {
              try {
                await rollbackEmptyIlinkDaemonLocked(
                  location,
                  runtime,
                  enrollmentConfig,
                  started,
                );
              } catch (rollbackError: unknown) {
                if (signal.aborted) preserveErrorAfterAbort = true;
                throw new Error(
                  `${error instanceof Error ? error.message : String(error)}; ` +
                  `the newly started iLink Runtime could not be rolled back: ${
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError)
                  }`,
                  { cause: error },
                );
              }
              throw error;
            }
            return 0;
          };
          return foreground || snapshot.mode === 'runtime'
            ? await mutate()
            : await withLifecycleLock(location, mutate);
        } catch (error: unknown) {
          if (
            error instanceof IlinkPromptInterruptedError ||
            (signal.aborted && !preserveErrorAfterAbort)
          ) return 130;
          if (automaticLoginSucceeded) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; ` +
              'iLink login succeeded, retry "kintio ilink start" with the same instance options',
              { cause: error },
            );
          }
          throw error;
        }
      });
      return subcommand === 'login' || (subcommand === 'start' && foreground)
        ? await withLifecycleLock(location, operation)
        : await operation();
    }
    if (lifecycleCommand === 'setup') return setup(location, runtime);
    if (lifecycleCommand === 'update' || lifecycleCommand === 'upgrade') {
      return await updateKintio(location, runtime);
    }
    if (lifecycleCommand === 'start') return await start(location, runtime);
    if (lifecycleCommand === 'restart') return await restart(location, runtime, command === 'wecom' ? 'wecom' : 'ilink');
    if (lifecycleCommand === 'run') {
      const environment = processEnvironment(location, runtime);
      return await withLifecycleLock(location, () => runtime.execute({
          file: process.execPath,
          args: [path.join(runtime.packageRoot, 'dist/wecom.js')],
          env: { ...environment, KINTIO_MANAGED_WORKER: '1' },
        }));
    }
    if (lifecycleCommand === 'stop') return await stop(runtime, location);
    if (lifecycleCommand === 'status') {
      const existing = await probeDaemon(location);
      if (!existing) {
        runtime.stdout('Kintio is not running.\n');
        return 0;
      }
      assertDaemonInstance(location, runtime.packageRoot);
      runtime.stdout(
        `Kintio is ${existing.phase} in ${readDaemonRecord(location.home)?.mode || 'wecom'} mode ` +
        `(daemon PID ${existing.daemonPid}` +
        `${existing.workerPid ? `, worker PID ${existing.workerPid}` : ''}).` +
        `${existing.message ? ` ${existing.message}` : ''}\n`,
      );
      return existing.phase === 'failed' ? 1 : 0;
    }
    if (lifecycleCommand === 'logs') {
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
