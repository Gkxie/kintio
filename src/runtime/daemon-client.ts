import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import crossSpawn from 'cross-spawn';

import { DAEMON_STOP_TIMEOUT_MS, loadSharedRuntimeConfig, parseStartTimeout } from '../config.ts';
import { samePath } from '../lib/path-identity.ts';
import { privateFile } from '../lib/private-file.ts';
import { assertTrustedDirectory, ensureContainedDirectory, ensurePrivateDirectory } from '../lib/private-directory.ts';
import { acquireSingleInstanceLock, processIsAlive, SingleInstanceLockError } from './single-instance-lock.ts';
import {
  createUpdateRuntimeIdentity,
  daemonRecordPath,
  readDaemonRecord,
  requestControl,
  type ControlResponse,
  type DaemonRecord,
} from './daemon-protocol.ts';

export interface RuntimeLocation {
  readonly home: string;
  readonly configFile: string;
}

export interface DaemonLaunchContext {
  readonly env: NodeJS.ProcessEnv;
  readonly packageRoot: string;
  readonly launchDaemon: (request: DaemonLaunchRequest) => DaemonProcess;
}

export interface DaemonLaunchRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface DaemonProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  readonly kill: (signal: NodeJS.Signals) => boolean;
}

export function defaultLaunchDaemon(request: DaemonLaunchRequest): DaemonProcess {
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

export function prepareRuntimeDirectory(home: string): void {
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

export function removeDaemonMetadata(location: RuntimeLocation): void {
  fs.rmSync(daemonRecordPath(location.home), { force: true });
}

export async function probeDaemon(location: RuntimeLocation): Promise<ControlResponse | undefined> {
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

export function assertDaemonInstance(
  location: RuntimeLocation,
  packageRoot: string,
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
}

export async function withLifecycleLock<T>(
  location: RuntimeLocation,
  task: () => Promise<T>,
  waitSignal?: AbortSignal,
): Promise<T> {
  const dataDirectory = ensureContainedDirectory(
    location.home,
    path.join(location.home, 'data'),
  );
  let lock;
  const deadline = Date.now() + 30_000;
  while (!lock) {
    waitSignal?.throwIfAborted();
    try {
      lock = acquireSingleInstanceLock({
        filePath: path.join(dataDirectory, 'lifecycle.lock'),
        hasActiveDatabaseOwner: () => false,
      });
    } catch (error: unknown) {
      if (!(error instanceof SingleInstanceLockError)) throw error;
      if (!waitSignal || Date.now() >= deadline) {
        throw new Error('Another Kintio lifecycle command is already running');
      }
      await delay(50, undefined, { signal: waitSignal });
    }
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

function removeLaunchMetadata(location: RuntimeLocation, daemonPid: number): void {
  try {
    if (readDaemonRecord(location.home)?.daemonPid !== daemonPid) return;
  } catch {
    // The newly launched target may use a newer metadata schema.
  }
  fs.rmSync(daemonRecordPath(location.home), { force: true });
}

export async function rollbackLaunch(
  location: RuntimeLocation,
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

export async function startBackgroundDaemonLocked(
  location: RuntimeLocation,
  runtime: DaemonLaunchContext,
  environment: NodeJS.ProcessEnv,
  timeout = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS),
): Promise<
  | { readonly alreadyRunning: true; readonly pid: number }
  | { readonly alreadyRunning: false; readonly daemon: DaemonProcess; readonly pid: number }
> {
  let existing = await probeDaemon(location);
  if (existing?.phase === 'stopping') {
    await waitForDaemonStopped(location, DAEMON_STOP_TIMEOUT_MS);
    existing = undefined;
  }
  if (existing) {
    assertDaemonInstance(location, runtime.packageRoot);
    if (existing.phase !== 'running') {
      await waitUntilRunning(location, Date.now() + timeout);
      existing = await requestControl(location.home, 'ping');
    }
    return {
      alreadyRunning: true,
      pid: existing.workerPid || existing.daemonPid,
    };
  }
  return await launchBackgroundDaemon(location, runtime, environment, timeout);
}

export async function launchBackgroundDaemon(
  location: RuntimeLocation,
  runtime: DaemonLaunchContext,
  environment: NodeJS.ProcessEnv,
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
    env: { ...environment, KINTIO_DAEMON_MODE: 'shared' },
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

async function waitUntilRunning(
  location: RuntimeLocation,
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

export async function waitForDaemonStopped(
  location: RuntimeLocation,
  timeoutMs: number,
  expectedRunId?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const daemonLock = path.join(location.home, 'data/daemon.lock');
  while (true) {
    const record = readDaemonRecord(location.home);
    if (expectedRunId !== undefined && record && record.runId !== expectedRunId) return;
    if (!record && !fs.existsSync(daemonLock)) return;
    if (Date.now() >= deadline) {
      throw new Error('Kintio daemon did not stop within the shutdown budget');
    }
    const waitMs = Math.min(50, deadline - Date.now());
    if (waitMs > 0) await delay(waitMs);
  }
}

export function prepareRuntimeLaunch(location: RuntimeLocation, runtime: Pick<DaemonLaunchContext, 'env'>) {
  if (privateFile(location.configFile, 'Kintio config')) {
    assertTrustedDirectory(path.dirname(location.configFile), 'Kintio config directory', false);
  }
  const config = loadSharedRuntimeConfig({
    environment: { ...runtime.env }, envFile: location.configFile, root: location.home,
  });
  const environment = {
    ...runtime.env,
    KINTIO_HOME: location.home,
    KINTIO_CONFIG_FILE: location.configFile,
    NODE_ENV: 'production',
  };
  return {
    config,
    environment,
    identity: createUpdateRuntimeIdentity(config, { ...environment, KINTIO_DAEMON_MODE: 'shared' }),
  };
}
