import type {
  AgentCompletion,
  AgentInput,
  AgentRuntime,
  AgentSubmission,
  HistoryInspection,
} from '../../src/agent/runtime.ts';
import type { SendIntent } from '../../src/domain/send-contract.ts';
import type { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';

export interface SimulatedAgentCompletion extends AgentCompletion {
  readonly replies?: readonly SendIntent[];
}

export type SimulatedAgentSubmission =
  | Omit<Extract<AgentSubmission, { kind: 'started' }>, 'completion'> & {
      readonly completion: Promise<SimulatedAgentCompletion>;
    }
  | Extract<AgentSubmission, { kind: 'steered' }>;

export interface SimulatedAgentRuntime {
  submit(input: AgentInput): Promise<SimulatedAgentSubmission>;
  ensureThread?(conversationId: string, threadId: string): Promise<string>;
  takePendingMemoryThread?(conversationId: string): string;
  activePrimary?(conversationId: string): string | undefined;
  interrupt?(conversationId: string): Promise<boolean>;
  inspectHistory?(
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
  ): Promise<HistoryInspection>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function toolCall(reply: SendIntent): {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
} {
  if (reply.type === 'text') {
    return {
      name: 'send_text',
      arguments: { content: reply.content },
    };
  }
  const { type, ...argumentsList } = reply;
  return {
    name: `send_${type}`,
    arguments: { ...argumentsList },
  };
}

export class SimulatedToolAgent implements AgentRuntime {
  readonly #inner: SimulatedAgentRuntime;
  readonly #tools: Pick<WechatKfToolExecutor, 'execute'>;
  readonly #active = new Map<string, {
    readonly primaryMessageKey: string;
    sessionToken: string;
  }>();

  constructor({
    inner,
    tools,
  }: {
    inner: SimulatedAgentRuntime;
    tools: Pick<WechatKfToolExecutor, 'execute'>;
  }) {
    this.#inner = inner;
    this.#tools = tools;
  }

  async #execute(
    sessionToken: string,
    completion: SimulatedAgentCompletion,
  ): Promise<AgentCompletion> {
    const { replies = [], ...result } = completion;
    if (completion.executedAttemptIds?.length || replies.length === 0) return result;
    const attemptIds: string[] = [];
    for (const reply of replies) {
      const call = toolCall(reply);
      const result = await this.#tools.execute(call.name, {
        session: sessionToken,
        ...call.arguments,
      });
      attemptIds.push(result.attemptId);
    }
    return { ...result, executedAttemptIds: attemptIds };
  }

  async submit(input: AgentInput): Promise<AgentSubmission> {
    if (input.mode === 'steer') {
      const active = this.#active.get(input.conversationId);
      if (active) active.sessionToken = input.toolSessionToken;
    }
    const submission = await this.#inner.submit(input);
    if (submission.kind === 'steered') {
      return submission;
    }
    const active = {
      primaryMessageKey: submission.primaryMessageKey,
      sessionToken: input.toolSessionToken,
    };
    this.#active.set(input.conversationId, active);
    const completion = submission.completion.then((result) =>
      this.#execute(active.sessionToken, result));
    void completion.then(
      () => this.#active.delete(input.conversationId),
      () => this.#active.delete(input.conversationId),
    );
    return {
      ...submission,
      completion,
    };
  }

  ensureThread(conversationId: string, threadId: string): Promise<string> {
    return this.#inner.ensureThread?.(conversationId, threadId) ||
      Promise.resolve(threadId || `thread-${conversationId}`);
  }

  takePendingMemoryThread(conversationId: string): string {
    return this.#inner.takePendingMemoryThread?.(conversationId) || '';
  }

  activePrimary(conversationId: string): string | undefined {
    return this.#inner.activePrimary?.(conversationId) ||
      this.#active.get(conversationId)?.primaryMessageKey;
  }

  interrupt(conversationId: string): Promise<boolean> {
    return this.#inner.interrupt?.(conversationId) || Promise.resolve(false);
  }

  async inspectHistory(
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
  ): Promise<HistoryInspection> {
    if (this.#inner.inspectHistory) {
      return this.#inner.inspectHistory(
        threadId,
        clientInputIds,
        latestClientInputId,
      );
    }
    return {
      state: 'missing',
      turnId: '',
      foundClientInputIds: new Set(),
      artifacts: [],
      executedAttemptIds: [],
    };
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  abort(): Promise<void> {
    return this.#inner.abort();
  }
}
