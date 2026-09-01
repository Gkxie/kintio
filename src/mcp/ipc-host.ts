import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  MCP_FRAME_MAX_BYTES,
  MCP_HANDSHAKE_ERROR,
  MCP_HANDSHAKE_OK,
  createMcpGeneration,
  ensureMcpStateDirectory,
  mcpInstanceId,
  mcpIpcAddress,
  parseMcpHandshake,
  readSocketLine,
  writeMcpDescriptor,
  type McpIpcDescriptor,
  type McpRoute,
} from './ipc-protocol.ts';

export interface McpRelayLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface LocalMcpLaunches {
  readonly wechatKf?: McpRelayLaunch;
  readonly ilink?: McpRelayLaunch;
  readonly memory: McpRelayLaunch;
}

type Factory = () => McpServer;
type Connection = {
  readonly socket: Socket;
  authenticated: boolean;
  close(): Promise<void>;
};

function writeLine(socket: Socket, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${value}\n`, (error) => error ? reject(error) : resolve());
  });
}

export class McpIpcHost {
  readonly #instanceKey: string;
  readonly #stateDirectory: string;
  readonly #relayFile: string;
  readonly #wechatKf: Factory | undefined;
  readonly #memory: Factory;
  readonly #ilink: Factory | undefined;
  readonly #operator: Factory | undefined;
  readonly #logger: { error(message: string): void };
  readonly #connections = new Set<Connection>();
  #server: Server | undefined;
  #descriptor: McpIpcDescriptor | undefined;
  #descriptorFile = '';
  #starting: Promise<LocalMcpLaunches> | undefined;
  #closing: Promise<void> | undefined;
  #force = false;
  #closed = false;

  constructor({
    instanceKey,
    stateDirectory,
    relayFile,
    wechatKf,
    memory,
    ilink,
    operator,
    logger = console,
  }: {
    readonly instanceKey: string;
    readonly stateDirectory: string;
    readonly relayFile: string;
    readonly wechatKf?: Factory;
    readonly memory: Factory;
    readonly ilink?: Factory;
    readonly operator?: Factory;
    readonly logger?: { error(message: string): void };
  }) {
    this.#instanceKey = path.resolve(instanceKey);
    this.#stateDirectory = path.join(
      path.resolve(stateDirectory),
      '.kintio-mcp',
      mcpInstanceId(this.#instanceKey),
    );
    this.#relayFile = path.resolve(relayFile);
    this.#wechatKf = wechatKf;
    this.#memory = memory;
    this.#ilink = ilink;
    this.#operator = operator;
    this.#logger = logger;
  }

  start(): Promise<LocalMcpLaunches> {
    if (this.#closed) return Promise.reject(new Error('MCP IPC host is closed'));
    this.#starting ||= this.#start();
    return this.#starting;
  }

  async #start(): Promise<LocalMcpLaunches> {
    let relayStat: fs.Stats;
    try {
      relayStat = fs.statSync(this.#relayFile);
    } catch {
      throw new Error('MCP relay entry is unavailable');
    }
    if (!relayStat.isFile()) throw new Error('MCP relay entry is not a file');
    ensureMcpStateDirectory(this.#stateDirectory);
    this.#removeStaleState();
    const generation = createMcpGeneration();
    const descriptor: McpIpcDescriptor = {
      version: 1,
      generation,
      address: mcpIpcAddress(this.#instanceKey, generation),
      token: randomBytes(32).toString('base64url'),
    };
    const server = createServer((socket) => this.#accept(socket));
    server.maxConnections = 16;
    this.#server = server;
    this.#descriptor = descriptor;
    try {
      if (process.platform !== 'win32') fs.rmSync(descriptor.address, { force: true });
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => reject(error);
        server.once('error', failed);
        server.listen(descriptor.address, () => {
          server.off('error', failed);
          resolve();
        });
      });
      if (this.#closed) throw new Error('MCP IPC host is closed');
      if (process.platform !== 'win32') fs.chmodSync(descriptor.address, 0o600);
      if (this.#closed) throw new Error('MCP IPC host is closed');
      this.#descriptorFile = writeMcpDescriptor(this.#stateDirectory, descriptor);
      if (this.#closed) throw new Error('MCP IPC host is closed');
      server.on('error', () => this.#logger.error('[mcp] IPC listener failed'));
      return Object.freeze({
        ...(this.#wechatKf ? { wechatKf: this.#launch('wechat_kf') } : {}),
        memory: this.#launch('conversation_memory'),
        ...(this.#ilink ? { ilink: this.#launch('weixin_ilink') } : {}),
      });
    } catch (error) {
      this.#cleanupFiles();
      await this.#forceClose();
      await this.#stopServer(server);
      throw error;
    }
  }

  #launch(route: McpRoute): McpRelayLaunch {
    return Object.freeze({
      command: process.execPath,
      args: Object.freeze([
        this.#relayFile,
        '--descriptor',
        this.#descriptorFile,
        '--route',
        route,
      ]),
    });
  }

  #factory(route: McpRoute): Factory | undefined {
    switch (route) {
      case 'wechat_kf': return this.#wechatKf;
      case 'weixin_ilink': return this.#ilink;
      case 'conversation_memory': return this.#memory;
      case 'operator': return this.#operator;
    }
  }

  #accept(socket: Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    let mcp: McpServer | undefined;
    let closed: Promise<void> | undefined;
    let authenticatedRoute = false;
    const connection: Connection = {
      socket,
      authenticated: false,
      close: () => {
        closed ||= Promise.resolve()
          .then(() => mcp?.close())
          .finally(() => socket.destroy());
        return closed;
      },
    };
    this.#connections.add(connection);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      this.#connections.delete(connection);
      void connection.close().catch(() => undefined);
    });
    void (async () => {
      const descriptor = this.#descriptor;
      if (this.#closed || !descriptor) throw new Error('MCP IPC host unavailable');
      const route = parseMcpHandshake(await readSocketLine(socket), descriptor);
      if (this.#closed) throw new Error('MCP IPC host unavailable');
      const factory = route ? this.#factory(route) : undefined;
      if (!factory) {
        await writeLine(socket, MCP_HANDSHAKE_ERROR).catch(() => undefined);
        socket.destroy();
        return;
      }
      authenticatedRoute = true;
      mcp = factory();
      const transport = new StdioServerTransport(socket, socket, {
        maxBufferSize: MCP_FRAME_MAX_BYTES,
      });
      transport.onerror = () => socket.destroy();
      transport.onclose = () => socket.destroy();
      await writeLine(socket, MCP_HANDSHAKE_OK);
      if (this.#closed) throw new Error('MCP IPC host unavailable');
      await mcp.connect(transport);
      if (this.#closed) {
        await connection.close();
        return;
      }
      connection.authenticated = true;
      socket.resume();
    })().catch(() => {
      if (authenticatedRoute && !this.#closed) {
        this.#logger.error('[mcp] authenticated IPC connection failed');
      }
      socket.destroy();
    });
  }

  close(force = false): Promise<void> {
    if (force) this.#force = true;
    if (!this.#closing) {
      this.#closed = true;
      this.#cleanupFiles();
      void this.#closeUnauthenticated();
      this.#closing = this.#finishClose();
    }
    if (force) void this.#forceClose();
    return this.#closing;
  }

  async #finishClose(): Promise<void> {
    await this.#starting?.catch(() => undefined);
    this.#cleanupFiles();
    const server = this.#server;
    if (!server) return;
    const stopped = this.#stopServer(server);
    if (this.#force) await this.#forceClose();
    else await this.#closeUnauthenticated();
    await stopped;
    this.#cleanupFiles();
  }

  #stopServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async #closeUnauthenticated(): Promise<void> {
    await Promise.allSettled(
      [...this.#connections]
        .filter((connection) => !connection.authenticated)
        .map((connection) => connection.close()),
    );
  }

  async #forceClose(): Promise<void> {
    await Promise.allSettled([...this.#connections].map((connection) => connection.close()));
  }

  #cleanupFiles(): void {
    if (this.#descriptorFile) fs.rmSync(this.#descriptorFile, { force: true });
    if (this.#descriptor && process.platform !== 'win32') {
      fs.rmSync(this.#descriptor.address, { force: true });
      try {
        fs.rmdirSync(path.dirname(this.#descriptor.address));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
      }
    }
  }

  #removeStaleState(): void {
    const pattern = /^mcp-runtime-([A-Za-z0-9_-]{24})\.json$/u;
    for (const name of fs.readdirSync(this.#stateDirectory)) {
      const generation = pattern.exec(name)?.[1];
      if (!generation) continue;
      fs.rmSync(path.join(this.#stateDirectory, name), { force: true });
      if (process.platform !== 'win32') {
        fs.rmSync(mcpIpcAddress(this.#instanceKey, generation), { force: true });
      }
    }
    if (process.platform !== 'win32') {
      const socketDirectory = path.dirname(
        mcpIpcAddress(this.#instanceKey, 'a'.repeat(24)),
      );
      ensureMcpStateDirectory(socketDirectory);
      const uid = process.getuid?.();
      for (const name of fs.readdirSync(socketDirectory)) {
        if (!name.endsWith('.sock')) continue;
        const generation = name.slice(0, -'.sock'.length);
        if (!/^[A-Za-z0-9_-]{24}$/u.test(generation)) continue;
        const socketPath = path.join(socketDirectory, name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) continue;
        fs.rmSync(socketPath, { force: true });
      }
    }
  }
}
