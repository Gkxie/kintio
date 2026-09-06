import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

import { AgentTurnCancelledError } from '../agent/runtime.ts';

import { KINTIO_VERSION } from '../version.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const THREAD_LIST_PAGE_SIZE = 100;
const MAX_THREAD_LIST_PAGES = 100;
const THREAD_SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
] as const;
const CODEX_ERROR_CATEGORIES = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded',
  'rateLimitExceeded', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation',
  'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed',
  'sandboxError', 'other',
]);
const CODEX_OBJECT_ERROR_CATEGORIES = new Set([
  'httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
]);

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
  readonly approvalPolicy?: 'never';
  readonly sandbox?: 'read-only';
  readonly developerInstructions?: string;
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
  setApprovalHandler?(handler: (request: CodexApprovalRequest) => Promise<CodexApprovalResult>): void;
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

export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel';
export type CodexApprovalResult = 'decline' | 'cancel' | {
  readonly decision: CodexApprovalDecision;
  readonly isAllowed: () => boolean;
};
export interface CodexApprovalRequest {
  readonly id: string | number;
  readonly kind: 'command' | 'file';
  readonly threadId: string;
  readonly turnId: string;
  readonly params: JsonRecord;
  readonly item?: JsonRecord;
  readonly signal: AbortSignal;
}

interface ProcessLike {
  readonly stdin: Writable & { readonly writable: boolean };
  readonly stdout: Readable;
  readonly stderr?: Readable;
  readonly exitCode: number | null;
  on(event: 'error', listener: (error: Error) => void): this;
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
    readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
    readonly windowsHide: true;
  },
) => ProcessLike;

export interface CodexAppServerOptions {
  readonly configOverrides?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly approvalTimeoutMs?: number;
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
  readonly itemStarts: Map<string, { readonly sequence: number; readonly item: JsonRecord }>;
  readonly waiter: Deferred<CodexTurnResult>;
  failure?: string;
  approvalCancelled?: boolean;
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

function codexFailureLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return CODEX_ERROR_CATEGORIES.has(value) ? value : 'other';
  }
  const record = asRecord(value);
  const keys = record ? Object.keys(record) : [];
  const category = keys.length === 1 ? keys[0] || '' : '';
  if (!CODEX_OBJECT_ERROR_CATEGORIES.has(category)) return 'other';
  const detail = asRecord(record?.[category]);
  const status = detail?.httpStatusCode;
  return category + (typeof status === 'number' && Number.isInteger(status) &&
    status >= 100 && status <= 599
    ? ` (HTTP ${status})`
    : '');
}

function normalizeInput(input: CodexInput): JsonRecord[] {
  const values = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input;
  return values.map((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text, text_elements: [] }
      : { type: 'localImage', path: item.path },
  );
}

const defaultSpawn = crossSpawn as unknown as SpawnProcess;

export class CodexAppServer implements CodexBoundary {
  readonly #failure = deferred<Error>();
  readonly failure = this.#failure.promise;
  readonly #options: ResolvedOptions;
  #process: ProcessLike | null = null;
  #reader: readline.Interface | null = null;
  #requestId = 1;
  #pending = new Map<number, PendingRequest>();
  readonly #approvals = new Map<string | number, {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly controller: AbortController;
    readonly timer: NodeJS.Timeout;
  }>();
  #approvalHandler?: (request: CodexApprovalRequest) => Promise<CodexApprovalResult>;
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

  setApprovalHandler(handler: (request: CodexApprovalRequest) => Promise<CodexApprovalResult>): void {
    this.#approvalHandler = handler;
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
    if (this.#closed) return Promise.reject(new Error('Codex app-server is closed'));
    this.#initializing ||= this.#initialize().catch((error: unknown) => {
      this.#fail(new Error('Codex app-server initialization failed', { cause: error }));
      throw error;
    });
    return this.#initializing;
  }

  async #initialize(): Promise<void> {
    const configArguments = (this.#options.configOverrides || [])
      .flatMap((value) => ['--config', value]);
    const command = 'codex';
    const argumentsList = ['app-server', '--stdio', ...configArguments];
    const child = this.#options.spawnProcess(command, argumentsList, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#process = child;
    child.on('error', (error) => {
      this.#fail(new Error(
        `Codex app-server process error: ${error.message}`,
        { cause: error },
      ));
    });
    child.once('exit', (code, signal) => {
      if (this.#process === child) this.#process = null;
      if (this.#closed) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      this.#fail(new Error(`Codex app-server exited with ${detail}`));
    });
    child.stderr?.resume();
    child.stdin.on('error', () => this.#fail(new Error('Codex app-server input failed')));
    this.#reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#reader.on('line', (line) => this.#handleLine(line));
    this.#reader.on('error', () => this.#fail(new Error('Codex app-server output failed')));
    this.#reader.on('close', () => this.#fail(new Error('Codex app-server output closed')));
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
    } catch {
      this.#fail(new Error('Invalid JSON from Codex app-server'));
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
        const code = typeof rpcError.code === 'number' && Number.isSafeInteger(rpcError.code)
          ? rpcError.code
          : undefined;
        const errorData = asRecord(rpcError.data);
        const category = codexFailureLabel(
          errorData?.codexErrorInfo ?? rpcError.codexErrorInfo,
        );
        const diagnostic = [
          ...(code === undefined ? [] : [`code ${code}`]),
          ...(category ? [`category ${category}`] : []),
        ];
        const error = new Error(
          `Codex app-server request failed: ${pending.method}` +
          (diagnostic.length ? ` (${diagnostic.join('; ')})` : ''),
        ) as Error & { code?: number };
        if (code !== undefined) error.code = code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      if (this.#handleApproval(message as JsonRecord & { id: string | number })) return;
      this.#write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }
    this.#handleNotification(message);
  }

  #handleApproval(message: JsonRecord & { id: string | number }): boolean {
    const kind = message.method === 'item/commandExecution/requestApproval' ? 'command'
      : message.method === 'item/fileChange/requestApproval' ? 'file' : undefined;
    if (!kind || !this.#approvalHandler) return false;
    const params = asRecord(message.params);
    if (!params || typeof params.threadId !== 'string' || typeof params.turnId !== 'string' ||
      typeof params.itemId !== 'string' || this.#approvals.has(message.id) || this.#approvals.size >= 32) {
      this.#clearApprovals((id) => id === message.id);
      this.#write({ id: message.id, error: { code: -32602, message: 'Invalid or unavailable approval request' } });
      return true;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (this.#approvals.get(message.id)?.controller !== controller) return;
      if (!this.#closed) {
        try { this.#finishApproval(message.id, 'cancel'); }
        catch { this.#fail(new Error('Codex app-server approval cancellation failed')); }
      }
    }, Math.max(1, Math.min(this.#options.approvalTimeoutMs || 300_000, 300_000)));
    timer.unref();
    this.#approvals.set(message.id, { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, controller, timer });
    const item = this.#turns.get(params.turnId)?.itemStarts.get(params.itemId)?.item;
    const request: CodexApprovalRequest = {
      id: message.id, kind, threadId: params.threadId, turnId: params.turnId, params,
      ...(item ? { item } : {}),
      signal: controller.signal,
    };
    void Promise.resolve().then(() => this.#approvalHandler!(request)).catch(() => 'cancel' as const).then((result) => {
      if (this.#closed || this.#approvals.get(message.id)?.controller !== controller) return;
      let decision: CodexApprovalDecision = 'cancel';
      try {
        if (typeof result === 'string') decision = result === 'decline' ? 'decline' : 'cancel';
        else if (result.isAllowed() && ['accept', 'decline', 'cancel'].includes(result.decision)) decision = result.decision;
      } catch { /* A failed freshness check never grants permission. */ }
      this.#finishApproval(message.id, decision);
    }).catch(() => this.#fail(new Error('Codex app-server approval response failed')));
    return true;
  }

  #finishApproval(id: string | number, decision: CodexApprovalDecision): void {
    const request = this.#approvals.get(id);
    if (!request || this.#closed) return;
    const cancellation = decision === 'cancel' ? new AgentTurnCancelledError() : undefined;
    if (cancellation) this.#turnState(request.turnId).approvalCancelled = true;
    this.#clearApprovals((candidate) => candidate === id, cancellation);
    this.#write({ id, result: { decision } });
  }

  #clearApprovals(predicate: (id: string | number, request: { threadId: string; turnId: string }) => boolean, reason?: Error): void {
    for (const [id, request] of this.#approvals) {
      if (!predicate(id, request)) continue;
      this.#approvals.delete(id);
      clearTimeout(request.timer);
      request.controller.abort(reason);
    }
  }

  #turnState(turnId: string): TurnState {
    const existing = this.#turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = {
      items: [],
      itemStarts: new Map(),
      waiter: deferred<CodexTurnResult>(),
    };
    // Notifications can precede the turn/start response, so no caller may be
    // waiting yet when a fatal transport error rejects this owned promise.
    void created.waiter.promise.catch(() => undefined);
    this.#turns.set(turnId, created);
    return created;
  }

  #handleNotification(message: JsonRecord): void {
    const sequence = ++this.eventSequence;
    const params = asRecord(message.params);
    if (message.method === 'serverRequest/resolved') {
      this.#clearApprovals((id, request) => id === params?.requestId && request.threadId === params.threadId);
      return;
    }
    if (message.method === 'thread/archived' || message.method === 'thread/closed' || message.method === 'thread/deleted') {
      this.#clearApprovals((_id, request) => request.threadId === params?.threadId);
      return;
    }
    if (message.method === 'item/fileChange/patchUpdated' && typeof params?.turnId === 'string' && typeof params.itemId === 'string') {
      const starts = this.#turns.get(params.turnId)?.itemStarts;
      const previous = starts?.get(params.itemId);
      if (previous) starts?.set(params.itemId, { sequence: previous.sequence, item: { ...previous.item, changes: params.changes } });
      for (const [id, approval] of this.#approvals) {
        if (approval.threadId !== params.threadId || approval.turnId !== params.turnId || approval.itemId !== params.itemId) continue;
        this.#finishApproval(id, 'cancel');
      }
      return;
    }
    if (message.method === 'item/started') {
      const item = asRecord(params?.item);
      if (typeof params?.turnId === 'string' && typeof item?.id === 'string') {
        this.#turnState(params.turnId).itemStarts.set(item.id, { sequence, item });
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
          startedSequence: state.itemStarts.get(id)?.sequence || sequence,
          completedSequence: sequence,
        });
        if (id) state.itemStarts.delete(id);
      }
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== 'string') return;
      this.#clearApprovals((_id, request) => request.turnId === turn.id);
      const state = this.#turnState(turn.id);
      if (state.approvalCancelled) {
        state.waiter.reject(new AgentTurnCancelledError());
      } else if (turn.status === 'completed') {
        state.waiter.resolve({ items: state.items });
      } else {
        const status = turn.status === 'failed' || turn.status === 'interrupted'
          ? turn.status
          : 'unknown';
        const failure = status === 'failed'
          ? codexFailureLabel(asRecord(turn.error)?.codexErrorInfo) ?? state.failure
          : undefined;
        state.waiter.reject(new Error(
          `Codex turn ended with status ${status}` +
          `${failure ? `: ${failure}` : ''}`,
        ));
      }
      return;
    }
    if (message.method === 'error') {
      const error = asRecord(params?.error);
      const failure = codexFailureLabel(error?.codexErrorInfo);
      if (typeof params?.turnId === 'string' && failure !== undefined) {
        this.#turnState(params.turnId).failure = failure;
      }
      this.#options.logger.warn?.(
        failure !== undefined
          ? `[codex] app-server error category=${failure}; content suppressed`
          : '[codex] app-server emitted an error notification; content suppressed',
      );
    }
  }

  #rejectAll(error: Error): void {
    this.#clearApprovals(() => true);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const state of this.#turns.values()) state.waiter.reject(error);
    this.#turns.clear();
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    void this.#shutdown(error);
    this.#failure.resolve(error);
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
      ...(this.#options.approvalPolicy
        ? { approvalPolicy: this.#options.approvalPolicy }
        : {}),
      ...(this.#options.sandbox ? { sandbox: this.#options.sandbox } : {}),
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
    if (result.turnId !== this.#activeTurnId) throw new Error('Codex steering acknowledged a different turn');
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
