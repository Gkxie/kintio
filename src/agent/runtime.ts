import type { ChatChannel, ResolvedImage } from '../types.ts';

export type AgentAccess = 'restricted' | 'host';

export class AgentTurnCancelledError extends Error {
  constructor() { super('Agent turn intentionally cancelled at the approval boundary'); }
}

export interface AgentMessage {
  readonly messageKey: string;
  readonly text: string;
  readonly summary: string;
}

interface AgentMediaCapability {
  readonly ref: string;
  readonly kind: 'image';
  readonly messageKey: string;
}

interface AgentArtifactCapability {
  readonly ref: string;
  readonly kind: 'image';
}

export interface AgentArtifact extends Record<string, unknown> {
  readonly type: string;
}

export interface AgentImageArtifact extends AgentArtifact {
  readonly type: 'generated_image';
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentInput {
  readonly approvalCode?: string;
  readonly controlRefresh?: boolean;
  readonly approvals?: {
    readonly isAllowed: () => boolean;
    readonly notify: (content: string, signal: AbortSignal) => Promise<void>;
  } | undefined;
  readonly agentAccess?: AgentAccess;
  readonly channel: ChatChannel;
  readonly mode: 'start' | 'steer';
  readonly conversationId: string;
  readonly threadId: string;
  readonly message: AgentMessage;
  readonly resolvedMedia?: readonly ResolvedImage[];
  readonly mediaCatalog?: readonly AgentMediaCapability[];
  readonly artifactCatalog?: readonly AgentArtifactCapability[];
  readonly contextText: string;
  readonly channelState?: {
    readonly accepted?: boolean;
    readonly customerObserved?: boolean;
    readonly revisedPrompt?: unknown;
  };
  readonly clientInputId?: string;
  readonly toolSessionToken: string;
  readonly publishArtifact?: (artifact: AgentImageArtifact) => Promise<string>;
  readonly allowNoAction?: boolean;
  readonly archivedThreadId?: string;
}

export interface AgentCompletion {
  readonly executedAttemptIds?: readonly string[];
  readonly decision?: 'no_action';
}

export type AgentSubmission =
  | {
      readonly kind: 'started';
      readonly primaryMessageKey: string;
      readonly turnId: string;
      readonly threadId: string;
      readonly completion: Promise<AgentCompletion>;
    }
  | {
      readonly kind: 'steered';
      readonly primaryMessageKey: string;
      readonly turnId: string;
    };

export interface HistoryInspection {
  readonly state: 'missing' | 'completed' | 'failed' | 'input_only';
  readonly turnId: string;
  readonly foundClientInputIds: ReadonlySet<string>;
  readonly artifacts: readonly AgentArtifact[];
  readonly executedAttemptIds?: readonly string[];
}

export interface AgentRuntime {
  pendingApproval?(conversationId: string, code: string, option?: number): {
    readonly primaryMessageKey: string;
    readonly turnId: string;
  } | undefined;
  respondApproval?(conversationId: string, code: string, option: number, isCurrent: () => boolean): boolean;
  cancelApprovals?(conversationId: string): void;
  invalidateApprovals?(): void;
  ensureThread(
    conversationId: string,
    threadId: string,
    agentAccess?: AgentAccess,
    channel?: ChatChannel,
  ): Promise<string>;
  takePendingMemoryThread?(conversationId: string): string;
  activePrimary(conversationId: string, includeFinishing?: boolean): string | undefined;
  interrupt?(conversationId: string): Promise<boolean>;
  submit(input: AgentInput): Promise<AgentSubmission>;
  inspectHistory?(
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
    agentAccess?: AgentAccess,
    channel?: ChatChannel,
  ): Promise<HistoryInspection>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
