import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { IlinkLoginStatus } from '../ilink/login-store.ts';
import type { IlinkAccountRevision } from '../ilink/store-types.ts';
import { findMcpDescriptorFile, operatorMcpInstanceKey } from '../mcp/ipc-protocol.ts';
import { KINTIO_VERSION } from '../version.ts';

interface OperatorLocation {
  readonly state: { readonly lockFile: string };
}

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
  readonly generation: number;
  readonly incarnation: `ii_${string}`;
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
    expected: IlinkAccountRevision,
  ): Promise<{ readonly account: IlinkOperatorAccount; readonly runningCount: number }>;
  deleteAccount(
    accountKey: `ia_${string}`,
    expected: IlinkAccountRevision,
  ): Promise<{ readonly account: IlinkOperatorAccount; readonly runningCount: number }>;
  close(): Promise<void>;
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
  throw new Error(message || 'The Kintio runtime rejected the operator request');
}

function structured(result: unknown): Record<string, unknown> {
  const response = record(result);
  if (response.isError) resultError(response);
  return record(response.structuredContent);
}

function operatorAccount(value: unknown): IlinkOperatorAccount {
  const account = record(value);
  const accountKey = String(account.accountKey || '');
  const generation = Number(account.generation);
  const incarnation = String(account.incarnation || '');
  const providerAccountId = String(account.providerAccountId || '');
  if (
    !ACCOUNT_KEY.test(accountKey) ||
    !Number.isSafeInteger(generation) || generation < 1 ||
    !/^ii_[0-9a-f]{64}$/u.test(incarnation) ||
    !providerAccountId || Buffer.byteLength(providerAccountId, 'utf8') > 512 ||
    typeof account.runtimeEnabled !== 'boolean'
  ) {
    throw new Error('Invalid iLink account response from the Kintio runtime');
  }
  return Object.freeze({
    accountKey: accountKey as `ia_${string}`,
    generation,
    incarnation: incarnation as `ii_${string}`,
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

export function hasRuntimeOperator(state: OperatorLocation['state']): boolean {
  try {
    findMcpDescriptorFile(path.dirname(state.lockFile), operatorMcpInstanceKey(state.lockFile));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'Kintio runtime is not running') return false;
    throw error;
  }
}

export async function controlWecom(
  config: OperatorLocation,
  packageRoot: string,
  action: 'start' | 'stop' | 'restart' | 'status',
  configFile?: string,
): Promise<{ running: boolean }> {
  const control = await RuntimeOperatorClient.connect(config, packageRoot);
  try { return await control.wecom(action, configFile); }
  finally { await control.close(); }
}

export async function restartIlinkListeners(config: OperatorLocation, packageRoot: string): Promise<void> {
  const control = await RuntimeOperatorClient.connect(config, packageRoot);
  try { await control.restart(); }
  finally { await control.close(); }
}

export class RuntimeOperatorClient implements IlinkOperatorControl {
  readonly mode = 'runtime' as const;
  readonly #client: Client;
  readonly #transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.#client = client;
    this.#transport = transport;
  }

  static async connect(
    config: OperatorLocation,
    packageRoot: string,
  ): Promise<RuntimeOperatorClient> {
    const descriptorFile = findMcpDescriptorFile(
      path.dirname(config.state.lockFile),
      operatorMcpInstanceKey(config.state.lockFile),
    );
    if (!fs.existsSync(descriptorFile)) {
      throw new Error('Kintio runtime has no local operator control');
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
      return new RuntimeOperatorClient(client, transport);
    } catch (error) {
      try { await transport.close(); } catch {}
      throw new Error('Kintio runtime is not available for operator control', {
        cause: error,
      });
    }
  }

  async wecom(action: 'start' | 'stop' | 'restart' | 'status', configFile?: string): Promise<{ running: boolean }> {
    const value = structured(await this.#client.callTool(
      { name: 'wecom_control', arguments: { action, ...(configFile ? { configFile } : {}) } },
      undefined,
      { timeout: 130_000 },
    ));
    if (typeof value.running !== 'boolean') throw new Error('Invalid WeCom listener state');
    return { running: value.running };
  }

  async restart(): Promise<void> {
    structured(await this.#client.callTool({ name: 'restart_accounts', arguments: {} }, undefined, { timeout: 130_000 }));
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
    expected: IlinkAccountRevision,
  ) {
    return accountMutation(structured(await this.#client.callTool(
      {
        name: enabled ? 'start_account' : 'stop_account',
        arguments: {
          accountKey,
          expectedGeneration: expected.generation,
          expectedIncarnation: expected.incarnation,
        },
      },
      undefined,
      { timeout: 10_000 },
    )));
  }

  async deleteAccount(
    accountKey: `ia_${string}`,
    expected: IlinkAccountRevision,
  ) {
    return accountMutation(structured(await this.#client.callTool(
      {
        name: 'delete_account',
        arguments: {
          accountKey,
          expectedGeneration: expected.generation,
          expectedIncarnation: expected.incarnation,
        },
      },
      undefined,
      { timeout: 10_000 },
    )));
  }

  async close(): Promise<void> {
    try { await this.#client.close(); } catch {}
    try { await this.#transport.close(); } catch {}
  }
}
