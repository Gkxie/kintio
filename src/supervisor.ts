import { createAdaptorServer, type ServerType } from '@hono/node-server';

import { createApp } from './app.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import type { AppConfig } from './config.ts';
import type { Logger } from './types.ts';

export type SupervisorState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'closing'
  | 'closed'
  | 'aborted'
  | 'failed';

export class KintioSupervisor {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #runtimeFactory: () => Promise<Runtime>;
  readonly #onFatal: (error: Error) => void;
  #runtime: Runtime | undefined;
  #runtimeIngressStopped = false;
  #runtimeAbort: Promise<void> | undefined;
  #runtimeClose: Promise<void> | undefined;
  #server: ServerType | undefined;
  #httpClosing: Promise<void> | undefined;
  #state: SupervisorState = 'idle';
  #ingressOpen = false;
  #starting: Promise<{ readonly port: number }> | undefined;
  #closing: Promise<void> | undefined;
  #aborting: Promise<void> | undefined;

  constructor({
    config,
    logger = console,
    runtime,
    onFatal = (error) => logger.error(`[supervisor] fatal channel error: ${error.message}`),
  }: {
    config: AppConfig;
    logger?: Logger;
    runtime?: Runtime;
    onFatal?: (error: Error) => void;
  }) {
    this.#config = config;
    this.#logger = logger;
    this.#runtimeFactory = runtime
      ? async () => runtime
      : () => createRuntime({ config, logger });
    this.#onFatal = onFatal;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  start(): Promise<{ readonly port: number }> {
    if (
      this.#starting &&
      (this.#state === 'starting' || this.#state === 'running')
    ) return this.#starting;
    if (this.#state !== 'idle') {
      return Promise.reject(new Error(`Kintio supervisor cannot start from ${this.#state}`));
    }
    this.#state = 'starting';
    this.#starting = (async () => {
      let startupErrorListener: ((error: Error) => void) | undefined;
      try {
        const runtime = await this.#runtimeFactory();
        this.#runtime = runtime;
        this.#assertStarting();
        const app = createApp({
          config: this.#config,
          logger: this.#logger,
          messageProcessor: runtime.messageProcessor,
          acceptIngress: () => this.#ingressOpen,
        });
        const server = createAdaptorServer({ fetch: app.fetch });
        this.#server = server;
        let rejectChannelFailure!: (error: Error) => void;
        const channelFailure = new Promise<never>((_resolve, reject) => {
          rejectChannelFailure = reject;
        });
        startupErrorListener = (error) => rejectChannelFailure(error);
        server.on('error', startupErrorListener);
        const port = await Promise.race([
          this.#listen(server),
          channelFailure,
        ]);
        this.#assertStarting();
        await Promise.race([runtime.start(), channelFailure]);
        this.#assertStarting();
        this.#ingressOpen = true;
        this.#state = 'running';
        server.on('error', (error) => this.#fatal(error));
        server.off('error', startupErrorListener);
        startupErrorListener = undefined;
        this.#logger.info(`Hono server is listening on port ${port}`);
        return Object.freeze({ port });
      } catch (error: unknown) {
        this.#ingressOpen = false;
        if (this.#state === 'starting') this.#state = 'failed';
        try {
          await this.#cleanupFailedStart();
        } finally {
          if (startupErrorListener && this.#server) {
            this.#server.off('error', startupErrorListener);
          }
        }
        throw error;
      }
    })();
    return this.#starting;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#state === 'closed') return Promise.resolve();
    if (this.#state === 'aborted') {
      return Promise.reject(new Error('Process-aborted supervisor requires process exit'));
    }
    this.#state = 'closing';
    this.#ingressOpen = false;
    this.#stopRuntimeIngress();
    this.#closing = (async () => {
      await this.#starting?.catch(() => undefined);
      try {
        await this.#closeRuntime();
      } finally {
        await this.#closeHttp(false).catch(() => undefined);
        if (!this.#aborting) this.#state = 'closed';
      }
    })();
    return this.#closing;
  }

  abortForExit(): Promise<void> {
    if (this.#aborting) return this.#aborting;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'closing';
    this.#ingressOpen = false;
    this.#stopRuntimeIngress();
    this.#aborting = (async () => {
      try {
        await Promise.all([
          this.#abortRuntime(),
          this.#closeHttp(true).catch(() => undefined),
        ]);
      } finally {
        this.#state = 'aborted';
      }
    })();
    return this.#aborting;
  }

  #assertStarting(): void {
    if (this.#state !== 'starting') {
      throw new Error('Kintio supervisor startup was cancelled');
    }
  }

  #listen(server: ServerType): Promise<number> {
    return new Promise((resolve, reject) => {
      server.listen(this.#config.port, '0.0.0.0', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Hono listener has no TCP address'));
          return;
        }
        resolve(address.port);
      });
    });
  }

  #fatal(error: Error): void {
    if (this.#state !== 'running') return;
    this.#state = 'failed';
    this.#ingressOpen = false;
    void this.abortForExit().catch((abortError: unknown) => {
      this.#logger.error(
        `[supervisor] fatal cleanup failed: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
      );
    });
    try {
      this.#onFatal(error);
    } catch (hookError: unknown) {
      this.#logger.error(
        `[supervisor] fatal hook failed: ${
          hookError instanceof Error ? hookError.message : String(hookError)
        }`,
      );
    }
  }

  async #cleanupFailedStart(): Promise<void> {
    this.#stopRuntimeIngress();
    try {
      await this.#abortRuntime();
    } finally {
      await this.#closeRuntime().catch(() => undefined);
      await this.#closeHttp(true).catch(() => undefined);
    }
  }

  #stopRuntimeIngress(): void {
    if (this.#runtimeIngressStopped) return;
    if (!this.#runtime) return;
    this.#runtimeIngressStopped = true;
    this.#runtime.stopAccepting();
  }

  #abortRuntime(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return Promise.resolve();
    this.#runtimeAbort ||= runtime.abort();
    return this.#runtimeAbort;
  }

  #closeRuntime(): Promise<void> {
    this.#runtimeClose ||= this.#runtime?.close() || Promise.resolve();
    return this.#runtimeClose;
  }

  async #closeHttp(force: boolean): Promise<void> {
    const server = this.#server;
    if (!server) return;
    if (!this.#httpClosing && server.listening) {
      this.#httpClosing = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    if (force) {
      (server as ServerType & { closeAllConnections?: () => void })
        .closeAllConnections?.();
    }
    await this.#httpClosing;
  }
}
