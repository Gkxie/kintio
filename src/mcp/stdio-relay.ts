import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';

import {
  MCP_HANDSHAKE_OK,
  isMcpRoute,
  mcpHandshake,
  readMcpDescriptor,
  readSocketLine,
  type McpRoute,
} from './ipc-protocol.ts';

const CONNECT_TIMEOUT_MS = 2_000;

export const MCP_RELAY_ERROR = 'Kintio MCP relay failed\n';

export interface McpRelayOptions {
  readonly descriptorFile: string;
  readonly route: McpRoute;
}

export interface McpRelayStreams {
  readonly input: Readable;
  readonly output: Writable;
}

export function parseMcpRelayArgs(args: readonly string[]): McpRelayOptions {
  if (
    args.length !== 4 ||
    args[0] !== '--descriptor' ||
    args[2] !== '--route' ||
    !args[1] ||
    !path.isAbsolute(args[1]) ||
    args[1].includes('\0') ||
    !args[3] ||
    !isMcpRoute(args[3])
  ) throw new Error('Invalid MCP relay arguments');

  return Object.freeze({
    descriptorFile: path.resolve(args[1]),
    route: args[3],
  });
}

export async function runMcpRelay(
  args: readonly string[],
  streams: McpRelayStreams,
): Promise<void> {
  const options = parseMcpRelayArgs(args);
  const descriptor = readMcpDescriptor(options.descriptorFile);

  const socket = await connectIpc(descriptor.address);
  try {
    await writeSocket(socket, mcpHandshake(descriptor, options.route));
    if (await readSocketLine(socket) !== MCP_HANDSHAKE_OK) {
      throw new Error('MCP relay authentication failed');
    }
    await relayBytes(socket, streams);
  } finally {
    socket.destroy();
  }
}

async function connectIpc(address: string): Promise<Socket> {
  const socket = createConnection({ path: address });
  // Keep the dedicated relay process fail-closed even if an error occurs in the
  // small gaps between the connect, handshake, and stream pipeline listeners.
  socket.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = (): void => finish();
    const onError = (): void => finish(new Error('MCP IPC connection failed'));
    const onClose = (): void => finish(new Error('MCP IPC connection closed'));
    const timer = setTimeout(
      () => finish(new Error('MCP IPC connection timed out')),
      CONNECT_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function writeSocket(socket: Socket, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(new Error('MCP IPC write failed'));
      else resolve();
    };
    const onError = (): void => finish(new Error('MCP IPC write failed'));
    const onClose = (): void => finish(new Error('MCP IPC write closed'));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(source, finish);
  });
}

async function relayBytes(
  socket: Socket,
  { input, output }: McpRelayStreams,
): Promise<void> {
  const controller = new AbortController();
  const upstream = pipeline(input, socket, {
    end: false,
    signal: controller.signal,
  });
  const downstream = pipeline(socket, output, { signal: controller.signal });

  try {
    const first = await Promise.race([
      upstream.then(() => 'input' as const),
      downstream.then(() => 'socket' as const),
    ]);
    if (first === 'input') {
      socket.end();
      await downstream;
      return;
    }

    // The MCP host ended first. Stop waiting on a still-open parent stdin.
    controller.abort();
    input.destroy();
    void upstream.catch(() => undefined);
  } catch {
    controller.abort();
    input.destroy();
    output.destroy();
    socket.destroy();
    void upstream.catch(() => undefined);
    void downstream.catch(() => undefined);
    throw new Error('MCP stdio relay failed');
  }
}
