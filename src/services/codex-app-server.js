import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 32 * 1024;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tomlValue(value, keyPath) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Codex config value at ${keyPath} must be finite`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => tomlValue(item, `${keyPath}[${index}]`))
      .join(', ')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)} = ${tomlValue(child, `${keyPath}.${key}`)}`,
      )
      .join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config value at ${keyPath}`);
}

function flattenConfig(value, prefix = '', output = []) {
  if (!isPlainObject(value)) {
    if (!prefix) throw new Error('Codex config must be a plain object');
    output.push(`${prefix}=${tomlValue(value, prefix)}`);
    return output;
  }

  if (prefix && Object.keys(value).length === 0) {
    output.push(`${prefix}={}`);
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child) && Object.keys(child).length > 0) {
      flattenConfig(child, childPath, output);
    } else {
      output.push(`${childPath}=${tomlValue(child, childPath)}`);
    }
  }

  return output;
}

function normalizeInput(input) {
  const values = typeof input === 'string' ? [{ type: 'text', text: input }] : input;

  return (values || []).map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: String(item.text || ''), text_elements: [] };
    }
    if (item.type === 'local_image' || item.type === 'localImage') {
      return { type: 'localImage', path: String(item.path || '') };
    }
    throw new Error(`Unsupported Codex app-server input type: ${item.type}`);
  });
}

function sdkItem(item) {
  const timing = {
    startedSequence: Number(item?._startedSequence || 0),
    completedSequence: Number(item?._completedSequence || 0),
  };
  if (item?.type === 'agentMessage') {
    return {
      id: item.id,
      type: 'agent_message',
      text: item.text || '',
      ...timing,
    };
  }

  if (item?.type === 'mcpToolCall') {
    const structuredContent = item.result?.structuredContent ?? null;
    return {
      id: item.id,
      type: 'mcp_tool_call',
      server: item.server,
      tool: item.tool,
      arguments: item.arguments || {},
      status:
        item.status === 'inProgress'
          ? 'in_progress'
          : item.status === 'completed'
            ? 'completed'
            : 'failed',
      result: item.result
        ? {
            content: item.result.content || [],
            structuredContent,
            structured_content: structuredContent,
          }
        : null,
      error: item.error || null,
      ...timing,
    };
  }

  return { ...item, ...timing };
}

function completedTurnResult(turn, collectedItems) {
  const byId = new Map();
  for (const item of [...(turn.items || []), ...collectedItems]) {
    byId.set(item.id || `${item.type}:${byId.size}`, item);
  }
  const items = [...byId.values()].map(sdkItem);
  const finalResponse = [...items]
    .reverse()
    .find((item) => item.type === 'agent_message')?.text || '';

  if (turn.status === 'failed') {
    const message = turn.error?.message || 'Codex turn failed';
    throw new Error(message);
  }
  if (turn.status === 'interrupted') {
    throw new Error('Codex turn was interrupted');
  }

  return { items, finalResponse, usage: null };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class CodexAppServer {
  constructor({
    codexPathOverride = '',
    env,
    config = {},
    configOverrides = [],
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnProcess = spawn,
    onNotification,
    logger = console,
  } = {}) {
    this.codexPathOverride = codexPathOverride;
    this.env = env;
    this.config = config;
    this.configOverrides = configOverrides;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.onNotification = onNotification;
    this.logger = logger;
    this.process = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.initializing = null;
    this.stderr = '';
    this.closed = false;
    this.eventSequence = 0;
  }

  startThread(options = {}) {
    return new CodexAppServerThread(this, null, options);
  }

  resumeThread(threadId, options = {}) {
    return new CodexAppServerThread(this, String(threadId), options);
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    const configArguments = [
      ...flattenConfig(this.config),
      ...this.configOverrides,
    ].flatMap((override) => ['--config', override]);
    let command;
    let argumentsList;

    if (this.codexPathOverride) {
      command = this.codexPathOverride;
      argumentsList = ['app-server', '--stdio', ...configArguments];
    } else {
      command = process.execPath;
      argumentsList = [
        require.resolve('@openai/codex/bin/codex.js'),
        'app-server',
        '--stdio',
        ...configArguments,
      ];
    }

    const childEnvironment = this.env
      ? { ...this.env }
      : Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined),
        );
    childEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ||= 'wechat_kf_app_server';
    this.process = this.spawnProcess(command, argumentsList, {
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.once('error', (error) => this.#fail(error));
    this.process.once('exit', (code, signal) => {
      if (this.closed && (code === 0 || signal === 'SIGTERM')) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      this.#fail(
        new Error(
          `Codex app-server exited with ${detail}${this.stderr ? `: ${this.stderr}` : ''}`,
        ),
      );
    });
    this.process.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(
        -MAX_STDERR_BYTES,
      );
    });
    this.readline = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    this.readline.on('line', (line) => this.#handleLine(line));

    await this.request('initialize', {
      clientInfo: {
        name: 'wechat_kf_codex',
        title: 'WeChat Customer Service Codex Bridge',
        version: '1.0.0',
      },
      capabilities: null,
    });
    this.notify('initialized', {});
  }

  #write(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const pending = deferred();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      pending.reject(new Error(`Codex app-server request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { ...pending, timer, method });

    try {
      this.#write({ method, id, params });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      pending.reject(error);
    }

    return pending.promise;
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#fail(new Error(`Invalid JSON from Codex app-server: ${error.message}`));
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }

    this.#handleNotification(message);
  }

  #turnState(turnId) {
    let state = this.turns.get(turnId);
    if (!state) {
      state = {
        items: [],
        itemStarts: new Map(),
        waiter: deferred(),
        completed: null,
      };
      this.turns.set(turnId, state);
    }
    return state;
  }

  #handleNotification(message) {
    this.eventSequence += 1;
    const sequence = this.eventSequence;
    try {
      this.onNotification?.(message, sequence);
    } catch (error) {
      this.logger.warn?.(
        `[codex] app-server notification observer failed: ${error.message}`,
      );
    }

    if (message.method === 'item/started') {
      const { turnId, item } = message.params || {};
      if (turnId && item?.id) {
        this.#turnState(turnId).itemStarts.set(item.id, sequence);
      }
      return;
    }

    if (message.method === 'item/completed') {
      const { turnId, item } = message.params || {};
      if (turnId && item) {
        const state = this.#turnState(turnId);
        state.items.push({
          ...item,
          _startedSequence: state.itemStarts.get(item.id) || sequence,
          _completedSequence: sequence,
        });
      }
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      if (!turn?.id) return;
      const state = this.#turnState(turn.id);
      state.completed = turn;
      try {
        state.waiter.resolve(completedTurnResult(turn, state.items));
      } catch (error) {
        state.waiter.reject(error);
      }
      return;
    }

    if (message.method === 'error') {
      this.logger.warn?.(
        `[codex] app-server notification error: ${message.params?.error?.message || message.params?.message || 'unknown error'}`,
      );
    }
  }

  waitForTurn(turnId) {
    return this.#turnState(turnId).waiter.promise;
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const state of this.turns.values()) state.waiter.reject(error);
    this.turns.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.readline?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    for (const state of this.turns.values()) {
      state.waiter.reject(new Error('Codex app-server closed'));
    }
    this.turns.clear();
    if (!this.process || this.process.exitCode !== null) return;

    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.kill('SIGTERM');
    const timer = setTimeout(() => this.process?.kill('SIGKILL'), 2_000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }
}

class CodexAppServerThread {
  constructor(server, threadId, options) {
    this.server = server;
    this.persistedThreadId = threadId;
    this.options = options;
    this.id = threadId;
    this.activeTurnId = '';
    this.threadReady = null;
    this.lastSteerSequence = 0;
    this.lastSteerClientUserMessageId = '';
  }

  async #ensureThread() {
    if (this.threadReady) return this.threadReady;
    this.threadReady = this.#openThread();
    return this.threadReady;
  }

  #threadParams() {
    const params = {
      cwd: this.options.workingDirectory,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
    };
    if (this.options.model) params.model = this.options.model;
    return Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined),
    );
  }

  async #openThread() {
    await this.server.initialize();
    const result = this.persistedThreadId
      ? await this.server.request('thread/resume', {
          threadId: this.persistedThreadId,
          ...this.#threadParams(),
        })
      : await this.server.request('thread/start', this.#threadParams());
    this.id = result.thread.id;
    return result.thread;
  }

  async startRun(input, turnOptions = {}) {
    await this.#ensureThread();
    if (this.activeTurnId) throw new Error('Codex thread already has an active turn');
    this.lastSteerSequence = 0;
    this.lastSteerClientUserMessageId = '';
    const params = {
      threadId: this.id,
      input: normalizeInput(input),
      cwd: this.options.workingDirectory,
      approvalPolicy: this.options.approvalPolicy,
    };
    if (this.options.model) params.model = this.options.model;
    if (this.options.modelReasoningEffort) {
      params.effort = this.options.modelReasoningEffort;
    }
    if (turnOptions.clientUserMessageId) {
      params.clientUserMessageId = String(turnOptions.clientUserMessageId);
    }
    if (turnOptions.outputSchema) params.outputSchema = turnOptions.outputSchema;
    const result = await this.server.request('turn/start', params);
    const turnId = result.turn.id;
    this.activeTurnId = turnId;
    const completion = this.server
      .waitForTurn(turnId)
      .then((completed) => {
        const steeredUserMessage = [...completed.items]
          .reverse()
          .find(
            (item) =>
              item.type === 'userMessage' &&
              item.clientId === this.lastSteerClientUserMessageId,
          );
        return {
          ...completed,
          lastSteerSequence:
            steeredUserMessage?.completedSequence || this.lastSteerSequence,
        };
      })
      .finally(() => {
        if (this.activeTurnId === turnId) this.activeTurnId = '';
      });
    return { turnId, completion };
  }

  async steer(input, { clientUserMessageId = undefined } = {}) {
    await this.#ensureThread();
    const expectedTurnId = this.activeTurnId;
    if (!expectedTurnId) throw new Error('Codex thread has no active turn to steer');
    const result = await this.server.request('turn/steer', {
      threadId: this.id,
      input: normalizeInput(input),
      expectedTurnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
    this.lastSteerSequence = this.server.eventSequence;
    this.lastSteerClientUserMessageId = String(clientUserMessageId || '');
    return result.turnId;
  }

  async run(input, turnOptions = {}) {
    const run = await this.startRun(input, turnOptions);
    return run.completion;
  }

  close() {
    return this.server.close();
  }
}
