import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DAEMON_STOP_TIMEOUT_MS, loadIlinkEnrollmentConfig } from '../config.ts';
import { samePath } from '../lib/path-identity.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';
import { acquireSingleInstanceLock, SingleInstanceLockError, processIsAlive, type InstanceLock } from '../runtime/single-instance-lock.ts';
import {
  readDaemonRecord,
  requestControl,
  sameUpdateRuntimeIdentity,
  type ControlResponse,
  type DaemonRecord,
  type UpdateRuntimeIdentity,
} from '../runtime/daemon-protocol.ts';
import {
  assertDaemonInstance,
  launchBackgroundDaemon,
  prepareRuntimeDirectory,
  prepareRuntimeLaunch,
  probeDaemon,
  removeDaemonMetadata,
  rollbackLaunch,
  waitForDaemonStopped,
  withLifecycleLock,
  type DaemonLaunchContext,
  type RuntimeLocation,
} from '../runtime/daemon-client.ts';
import { StatePersistence } from '../state/persistence.ts';
import { KINTIO_VERSION } from '../version.ts';
import { readInstalledPackageIdentity } from './global-install.ts';
import {
  ProcessTreeTerminationError,
  type PreparedKintioUpdate,
  type prepareKintioUpdate,
  type installPreparedKintioUpdate,
  type verifyPreparedKintioUpdate,
} from './self-update.ts';

export interface UpdateContext extends DaemonLaunchContext {
  readonly homeDirectory: string;
  readonly stdout: (text: string) => void;
  readonly stopIfIdle: (home: string, identity: UpdateRuntimeIdentity) => Promise<ControlResponse>;
  readonly updater: {
    readonly prepare: typeof prepareKintioUpdate;
    readonly install: typeof installPreparedKintioUpdate;
    readonly verify: typeof verifyPreparedKintioUpdate;
  };
}

type PendingKintioUpdate = Extract<PreparedKintioUpdate, { readonly kind: 'update' }>;

interface RuntimeStateIdentity {
  readonly databaseFile: string;
  readonly lockFile: string;
}

interface RuntimeUpdateSnapshot {
  readonly identity: UpdateRuntimeIdentity;
  readonly state: RuntimeStateIdentity;
}

interface UpdateSignalGuard {
  readonly throwIfInterrupted: () => void;
}

async function withInstallationUpdateLock<T>(
  runtime: UpdateContext,
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
  location: RuntimeLocation,
  runtime: UpdateContext,
  expected: RuntimeUpdateSnapshot,
): Promise<void> {
  const prepared = prepareRuntimeLaunch(location, runtime);
  assertSameState(prepared.config.state, expected.state);
  if (!sameUpdateRuntimeIdentity(prepared.identity, expected.identity)) {
    throw new Error('Kintio configuration changed during the package update');
  }
  const launched = await launchBackgroundDaemon(
    location,
    runtime,
    prepared.environment,
  );
  try {
    assertDaemonInstance(location, runtime.packageRoot);
    const record = readDaemonRecord(location.home);
    if (!record) {
      throw new Error('Restored Kintio Runtime did not publish safe identity metadata');
    }
    assertSameState(record.state, expected.state);
    const after = prepareRuntimeLaunch(location, runtime);
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
  location: RuntimeLocation,
  runtime: UpdateContext,
  expected: RuntimeUpdateSnapshot,
  originalError: unknown,
): Promise<never> {
  try {
    readInstalledPackageIdentity(update.installation.packageRoot);
    await restoreBackgroundRuntime(
      location,
      { ...runtime, packageRoot: update.installation.packageRoot },
      expected,
    );
    runtime.stdout(
      `Kintio shared Runtime was restored after the failed update.\n`,
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
  location: RuntimeLocation,
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

export async function updateKintio(
  location: RuntimeLocation,
  runtime: UpdateContext,
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

  const defaultHome = path.resolve(runtime.homeDirectory, '.kintio');
  const locations = [...new Map([
    location,
    // A custom home must not hide the default shared runtime from the update gate.
    { home: defaultHome, configFile: path.join(defaultHome, '.env') },
  ].map((item) => [path.resolve(item.home), item])).values()];

  return await withUpdateSignalGuard(async (signal) => {
    return await withInstallationUpdateLock(runtime, async () => {
      // Hold the shared lifecycle gate throughout the installation update.
      const coordinate = async (index: number): Promise<number> => {
        const candidate = locations[index];
        if (candidate) {
          prepareRuntimeDirectory(candidate.home);
          return withLifecycleLock(candidate, () => coordinate(index + 1));
        }
        const active: RuntimeLocation[] = [];
        for (const item of locations) {
          if (await probeDaemon(item)) active.push(item);
        }
        if (active.length > 1) {
          throw new Error('Multiple Kintio homes are running; stop the other runtime before updating. No package was changed.');
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
          if (path.basename(state.lockFile) !== 'kintio.lock') {
            throw new Error('Unsupported Kintio state lock identity: ' + state.lockFile);
          }
          restoredRuntime = { ...runtime, env: { ...runtime.env, KINTIO_DB_FILE: state.databaseFile } };
          assertDaemonInstance(
            restoredLocation,
            runtime.packageRoot,
          );
          const daemonRuntime = prepareRuntimeLaunch(
            restoredLocation,
            restoredRuntime,
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
              snapshot!,
              error,
            );
          }
          throw error;
        }

        const installedRuntime = { ...restoredRuntime, packageRoot: prepared.installation.packageRoot };
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
              snapshot!,
            );
            runtime.stdout(
              `Kintio shared Runtime was restored.\n`,
            );
          } catch (error: unknown) {
            throw new Error(
              `Kintio ${prepared.targetVersion} was installed, but the shared ` +
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
