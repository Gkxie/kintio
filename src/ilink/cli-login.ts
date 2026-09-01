import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { IlinkEnrollmentConfig } from '../config.ts';
import { assertTrustedDirectory } from '../lib/private-directory.ts';
import {
  findMcpDescriptorFile,
  operatorMcpInstanceKey,
} from '../mcp/ipc-protocol.ts';
import { KINTIO_VERSION } from '../version.ts';
import {
  acquireSingleInstanceLock,
  type InstanceLock,
  SingleInstanceLockError,
} from '../runtime/single-instance-lock.ts';
import { StatePersistence } from '../state/persistence.ts';
import { createIlinkEnrollmentService } from './enrollment.ts';
import {
  renderIlinkQrTerminal,
  renderIlinkRawQrPng,
} from './qr.ts';
import type { IlinkLoginStatus } from './login-store.ts';
import type { IlinkSqliteStore } from './sqlite-store.ts';

const STATUS_POLL_MS = 1_000;
const OFFER_ID = /^qo_[A-Za-z0-9_-]{1,128}$/u;
const ACCOUNT_KEY = /^ia_[0-9a-f]{40}$/u;
const LOGIN_STATUSES = new Set<IlinkLoginStatus>([
  'waiting',
  'scanned',
  'confirmed',
  'expired',
  'failed',
  'cancelled',
  'already_connected',
  'verification_required',
  'unknown',
]);

export interface IlinkOperatorAccount {
  readonly accountKey: `ia_${string}`;
  readonly providerAccountId: string;
  readonly runtimeEnabled: boolean;
}

export interface IlinkOperatorControl {
  readonly mode: 'runtime' | 'standalone';
  begin(signal: AbortSignal): Promise<{
    readonly offerId: string;
    readonly qrContent: string;
    readonly expiresAt: number;
  }>;
  status(offerId: string, signal: AbortSignal): Promise<{
    readonly status: IlinkLoginStatus;
  }>;
  cancel(offerId: string): Promise<boolean>;
  listAccounts(): Promise<readonly IlinkOperatorAccount[]>;
  setAccountRuntime(
    accountKey: `ia_${string}`,
    enabled: boolean,
  ): Promise<{ readonly account: IlinkOperatorAccount; readonly runningCount: number }>;
  deleteAccount(
    accountKey: `ia_${string}`,
  ): Promise<{ readonly account: IlinkOperatorAccount; readonly runningCount: number }>;
  close(): Promise<void>;
}

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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid response from the Kintio runtime');
  }
  return value as Record<string, unknown>;
}

function resultError(result: Record<string, unknown>): never {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content.find((item) =>
    item && typeof item === 'object' && 'type' in item && item.type === 'text');
  const message = first && typeof first === 'object' && 'text' in first
    ? String(first.text || '')
    : '';
  throw new Error(message || 'The Kintio runtime rejected the iLink login operation');
}

function structured(result: unknown): Record<string, unknown> {
  const response = record(result);
  if (response.isError) resultError(response);
  return record(response.structuredContent);
}

function operatorAccount(value: unknown): IlinkOperatorAccount {
  const account = record(value);
  const accountKey = String(account.accountKey || '');
  const providerAccountId = String(account.providerAccountId || '');
  if (
    !ACCOUNT_KEY.test(accountKey) ||
    !providerAccountId || Buffer.byteLength(providerAccountId, 'utf8') > 512 ||
    typeof account.runtimeEnabled !== 'boolean'
  ) {
    throw new Error('Invalid iLink account response from the Kintio runtime');
  }
  return Object.freeze({
    accountKey: accountKey as `ia_${string}`,
    providerAccountId,
    runtimeEnabled: account.runtimeEnabled,
  });
}

function accountMutation(value: Record<string, unknown>) {
  const runningCount = Number(value.runningCount);
  if (!Number.isSafeInteger(runningCount) || runningCount < 0) {
    throw new Error('Invalid iLink runtime count from the Kintio runtime');
  }
  return Object.freeze({
    account: operatorAccount(value.account),
    runningCount,
  });
}

class McpIlinkOperatorControl implements IlinkOperatorControl {
  readonly mode = 'runtime' as const;
  readonly #client: Client;
  readonly #transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.#client = client;
    this.#transport = transport;
  }

  static async connect(
    config: Pick<IlinkEnrollmentConfig, 'state'>,
    packageRoot: string,
  ): Promise<McpIlinkOperatorControl> {
    const descriptorFile = findMcpDescriptorFile(
      path.dirname(config.state.lockFile),
      operatorMcpInstanceKey(config.state.lockFile),
    );
    if (!fs.existsSync(descriptorFile)) {
      throw new Error('Kintio runtime has no local iLink operator control');
    }
    const sourceRelay = path.join(packageRoot, 'mcp-relay.ts');
    const relayFile = fs.existsSync(sourceRelay)
      ? sourceRelay
      : path.join(packageRoot, 'dist/mcp-relay.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        relayFile,
        '--descriptor',
        descriptorFile,
        '--route',
        'operator',
      ],
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (stderr && 'resume' in stderr && typeof stderr.resume === 'function') stderr.resume();
    const client = new Client({ name: 'kintio-cli', version: KINTIO_VERSION });
    try {
      await client.connect(transport);
      return new McpIlinkOperatorControl(client, transport);
    } catch (error) {
      try { await transport.close(); } catch {}
      throw new Error('Kintio runtime is not available for iLink operator control', {
        cause: error,
      });
    }
  }

  async begin(signal: AbortSignal) {
    const value = structured(await this.#client.callTool(
      { name: 'begin_login', arguments: {} },
      undefined,
      { signal, timeout: 30_000 },
    ));
    const offerId = String(value.offerId || '');
    const qrContent = String(value.qrContent || '');
    const expiresAt = Number(value.expiresAt || 0);
    if (
      !OFFER_ID.test(offerId) || !qrContent ||
      Buffer.byteLength(qrContent, 'utf8') > 2_048 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0
    ) throw new Error('Invalid iLink login offer from the Kintio runtime');
    return { offerId, qrContent, expiresAt };
  }

  async status(offerId: string, signal: AbortSignal) {
    const value = structured(await this.#client.callTool(
      { name: 'login_status', arguments: { offerId } },
      undefined,
      { signal, timeout: 5_000 },
    ));
    const status = String(value.status || '') as IlinkLoginStatus;
    if (!LOGIN_STATUSES.has(status)) {
      throw new Error('Invalid iLink login status from the Kintio runtime');
    }
    return { status };
  }

  async cancel(offerId: string): Promise<boolean> {
    const value = structured(await this.#client.callTool(
      { name: 'cancel_login', arguments: { offerId } },
      undefined,
      { timeout: 5_000 },
    ));
    if (typeof value.cancelled !== 'boolean') {
      throw new Error('Invalid iLink cancellation response from the Kintio runtime');
    }
    return value.cancelled;
  }

  async listAccounts(): Promise<readonly IlinkOperatorAccount[]> {
    const value = structured(await this.#client.callTool(
      { name: 'list_accounts', arguments: {} },
      undefined,
      { timeout: 5_000 },
    ));
    if (!Array.isArray(value.accounts) || value.accounts.length > 1_000) {
      throw new Error('Invalid iLink account list from the Kintio runtime');
    }
    return Object.freeze(value.accounts.map(operatorAccount));
  }

  async setAccountRuntime(
    accountKey: `ia_${string}`,
    enabled: boolean,
  ) {
    return accountMutation(structured(await this.#client.callTool(
      {
        name: enabled ? 'start_account' : 'stop_account',
        arguments: { accountKey },
      },
      undefined,
      { timeout: 10_000 },
    )));
  }

  async deleteAccount(accountKey: `ia_${string}`) {
    return accountMutation(structured(await this.#client.callTool(
      { name: 'delete_account', arguments: { accountKey } },
      undefined,
      { timeout: 10_000 },
    )));
  }

  async close(): Promise<void> {
    try { await this.#client.close(); } catch {}
    try { await this.#transport.close(); } catch {}
  }
}

class LocalIlinkOperatorControl implements IlinkOperatorControl {
  readonly mode = 'standalone' as const;
  readonly #persistence: StatePersistence;
  readonly #lock: InstanceLock;
  readonly #config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>;
  readonly #accounts: IlinkSqliteStore;
  #enrollment: ReturnType<typeof createIlinkEnrollmentService> | undefined;
  #enrollmentStarted: Promise<void> | undefined;
  #closed = false;

  private constructor(
    persistence: StatePersistence,
    lock: InstanceLock,
    config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>,
  ) {
    this.#persistence = persistence;
    this.#lock = lock;
    this.#config = config;
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
      return new LocalIlinkOperatorControl(persistence, lock, config);
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
          'Standalone iLink login initialization and cleanup both failed',
        );
      }
      throw error;
    }
  }

  async #startEnrollment() {
    this.#enrollment ||= createIlinkEnrollmentService({
      persistence: this.#persistence,
      config: this.#config.ilink,
    });
    this.#enrollmentStarted ||= this.#enrollment.manager.start();
    await this.#enrollmentStarted;
    return this.#enrollment;
  }

  async begin(signal?: AbortSignal) {
    const enrollment = await this.#startEnrollment();
    return enrollment.manager.offer(
      { kind: 'terminal' },
      signal ? { signal } : {},
    );
  }

  status(offerId: string) {
    if (!this.#enrollment) throw new Error('No iLink login is active');
    return Promise.resolve(this.#enrollment.manager.status(offerId));
  }

  cancel(offerId: string) {
    return Promise.resolve(this.#enrollment?.manager.cancel(offerId) || false);
  }

  listAccounts(): Promise<readonly IlinkOperatorAccount[]> {
    return Promise.resolve(Object.freeze(
      this.#accounts.listActiveAccounts().map((account) => ({
        accountKey: account.accountKey,
        providerAccountId: account.providerAccountId,
        runtimeEnabled: account.runtimeEnabled,
      })),
    ));
  }

  setAccountRuntime(accountKey: `ia_${string}`, enabled: boolean) {
    const account = enabled
      ? this.#accounts.selectRuntimeAccount(accountKey)
      : this.#accounts.setRuntimeEnabled(accountKey, false);
    return Promise.resolve({
      account: {
        accountKey: account.accountKey,
        providerAccountId: account.providerAccountId,
        runtimeEnabled: account.runtimeEnabled,
      },
      runningCount: this.#accounts.listRuntimeAccountsWithSecrets().length,
    });
  }

  deleteAccount(accountKey: `ia_${string}`) {
    const account = this.#accounts.deleteAccountCompletely(accountKey);
    return Promise.resolve({
      account: {
        accountKey: account.accountKey,
        providerAccountId: account.providerAccountId,
        runtimeEnabled: account.runtimeEnabled,
      },
      runningCount: this.#accounts.listRuntimeAccountsWithSecrets().length,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const errors: unknown[] = [];
    if (this.#enrollment) {
      try { await this.#enrollment.manager.close(); } catch (error: unknown) {
        errors.push(error);
      }
    }
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
      throw new AggregateError(errors, 'Standalone iLink login cleanup failed');
    }
  }
}

export async function openIlinkOperatorControl(
  config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>,
  packageRoot: string,
  signal: AbortSignal,
): Promise<IlinkOperatorControl> {
  try {
    return await McpIlinkOperatorControl.connect(config, packageRoot);
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
            return await McpIlinkOperatorControl.connect(config, packageRoot);
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
    openIlinkOperatorControl(options.config, options.packageRoot, options.signal));
  let control: IlinkOperatorControl | undefined;
  let offerId = '';
  let qrOutput: TemporaryQrOutput | undefined;
  try {
    control = await openControl();
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
      await control?.close();
    }
  }
}
