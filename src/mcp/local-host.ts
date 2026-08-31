import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

export interface LocalMcpEndpoints {
  readonly wechatKf?: string;
  readonly memory: string;
  readonly ilink?: string;
}

type Handler = (request: Request) => Promise<Response>;

export class LocalMcpHost {
  readonly #wechatKf: Handler | undefined;
  readonly #memory: Handler;
  readonly #ilink: Handler | undefined;
  #server: ServerType | undefined;
  #authority = '';
  #starting: Promise<LocalMcpEndpoints> | undefined;
  #closing: Promise<void> | undefined;
  readonly #inFlight = new Set<Promise<Response>>();
  readonly #responses = new Set<Promise<void>>();
  #forced = false;
  #resolveForce!: () => void;
  readonly #forceSignal = new Promise<void>((resolve) => { this.#resolveForce = resolve; });
  #closed = false;

  constructor({
    wechatKf,
    memory,
    ilink,
  }: {
    readonly wechatKf?: Handler;
    readonly memory: Handler;
    readonly ilink?: Handler;
  }) {
    this.#wechatKf = wechatKf;
    this.#memory = memory;
    this.#ilink = ilink;
  }

  start(): Promise<LocalMcpEndpoints> {
    if (this.#closed) return Promise.reject(new Error('Local MCP host is closed'));
    this.#starting ||= this.#start();
    return this.#starting;
  }

  async #start(): Promise<LocalMcpEndpoints> {
    const app = new Hono();
    if (this.#wechatKf) {
      app.all('/mcp', (context) => this.#dispatch(this.#wechatKf!, context.req.raw));
    }
    app.all('/mcp/memory', (context) => this.#dispatch(this.#memory, context.req.raw));
    if (this.#ilink) {
      app.all('/mcp/ilink', (context) => this.#dispatch(this.#ilink!, context.req.raw));
    }
    app.notFound((context) => context.text('not found', 404));
    const server = createAdaptorServer({ fetch: app.fetch });
    server.on('request', (request, response) => {
      if (request.method !== 'POST') return;
      const finished = new Promise<void>((resolve) => {
        response.once('finish', resolve);
        response.once('close', resolve);
      });
      this.#responses.add(finished);
      void finished.then(() => this.#responses.delete(finished));
    });
    this.#server = server;
    const port = await new Promise<number>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
          reject(new Error('Local MCP host did not bind an IPv4 loopback port'));
          return;
        }
        resolve(address.port);
      });
    });
    this.#authority = `127.0.0.1:${port}`;
    const origin = `http://127.0.0.1:${port}`;
    return Object.freeze({
      ...(this.#wechatKf ? { wechatKf: `${origin}/mcp` } : {}),
      memory: `${origin}/mcp/memory`,
      ...(this.#ilink ? { ilink: `${origin}/mcp/ilink` } : {}),
    });
  }

  #dispatch(handler: Handler, request: Request): Promise<Response> {
    if (request.headers.get('host') !== this.#authority) {
      return Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 }));
    }
    if (this.#closed) {
      return Promise.resolve(Response.json({ error: 'service unavailable' }, { status: 503 }));
    }
    const operation = Promise.resolve().then(() => handler(request));
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  close(force = false): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => {
        await this.#starting?.catch(() => undefined);
        const server = this.#server;
        if (!server?.listening) return;
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        if (!this.#forced) {
          await Promise.race([
            Promise.allSettled([...this.#inFlight]),
            this.#forceSignal,
          ]);
        }
        if (!this.#forced) {
          await Promise.race([
            Promise.allSettled([...this.#responses]),
            this.#forceSignal,
          ]);
        }
        (server as ServerType & { closeAllConnections?: () => void })
          .closeAllConnections?.();
        await stopped;
      })();
    }
    if (force && !this.#forced) {
      this.#forced = true;
      this.#resolveForce();
    }
    return this.#closing;
  }
}
