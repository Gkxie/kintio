import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';

import { ensurePrivateDirectory } from '../lib/private-directory.ts';
import { canonicalPath } from '../lib/path-identity.ts';

const MCP_ROUTES = [
  'wechat_kf',
  'weixin_ilink',
  'conversation_memory',
] as const;
export type McpRoute = (typeof MCP_ROUTES)[number];

export const MCP_FRAME_MAX_BYTES = 256 * 1024;
export const MCP_HANDSHAKE_OK = 'KINTIO-MCP/1 OK';
export const MCP_HANDSHAKE_ERROR = 'KINTIO-MCP/1 ERROR';
const DESCRIPTOR_MAX_BYTES = 4 * 1024;
const HANDSHAKE_MAX_BYTES = 512;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{24}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DESCRIPTOR_PREFIX = 'mcp-runtime-';

export interface McpIpcDescriptor {
  readonly version: 1;
  readonly generation: string;
  readonly address: string;
  readonly token: string;
}

export function createMcpGeneration(): string {
  return randomBytes(18).toString('base64url');
}

export function mcpDescriptorPath(directory: string, generation: string): string {
  if (!GENERATION_PATTERN.test(generation)) throw new Error('Invalid MCP generation');
  return path.join(path.resolve(directory), `${DESCRIPTOR_PREFIX}${generation}.json`);
}

export function mcpIpcAddress(
  instanceKey: string,
  generation: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!GENERATION_PATTERN.test(generation)) throw new Error('Invalid MCP generation');
  const instance = mcpInstanceId(instanceKey);
  const name = `kintio-mcp-${instance}-${generation}`;
  return platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : path.posix.join('/tmp', `kintio-mcp-${instance}`, `${generation}.sock`);
}

export function mcpInstanceId(instanceKey: string): string {
  return createHash('sha256').update(canonicalPath(instanceKey)).digest('hex').slice(0, 16);
}

export function ensureMcpStateDirectory(directory: string): string {
  const target = ensurePrivateDirectory(directory);
  assertPrivateDirectory(target);
  return target;
}

function parseDescriptor(value: unknown): McpIpcDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid MCP descriptor');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'address,generation,token,version' ||
    record.version !== 1 ||
    typeof record.generation !== 'string' ||
    !GENERATION_PATTERN.test(record.generation) ||
    typeof record.address !== 'string' ||
    !record.address ||
    record.address.length > 512 ||
    record.address.includes('\0') ||
    !isMcpIpcAddress(record.address, record.generation) ||
    typeof record.token !== 'string' ||
    !TOKEN_PATTERN.test(record.token)
  ) throw new Error('Invalid MCP descriptor');
  return Object.freeze({
    version: 1,
    generation: record.generation,
    address: record.address,
    token: record.token,
  });
}

export function writeMcpDescriptor(
  directory: string,
  descriptor: McpIpcDescriptor,
): string {
  const target = mcpDescriptorPath(ensureMcpStateDirectory(directory), descriptor.generation);
  const source = `${JSON.stringify(parseDescriptor(descriptor))}\n`;
  fs.writeFileSync(target, source, { flag: 'wx', mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  return target;
}

export function readMcpDescriptor(filePath: string): McpIpcDescriptor {
  const target = path.resolve(filePath);
  assertPrivateDirectory(path.dirname(target));
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Unsafe MCP descriptor');
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    assertSafeDescriptor(before, stat);
    const buffer = Buffer.allocUnsafe(DESCRIPTOR_MAX_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0 || bytesRead > DESCRIPTOR_MAX_BYTES) {
      throw new Error('Unsafe MCP descriptor');
    }
    const parsed = parseDescriptor(
      JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown,
    );
    if (target !== mcpDescriptorPath(path.dirname(target), parsed.generation)) {
      throw new Error('Unsafe MCP descriptor');
    }
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function mcpHandshake(
  descriptor: McpIpcDescriptor,
  route: McpRoute,
): string {
  return `${JSON.stringify({
    version: descriptor.version,
    generation: descriptor.generation,
    route,
    token: descriptor.token,
  })}\n`;
}

export function parseMcpHandshake(
  source: string,
  descriptor: McpIpcDescriptor,
): McpRoute | undefined {
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    if (
      !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'generation,route,token,version' ||
      value.version !== 1 ||
      value.generation !== descriptor.generation ||
      typeof value.route !== 'string' ||
      !(MCP_ROUTES as readonly string[]).includes(value.route) ||
      typeof value.token !== 'string'
    ) return undefined;
    const presented = Buffer.from(value.token);
    const expected = Buffer.from(descriptor.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected)
      ? value.route as McpRoute
      : undefined;
  } catch {
    return undefined;
  }
}

export function readSocketLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    };
    const finish = (error?: Error, line = ''): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(line);
    };
    const onError = (): void => finish(new Error('MCP IPC handshake failed'));
    const onEnd = (): void => finish(new Error('MCP IPC handshake ended'));
    const onClose = (): void => finish(new Error('MCP IPC handshake closed'));
    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const newline = data.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length + data.length > HANDSHAKE_MAX_BYTES) {
          finish(new Error('MCP IPC handshake too large'));
          return;
        }
        buffer = Buffer.concat([buffer, data], buffer.length + data.length);
        return;
      }
      const lineBytes = buffer.length + newline;
      if (lineBytes > HANDSHAKE_MAX_BYTES) {
        finish(new Error('MCP IPC handshake too large'));
        return;
      }
      const line = buffer.length
        ? Buffer.concat([buffer, data.subarray(0, newline)], lineBytes)
        : data.subarray(0, newline);
      const remainder = data.subarray(newline + 1);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      finish(undefined, line.toString('utf8').replace(/\r$/u, ''));
    };
    const timer = setTimeout(
      () => finish(new Error('MCP IPC handshake timed out')),
      HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.resume();
  });
}

export function isMcpRoute(value: string): value is McpRoute {
  return (MCP_ROUTES as readonly string[]).includes(value);
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Unsafe MCP state directory');
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new Error('Unsafe MCP state directory');
    }
  }
}

function assertSafeDescriptor(before: fs.Stats, opened: fs.Stats): void {
  if (
    !opened.isFile() || opened.size <= 0 || opened.size > DESCRIPTOR_MAX_BYTES ||
    before.dev !== opened.dev || before.ino !== opened.ino
  ) throw new Error('Unsafe MCP descriptor');
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if ((uid !== undefined && opened.uid !== uid) || (opened.mode & 0o077) !== 0) {
      throw new Error('Unsafe MCP descriptor');
    }
  }
}

function isMcpIpcAddress(value: string, generation: string): boolean {
  const match = process.platform === 'win32'
    ? /^\\\\\.\\pipe\\kintio-mcp-[a-f0-9]{16}-([A-Za-z0-9_-]{24})$/u.exec(value)
    : /^\/tmp\/kintio-mcp-[a-f0-9]{16}\/([A-Za-z0-9_-]{24})\.sock$/u.exec(value);
  return match?.[1] === generation;
}
