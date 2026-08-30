import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import * as z from 'zod/v4';

import { canonicalPath } from '../lib/path-identity.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';

export type ControlCommand = 'ping' | 'stop';
export type DaemonPhase = 'starting' | 'running' | 'backoff' | 'stopping' | 'failed';

export const CONTROL_MAX_BYTES = 4 * 1024;
export const CONTROL_TIMEOUT_MS = 2_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const positiveInteger = z.number().int().positive();
const runId = z.string().regex(ID_PATTERN, 'runId is invalid');
const token = z.string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/u, 'control token is invalid');
const phase = z.enum(['starting', 'running', 'backoff', 'stopping', 'failed']);
const absolutePath = z.string().min(1).max(4_096).refine(
  (value) => path.isAbsolute(value) && !value.includes('\0'),
  'path must be absolute',
).transform((value) => path.normalize(value));
const daemonRecordSchema = z.strictObject({
  version: z.literal(1),
  runId,
  daemonPid: positiveInteger,
  configFile: absolutePath,
  packageRoot: absolutePath,
  token,
});

const controlRequestSchema = z.strictObject({
  version: z.literal(1),
  command: z.enum(['ping', 'stop']),
  token,
});

const controlResponseSchema = z.strictObject({
  ok: z.boolean(),
  runId,
  daemonPid: positiveInteger,
  workerPid: positiveInteger.optional(),
  phase,
  message: z.string().min(1).max(2_048).optional(),
});

export type DaemonRecord = Readonly<z.infer<typeof daemonRecordSchema>>;
export type ControlRequest = Readonly<z.infer<typeof controlRequestSchema>>;
export type ControlResponse = Readonly<z.infer<typeof controlResponseSchema>>;

export function parseDaemonRecord(value: unknown): DaemonRecord {
  return Object.freeze(daemonRecordSchema.parse(value));
}

export function parseControlRequest(value: unknown): ControlRequest {
  return Object.freeze(controlRequestSchema.parse(value));
}

export function parseControlResponse(value: unknown): ControlResponse {
  return Object.freeze(controlResponseSchema.parse(value));
}

export function daemonRecordPath(home: string): string {
  return path.join(path.resolve(home), 'data/daemon.json');
}

export function controlAddress(
  home: string,
  platform: NodeJS.Platform = process.platform,
  nonce = '',
): string {
  const identity = canonicalPath(home).replaceAll('/', '\\').toLowerCase();
  if (nonce && !ID_PATTERN.test(nonce)) throw new Error('control address nonce is invalid');
  const digest = createHash('sha256')
    .update(`${identity}\0${nonce}`)
    .digest('hex')
    .slice(0, 32);
  const name = `kintio-${digest}`;
  return platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : path.join('/tmp', `${name}.sock`);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function assertPrivateFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Daemon metadata is not a regular file: ${filePath}`);
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new Error(`Daemon metadata has unsafe permissions: ${filePath}`);
    }
  }
  if (stat.size > CONTROL_MAX_BYTES) {
    throw new Error(`Daemon metadata exceeds ${CONTROL_MAX_BYTES} bytes: ${filePath}`);
  }
}

function readJson<T>(filePath: string, parse: (value: unknown) => T): T | null {
  try {
    assertPrivateFile(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(source) > CONTROL_MAX_BYTES) {
      throw new Error(`Daemon metadata exceeds ${CONTROL_MAX_BYTES} bytes: ${filePath}`);
    }
    return parse(JSON.parse(source) as unknown);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function writeJson(filePath: string, value: unknown): void {
  const directory = ensurePrivateDirectory(path.dirname(filePath));
  const source = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(source) > CONTROL_MAX_BYTES) {
    throw new Error(`Daemon metadata exceeds ${CONTROL_MAX_BYTES} bytes: ${filePath}`);
  }
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, source, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readDaemonRecord(home: string): DaemonRecord | null {
  return readJson(daemonRecordPath(home), parseDaemonRecord);
}

export function writeDaemonRecord(home: string, record: DaemonRecord): void {
  writeJson(daemonRecordPath(home), parseDaemonRecord(record));
}

function parseResponseLine(source: Buffer): ControlResponse {
  const newline = source.indexOf(0x0a);
  if (newline === -1) throw new Error('control response ended without a newline');
  if (newline !== source.length - 1) {
    throw new Error('control response contains more than one message');
  }
  const line = source.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
  return parseControlResponse(JSON.parse(line) as unknown);
}

export async function requestControl(
  home: string,
  command: ControlCommand,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<ControlResponse> {
  if (command !== 'ping' && command !== 'stop') {
    throw new Error('control command is invalid');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('control timeout must be a positive number');
  }
  const record = readDaemonRecord(home);
  if (!record) throw new Error('Kintio daemon record does not exist');
  const source = `${JSON.stringify({
    version: 1,
    command,
    token: record.token,
  } satisfies ControlRequest)}\n`;

  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(controlAddress(home, process.platform, record.runId));
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      return true;
    };
    const fail = (error: unknown): void => {
      if (finish()) reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error('Kintio control request timed out')),
      Math.min(timeoutMs, CONTROL_TIMEOUT_MS),
    );
    timer.unref?.();

    socket.once('connect', () => socket.write(source));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CONTROL_MAX_BYTES) {
        fail(new Error(`control response exceeds ${CONTROL_MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
      const complete = Buffer.concat(chunks, size);
      if (!complete.includes(0x0a)) return;
      try {
        const response = parseResponseLine(complete);
        if (response.runId !== record.runId || response.daemonPid !== record.daemonPid) {
          throw new Error('control response identity does not match the daemon record');
        }
        if (!response.ok) {
          throw new Error(response.message || 'Kintio control request was rejected');
        }
        if (finish()) resolve(response);
      } catch (error: unknown) {
        fail(error);
      }
    });
    socket.once('end', () => {
      if (!settled) fail(new Error('control response ended before one message arrived'));
    });
    socket.once('error', fail);
  });
}
