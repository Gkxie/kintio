import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { AppConfig } from '../config.ts';
import {
  findMcpDescriptorFile,
  operatorMcpInstanceKey,
} from '../mcp/ipc-protocol.ts';
import { KINTIO_VERSION } from '../version.ts';
import { renderIlinkQrTerminal } from './qr.ts';
import type { IlinkLoginStatus } from './login-store.ts';

const STATUS_POLL_MS = 1_000;
const OFFER_ID = /^qo_[A-Za-z0-9_-]{1,128}$/u;
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

interface IlinkLoginControl {
  begin(signal: AbortSignal): Promise<{
    readonly offerId: string;
    readonly qrContent: string;
    readonly expiresAt: number;
  }>;
  status(offerId: string, signal: AbortSignal): Promise<{
    readonly status: IlinkLoginStatus;
  }>;
  cancel(offerId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface IlinkCliLoginOptions {
  readonly config: AppConfig;
  readonly packageRoot: string;
  readonly stdout: (text: string) => void;
  readonly stdoutIsTTY: boolean;
  readonly stdoutColumns: number;
  readonly signal: AbortSignal;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly openControl?: () => Promise<IlinkLoginControl>;
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

class McpIlinkLoginControl implements IlinkLoginControl {
  readonly #client: Client;
  readonly #transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.#client = client;
    this.#transport = transport;
  }

  static async connect(
    config: AppConfig,
    packageRoot: string,
  ): Promise<McpIlinkLoginControl> {
    const descriptorFile = findMcpDescriptorFile(
      path.dirname(config.state.lockFile),
      operatorMcpInstanceKey(config.state.lockFile),
    );
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
      return new McpIlinkLoginControl(client, transport);
    } catch (error) {
      try { await transport.close(); } catch {}
      throw new Error('Kintio runtime is not available for iLink login', { cause: error });
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

  async close(): Promise<void> {
    try { await this.#client.close(); } catch {}
    try { await this.#transport.close(); } catch {}
  }
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal, ref: false });
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

async function cancelQuietly(control: IlinkLoginControl, offerId: string): Promise<void> {
  try { await control.cancel(offerId); } catch {}
}

async function cancelOrReadFinal(
  control: IlinkLoginControl,
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
  if (!options.stdoutIsTTY) {
    throw new Error('iLink login requires an interactive terminal');
  }
  if (!options.config.ilink.enabled) {
    throw new Error('iLink is disabled; set ILINK_ENABLED=true and start Kintio first');
  }
  const clock = options.clock || Date.now;
  const sleep = options.sleep || defaultSleep;
  const openControl = options.openControl || (() =>
    McpIlinkLoginControl.connect(options.config, options.packageRoot));
  const control = await openControl();
  let offerId = '';
  try {
    const offer = await control.begin(options.signal);
    offerId = offer.offerId;
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
        ? await cancelOrReadFinal(control, offerId)
        : undefined;
      if (finalStatus && loginSucceeded(finalStatus)) {
        options.stdout(terminalMessage(finalStatus));
        return 0;
      }
      throw error;
    }
    const finalStatus = offerId
      ? await cancelOrReadFinal(control, offerId)
      : undefined;
    if (finalStatus && loginSucceeded(finalStatus)) {
      options.stdout(terminalMessage(finalStatus));
      return 0;
    }
    options.stdout('iLink login was cancelled.\n');
    return 130;
  } finally {
    await control.close();
  }
}
