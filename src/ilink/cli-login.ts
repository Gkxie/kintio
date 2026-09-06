import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { IlinkEnrollmentConfig } from '../config.ts';
import { assertTrustedDirectory } from '../lib/private-directory.ts';
import {
  RuntimeOperatorClient,
  type IlinkAccountControl,
  type IlinkOperatorAccount,
  type IlinkOperatorControl,
} from '../runtime/operator-client.ts';
import {
  acquireSingleInstanceLock,
  type InstanceLock,
  SingleInstanceLockError,
} from '../runtime/single-instance-lock.ts';
import { StatePersistence } from '../state/persistence.ts';
import {
  renderIlinkQrTerminal,
  renderIlinkRawQrPng,
} from './qr.ts';
import type { IlinkLoginStatus } from './login-store.ts';
import type {
  IlinkAccountWithSecret,
  IlinkSqliteStore,
} from './sqlite-store.ts';
import {
  assertIlinkAccountRevision,
  createIlinkAccountIncarnation,
  type IlinkAccountRevision,
} from './store-types.ts';

const STATUS_POLL_MS = 1_000;
export interface IlinkCliLoginOptions {
  readonly config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>;
  readonly packageRoot: string;
  readonly stdout: (text: string) => void;
  readonly stdoutIsTTY: boolean;
  readonly stdoutColumns: number;
  readonly qrOutputPath?: string;
  readonly signal: AbortSignal;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly openControl?: () => Promise<IlinkOperatorControl>;
  /** A caller-owned connection retained across login and account activation. */
  readonly control?: () => Promise<IlinkOperatorControl>;
}

interface TemporaryQrOutput {
  readonly filePath: string;
  readonly device: number;
  readonly inode: number;
}

function prepareQrOutput(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error('iLink QR output path must be absolute');
  }
  const parentPath = path.dirname(filePath);
  let parent: fs.Stats;
  try {
    parent = fs.lstatSync(parentPath);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`iLink QR output parent does not exist: ${parentPath}`);
    }
    throw error;
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`iLink QR output parent is not a regular directory: ${parentPath}`);
  }
  assertTrustedDirectory(parentPath, 'iLink QR output directory', true);
  try {
    fs.lstatSync(filePath);
    throw new Error(`iLink QR output already exists: ${filePath}`);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

function writeQrOutput(filePath: string, png: Buffer): TemporaryQrOutput {
  let descriptor: number | undefined;
  let output: TemporaryQrOutput | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    created = true;
    const stat = fs.fstatSync(descriptor);
    output = Object.freeze({
      filePath,
      device: stat.dev,
      inode: stat.ino,
    });
    fs.writeFileSync(descriptor, png);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return output;
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (closeError: unknown) {
        cleanupErrors.push(closeError);
      }
      descriptor = undefined;
    }
    if (created) {
      try {
        if (output) removeQrOutput(output);
        else fs.unlinkSync(filePath);
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Unable to remove incomplete iLink QR output',
      );
    }
    throw error;
  }
}

function removeQrOutput(output: TemporaryQrOutput): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(output.filePath);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (
    !stat.isFile() || stat.isSymbolicLink() ||
    stat.dev !== output.device || stat.ino !== output.inode
  ) {
    throw new Error(`Temporary iLink QR output was replaced and was not removed: ${output.filePath}`);
  }
  fs.unlinkSync(output.filePath);
}

function operatorAccountFromStored(
  stored: IlinkAccountWithSecret,
): IlinkOperatorAccount {
  return Object.freeze({
    accountKey: stored.account.accountKey,
    generation: stored.account.generation,
    incarnation: createIlinkAccountIncarnation(stored.account, stored.secret),
    providerAccountId: stored.account.providerAccountId,
    runtimeEnabled: stored.account.runtimeEnabled,
  });
}

class LocalIlinkOperatorControl implements IlinkAccountControl {
  readonly mode = 'standalone' as const;
  readonly #persistence: StatePersistence;
  readonly #lock: InstanceLock;
  readonly #accounts: IlinkSqliteStore;
  #closed = false;

  private constructor(
    persistence: StatePersistence,
    lock: InstanceLock,
  ) {
    this.#persistence = persistence;
    this.#lock = lock;
    this.#accounts = persistence.createIlinkStore();
  }

  static async open(
    config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>,
  ): Promise<LocalIlinkOperatorControl> {
    const lock = acquireSingleInstanceLock({
      filePath: config.state.lockFile,
      hasActiveDatabaseOwner: () =>
        StatePersistence.hasActiveWriter(config.state.databaseFile),
    });
    let persistence: StatePersistence | undefined;
    try {
      persistence = new StatePersistence({ filePath: config.state.databaseFile });
      return new LocalIlinkOperatorControl(persistence, lock);
    } catch (error: unknown) {
      const cleanupErrors: unknown[] = [];
      try { persistence?.close(); } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
      if (!persistence || persistence.closed) {
        try {
          if (!lock.release()) cleanupErrors.push(new Error('iLink operator lock was not released'));
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError);
        }
      } else {
        cleanupErrors.push(new Error('iLink state stayed open; its instance lock was retained'));
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Offline iLink account initialization and cleanup both failed',
        );
      }
      throw error;
    }
  }

  listAccounts(): Promise<readonly IlinkOperatorAccount[]> {
    return Promise.resolve(Object.freeze(
      this.#accounts.listActiveAccountsWithSecrets().map(operatorAccountFromStored),
    ));
  }

  setAccountRuntime(
    accountKey: `ia_${string}`,
    enabled: boolean,
    expected: IlinkAccountRevision,
  ) {
    const stored = this.#accounts.getAccountWithSecret(accountKey);
    assertIlinkAccountRevision(
      stored ? operatorAccountFromStored(stored) : undefined,
      expected,
    );
    const account = enabled
      ? this.#accounts.selectRuntimeAccount(accountKey)
      : this.#accounts.setRuntimeEnabled(accountKey, false);
    return Promise.resolve({
      account: {
        accountKey: account.accountKey,
        generation: account.generation,
        incarnation: createIlinkAccountIncarnation(account, stored!.secret),
        providerAccountId: account.providerAccountId,
        runtimeEnabled: account.runtimeEnabled,
      },
      runningCount: this.#accounts.listRuntimeAccountsWithSecrets().length,
    });
  }

  deleteAccount(
    accountKey: `ia_${string}`,
    expected: IlinkAccountRevision,
  ) {
    const stored = this.#accounts.getAccountWithSecret(accountKey);
    assertIlinkAccountRevision(
      stored ? operatorAccountFromStored(stored) : undefined,
      expected,
    );
    const account = this.#accounts.deleteAccountCompletely(accountKey);
    return Promise.resolve({
      account: {
        accountKey: account.accountKey,
        generation: account.generation,
        incarnation: createIlinkAccountIncarnation(account, stored!.secret),
        providerAccountId: account.providerAccountId,
        runtimeEnabled: account.runtimeEnabled,
      },
      runningCount: this.#accounts.listRuntimeAccountsWithSecrets().length,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const errors: unknown[] = [];
    try { this.#persistence.core.checkpoint('TRUNCATE'); } catch (error: unknown) {
      errors.push(error);
    }
    try { this.#persistence.close(); } catch (error: unknown) {
      errors.push(error);
    }
    if (this.#persistence.closed) {
      try {
        if (!this.#lock.release()) errors.push(new Error('iLink operator lock was not released'));
      } catch (error: unknown) {
        errors.push(error);
      }
    } else {
      errors.push(new Error('iLink state stayed open; its instance lock was retained'));
    }
    this.#closed = this.#persistence.closed;
    if (errors.length) {
      throw new AggregateError(errors, 'Offline iLink account cleanup failed');
    }
  }
}

export async function openIlinkOperatorControl(
  config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>,
  packageRoot: string,
  signal: AbortSignal,
  requiredMode?: 'runtime' | 'standalone',
): Promise<IlinkAccountControl> {
  if (requiredMode === 'runtime') {
    try {
      return await RuntimeOperatorClient.connect(config, packageRoot);
    } catch (error: unknown) {
      throw new Error('The iLink Runtime changed; select the account again', {
        cause: error,
      });
    }
  }
  if (requiredMode === 'standalone') {
    try {
      return await LocalIlinkOperatorControl.open(config);
    } catch (error: unknown) {
      throw new Error('The standalone iLink state changed; select the account again', {
        cause: error,
      });
    }
  }
  try {
    return await RuntimeOperatorClient.connect(config, packageRoot);
  } catch (ipcError: unknown) {
    try {
      return await LocalIlinkOperatorControl.open(config);
    } catch (localError: unknown) {
      if (!(localError instanceof SingleInstanceLockError)) throw localError;
      if (localError.owner?.pid !== process.pid) {
        const deadline = Date.now() + 5_000;
        while (!signal.aborted && Date.now() < deadline) {
          await delay(100, undefined, { signal });
          try {
            return await RuntimeOperatorClient.connect(config, packageRoot);
          } catch {}
        }
      }
      throw new Error(
        'This Kintio instance is running, but its private iLink operator control is unavailable',
        { cause: ipcError },
      );
    }
  }
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal });
}

function terminalMessage(status: Exclude<IlinkLoginStatus, 'waiting' | 'scanned'>): string {
  switch (status) {
    case 'confirmed': return 'iLink login succeeded.\n';
    case 'expired': return 'iLink login QR code expired.\n';
    case 'cancelled': return 'iLink login was cancelled.\n';
    case 'already_connected':
      return 'The iLink account is already connected; host authorization is confirmed.\n';
    case 'verification_required':
      return 'This iLink login requires verification that the CLI does not support.\n';
    case 'failed': return 'iLink login failed.\n';
    case 'unknown': return 'The iLink login session is no longer available.\n';
  }
}

function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

async function cancelQuietly(control: IlinkOperatorControl, offerId: string): Promise<void> {
  try { await control.cancel(offerId); } catch {}
}

async function cancelOrReadFinal(
  control: IlinkOperatorControl,
  offerId: string,
): Promise<IlinkLoginStatus | undefined> {
  try {
    if (await control.cancel(offerId)) return 'cancelled';
  } catch {}
  try {
    return (await control.status(offerId, new AbortController().signal)).status;
  } catch {
    return undefined;
  }
}

function loginSucceeded(
  status: IlinkLoginStatus,
): status is 'confirmed' | 'already_connected' {
  return status === 'confirmed' || status === 'already_connected';
}

export async function runIlinkCliLogin(options: IlinkCliLoginOptions): Promise<number> {
  if (!options.stdoutIsTTY && !options.qrOutputPath) {
    throw new Error(
      'iLink login requires an interactive terminal, or use --qr-output <file>',
    );
  }
  if (options.qrOutputPath) prepareQrOutput(options.qrOutputPath);
  const clock = options.clock || Date.now;
  const sleep = options.sleep || defaultSleep;
  const openControl = options.openControl || (() =>
    RuntimeOperatorClient.connect(options.config, options.packageRoot));
  let control: IlinkOperatorControl | undefined;
  let offerId = '';
  let qrOutput: TemporaryQrOutput | undefined;
  try {
    control = options.control ? await options.control() : await openControl();
    const offer = await control.begin(options.signal);
    offerId = offer.offerId;
    if (options.qrOutputPath) {
      qrOutput = writeQrOutput(
        options.qrOutputPath,
        await renderIlinkRawQrPng(offer.qrContent),
      );
      options.stdout(
        `Temporary QR image: ${JSON.stringify(options.qrOutputPath)}\n` +
        'Scan it with WeChat within 5 minutes. The file will be removed when login ends.\n' +
        'Waiting for scan...\n',
      );
    } else {
      const qr = renderIlinkQrTerminal(offer.qrContent);
      if (options.stdoutColumns < qr.columns) {
        await cancelQuietly(control, offerId);
        offerId = '';
        throw new Error(
          `Terminal is too narrow for this QR code; ${qr.columns} columns are required`,
        );
      }
      options.stdout(
        `Scan this QR code with WeChat within 5 minutes:\n\n${qr.text}\n` +
        'Waiting for scan...\n',
      );
    }
    let lastStatus: IlinkLoginStatus = 'waiting';
    while (true) {
      const current = await control.status(offerId, options.signal);
      if (current.status === 'scanned' && lastStatus !== 'scanned') {
        options.stdout('QR scanned. Confirm the login in WeChat.\n');
      }
      if (current.status !== 'waiting' && current.status !== 'scanned') {
        options.stdout(terminalMessage(current.status));
        offerId = '';
        return loginSucceeded(current.status) ? 0 : 1;
      }
      lastStatus = current.status;
      if (clock() >= offer.expiresAt) {
        const finalStatus = await cancelOrReadFinal(control, offerId);
        offerId = '';
        if (finalStatus && finalStatus !== 'cancelled') {
          options.stdout(terminalMessage(
            finalStatus === 'waiting' || finalStatus === 'scanned'
              ? 'expired'
              : finalStatus,
          ));
          return loginSucceeded(finalStatus) ? 0 : 1;
        }
        options.stdout(terminalMessage('expired'));
        return 1;
      }
      await sleep(STATUS_POLL_MS, options.signal);
    }
  } catch (error: unknown) {
    if (!aborted(error, options.signal)) {
      const finalStatus = offerId
        ? await cancelOrReadFinal(control!, offerId)
        : undefined;
      if (finalStatus && loginSucceeded(finalStatus)) {
        options.stdout(terminalMessage(finalStatus));
        return 0;
      }
      throw error;
    }
    const finalStatus = offerId
      ? await cancelOrReadFinal(control!, offerId)
      : undefined;
    if (finalStatus && loginSucceeded(finalStatus)) {
      options.stdout(terminalMessage(finalStatus));
      return 0;
    }
    options.stdout('iLink login was cancelled.\n');
    return 130;
  } finally {
    try {
      if (qrOutput) removeQrOutput(qrOutput);
    } finally {
      if (!options.control) await control?.close();
    }
  }
}
