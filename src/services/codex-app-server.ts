import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { KINTIO_VERSION } from '../version.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const THREAD_LIST_PAGE_SIZE = 100;
const MAX_THREAD_LIST_PAGES = 100;
const THREAD_SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
] as const;

type JsonRecord = Record<string, unknown>;

export type CodexInput =
  | string
  | readonly (
      | { readonly type: 'text'; readonly text: string }
      | { readonly type: 'local_image'; readonly path: string }
    )[];

interface CodexItem extends JsonRecord {
  readonly id?: string;
  readonly type: string;
  readonly startedSequence?: number;
  readonly completedSequence?: number;
}

export interface CodexTurnResult {
  readonly items: readonly CodexItem[];
  readonly lastSteerSequence?: number;
}

export interface CodexRun {
  readonly turnId: string;
  readonly completion: Promise<CodexTurnResult>;
}

export interface CodexThreadOptions {
  readonly workingDirectory: string;
  readonly approvalPolicy: 'never';
  readonly developerInstructions?: string;
  readonly model?: string;
  readonly modelReasoningEffort?: string;
}

export interface CodexThread {
  readonly id: string | null;
  ensure?(): Promise<string>;
  startRun(
    input: CodexInput,
    options?: { readonly clientUserMessageId?: string },
  ): Promise<CodexRun>;
  steer(
    input: CodexInput,
    options?: { readonly clientUserMessageId?: string },
  ): Promise<string>;
  interrupt?(): Promise<boolean>;
}

export interface CodexBoundary {
  startThread(options: CodexThreadOptions): CodexThread;
  resumeThread(threadId: string, options: CodexThreadOptions): CodexThread;
  getThreadState?(threadId: string): Promise<'active' | 'archived' | 'missing'>;
  readThread(
    threadId: string,
    options?: { readonly includeTurns?: boolean },
  ): Promise<unknown>;
  deleteThread?(threadId: string): Promise<void>;
  close(): Promise<void>;
}

interface ProcessLike {
  readonly stdin: Writable & { readonly writable: boolean };
  readonly stdout: Readable;
  readonly stderr?: Readable;
  readonly exitCode: number | null;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
  command: string,
  argumentsList: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  },
) => ProcessLike;

export interface CodexAppServerOptions {
  readonly codexPathOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configOverrides?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: SpawnProcess;
  readonly logger?: { warn?(message: string): void };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface PendingRequest extends Deferred<unknown> {
  readonly timer: NodeJS.Timeout;
  readonly method: string;
}

interface TurnState {
  readonly items: CodexItem[];
  readonly itemStarts: Map<string, number>;
  readonly waiter: Deferred<CodexTurnResult>;
}

type ResolvedOptions = CodexAppServerOptions & {
  readonly requestTimeoutMs: number;
  readonly spawnProcess: SpawnProcess;
  readonly logger: NonNullable<CodexAppServerOptions['logger']>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function normalizeInput(input: CodexInput): JsonRecord[] {
  const values = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input;
  return values.map((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text, text_elements: [] }
      : { type: 'localImage', path: item.path },
  );
}

const defaultSpawn = spawn as unknown as SpawnProcess;

export class CodexAppServer implements CodexBoundary {
  readonly #options: ResolvedOptions;
  #process: ProcessLike | null = null;
  #reader: readline.Interface | null = null;
  #requestId = 1;
  #pending = new Map<number, PendingRequest>();
  #turns = new Map<string, TurnState>();
  #initializing: Promise<void> | null = null;
  #terminating: Promise<void> | null = null;
  #closed = false;
  eventSequence = 0;

  constructor(options: CodexAppServerOptions = {}) {
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs || REQUEST_TIMEOUT_MS,
      spawnProcess: options.spawnProcess || defaultSpawn,
      logger: options.logger || console,
    };
  }

  startThread(options: CodexThreadOptions): CodexThread {
    return new CodexAppServerThread(this, null, options);
  }

  resumeThread(threadId: string, options: CodexThreadOptions): CodexThread {
    return new CodexAppServerThread(this, threadId, options);
  }

  async getThreadState(
    threadId: string,
  ): Promise<'active' | 'archived' | 'missing'> {
    await this.initialize();
    const listed = async (archived: boolean): Promise<boolean> => {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_THREAD_LIST_PAGES; page += 1) {
        const result: {
          readonly data?: readonly { readonly id?: string }[];
          readonly nextCursor?: string | null;
        } = await this.request('thread/list', {
          archived,
          useStateDbOnly: true,
          limit: THREAD_LIST_PAGE_SIZE,
          sourceKinds: THREAD_SOURCE_KINDS,
          ...(cursor ? { cursor } : {}),
        });
        if ((result.data || []).some((thread) => thread.id === threadId)) {
          return true;
        }
        cursor = result.nextCursor || null;
        if (!cursor) return false;
      }
      throw new Error('Codex thread listing exceeded the pagination limit');
    };
    if (await listed(false)) return 'active';
    return await listed(true) ? 'archived' : 'missing';
  }

  async readThread(
    threadId: string,
    { includeTurns = true }: { readonly includeTurns?: boolean } = {},
  ): Promise<unknown> {
    await this.initialize();
    return this.request('thread/read', { threadId, includeTurns });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.initialize();
    await this.request('thread/delete', { threadId });
  }

  initialize(): Promise<void> {
    this.#initializing ||= this.#initialize();
    return this.#initializing;
  }

  async #initialize(): Promise<void> {
    const configArguments = (this.#options.configOverrides || [])
      .flatMap((value) => ['--config', value]);
    const command = this.#options.codexPathOverride || 'codex';
    const argumentsList = ['app-server', '--stdio', ...configArguments];
    const childEnvironment: NodeJS.ProcessEnv = this.#options.env
      ? { ...this.#options.env }
      : { ...process.env };
    childEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ||= 'kintio_app_server';
    const child = this.#options.spawnProcess(command, argumentsList, {
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.once('error', (error) => {
      this.#fail(new Error(
        `Codex app-server process error: ${error.message}`,
        { cause: error },
      ));
    });
    child.once('exit', (code, signal) => {
      if (this.#closed) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      this.#fail(new Error(`Codex app-server exited with ${detail}`));
    });
    child.stderr?.resume();
    this.#reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#reader.on('line', (line) => this.#handleLine(line));
    await this.request('initialize', {
      clientInfo: {
        name: 'kintio_codex',
        title: 'Kintio Codex Adapter',
        version: KINTIO_VERSION,
      },
      capabilities: null,
    });
    this.#write({ method: 'initialized', params: {} });
  }

  request<T = unknown>(
    method: string,
    params: JsonRecord,
    timeoutMs = this.#options.requestTimeoutMs,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.#requestId++;
    const result = deferred<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      result.reject(new Error(`Codex app-server request timed out: ${method}`));
    }, timeoutMs);
    timer.unref();
    this.#pending.set(id, { ...result, timer, method });
    try {
      this.#write({ method, id, params });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      result.reject(error);
    }
    return result.promise as Promise<T>;
  }

  waitForTurn(turnId: string): Promise<CodexTurnResult> {
    return this.#turnState(turnId).waiter.promise.finally(() => {
      this.#turns.delete(turnId);
    });
  }

  #write(message: JsonRecord): void {
    if (!this.#process?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#fail(new Error(`Invalid JSON from Codex app-server: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const message = asRecord(parsed);
    if (!message) {
      this.#fail(new Error('Codex app-server emitted a non-object message'));
      return;
    }
    if (typeof message.id === 'number' && typeof message.method !== 'string') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      const rpcError = asRecord(message.error);
      if (rpcError) {
        const error = new Error(
          `Codex app-server request failed: ${pending.method}`,
        ) as Error & { code?: unknown };
        error.code = rpcError.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.#write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }
    this.#handleNotification(message);
  }

  #turnState(turnId: string): TurnState {
    const existing = this.#turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = {
      items: [],
      itemStarts: new Map(),
      waiter: deferred<CodexTurnResult>(),
    };
    this.#turns.set(turnId, created);
    return created;
  }

  #handleNotification(message: JsonRecord): void {
    const sequence = ++this.eventSequence;
    const params = asRecord(message.params);
    if (message.method === 'item/started') {
      const item = asRecord(params?.item);
      if (typeof params?.turnId === 'string' && typeof item?.id === 'string') {
        this.#turnState(params.turnId).itemStarts.set(item.id, sequence);
      }
      return;
    }
    if (message.method === 'item/completed') {
      const item = asRecord(params?.item);
      if (
        typeof params?.turnId === 'string' &&
        item &&
        typeof item.type === 'string'
      ) {
        const state = this.#turnState(params.turnId);
        const id = typeof item.id === 'string' ? item.id : '';
        state.items.push({
          ...item,
          type: item.type,
          startedSequence: state.itemStarts.get(id) || sequence,
          completedSequence: sequence,
        });
        if (id) state.itemStarts.delete(id);
      }
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== 'string') return;
      const state = this.#turnState(turn.id);
      if (turn.status === 'completed') {
        state.waiter.resolve({ items: state.items });
      } else {
        state.waiter.reject(new Error(
          `Codex turn ended with status ${String(turn.status || 'unknown')}`,
        ));
      }
      return;
    }
    if (message.method === 'error') {
      this.#options.logger.warn?.(
        '[codex] app-server emitted an error notification; content suppressed',
      );
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const state of this.#turns.values()) state.waiter.reject(error);
    this.#turns.clear();
  }

  #fail(error: Error): void {
    void this.#shutdown(error);
  }

  #shutdown(error: Error): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#reader?.close();
      this.#rejectAll(error);
    }
    return this.#terminate();
  }

  #terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    const child = this.#process;
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.#terminating = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      timer.unref();
    }).finally(() => {
      this.#terminating = null;
    });
    return this.#terminating;
  }

  async close(): Promise<void> {
    await this.#shutdown(new Error('Codex app-server closed'));
  }
}

class CodexAppServerThread implements CodexThread {
  readonly #server: CodexAppServer;
  readonly #options: CodexThreadOptions;
  #ready: Promise<void> | null = null;
  #activeTurnId = '';
  #lastSteerSequence = 0;
  #lastSteerClientId = '';
  id: string | null;

  constructor(server: CodexAppServer, threadId: string | null, options: CodexThreadOptions) {
    this.#server = server;
    this.#options = options;
    this.id = threadId;
  }

  #params(): JsonRecord {
    return {
      cwd: this.#options.workingDirectory,
      approvalPolicy: this.#options.approvalPolicy,
      sandbox: 'read-only',
      ...(this.#options.model ? { model: this.#options.model } : {}),
      ...(this.#options.developerInstructions
        ? { developerInstructions: this.#options.developerInstructions }
        : {}),
    };
  }

  #ensureThread(): Promise<void> {
    this.#ready ||= (async () => {
      await this.#server.initialize();
      const result = this.id
        ? await this.#server.request<{ thread: { id: string } }>('thread/resume', {
            threadId: this.id,
            ...this.#params(),
          })
        : await this.#server.request<{ thread: { id: string } }>('thread/start', this.#params());
      this.id = result.thread.id;
    })();
    return this.#ready;
  }

  async ensure(): Promise<string> {
    await this.#ensureThread();
    if (!this.id) throw new Error('Codex thread has no ID');
    return this.id;
  }

  async startRun(
    input: CodexInput,
    { clientUserMessageId }: { readonly clientUserMessageId?: string } = {},
  ): Promise<CodexRun> {
    await this.#ensureThread();
    if (!this.id) throw new Error('Codex thread has no ID');
    if (this.#activeTurnId) throw new Error('Codex thread already has an active turn');
    this.#lastSteerSequence = 0;
    this.#lastSteerClientId = '';
    const result = await this.#server.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.id,
      input: normalizeInput(input),
      ...this.#params(),
      ...(this.#options.modelReasoningEffort ? { effort: this.#options.modelReasoningEffort } : {}),
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
    const turnId = result.turn.id;
    this.#activeTurnId = turnId;
    const completion = this.#server.waitForTurn(turnId).then((completed) => {
      const boundaryItem = [...completed.items].reverse().find(
        (item) => item.type === 'userMessage' && item.clientId === this.#lastSteerClientId,
      );
      return {
        ...completed,
        lastSteerSequence: boundaryItem?.completedSequence || this.#lastSteerSequence,
      };
    }).finally(() => {
      if (this.#activeTurnId === turnId) this.#activeTurnId = '';
    });
    return { turnId, completion };
  }

  async steer(
    input: CodexInput,
    { clientUserMessageId }: { readonly clientUserMessageId?: string } = {},
  ): Promise<string> {
    await this.#ensureThread();
    if (!this.id || !this.#activeTurnId) {
      throw new Error('Codex thread has no active turn to steer');
    }
    const result = await this.#server.request<{ turnId: string }>('turn/steer', {
      threadId: this.id,
      input: normalizeInput(input),
      expectedTurnId: this.#activeTurnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
    this.#lastSteerSequence = this.#server.eventSequence;
    this.#lastSteerClientId = clientUserMessageId || '';
    return result.turnId;
  }

  async interrupt(): Promise<boolean> {
    if (!this.id || !this.#activeTurnId) return false;
    await this.#server.request('turn/interrupt', {
      threadId: this.id,
      turnId: this.#activeTurnId,
    });
    return true;
  }
}
