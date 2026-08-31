import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import { KINTIO_VERSION } from '../version.ts';
import { handleMcpHttpRequest } from './http.ts';

const MAX_TEXT_BYTES = 2_000;
const SESSION = /^ws_[A-Za-z0-9_-]{32}$/u;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,128}$/u;

const ERROR_KINDS = [
  'reply_window_expired',
  'reply_quota_exhausted',
  'ilink_session_invalid',
  'ilink_delivery_failed',
  'uncertain_result',
  'media_prepare_failed',
  'invalid_media_reference',
  'ilink_tool_error',
] as const;
type IlinkToolErrorKind = (typeof ERROR_KINDS)[number];

const SAFE_ERROR_MESSAGES: Readonly<Record<IlinkToolErrorKind, string>> = {
  reply_window_expired:
    'The iLink reply window closed 24 hours after the participant\'s last message. Stop retrying and wait for another inbound message.',
  reply_quota_exhausted:
    'The ten-message quota for this iLink reply window is exhausted. Stop retrying and wait for another inbound message.',
  ilink_session_invalid: 'The bound iLink session is no longer valid.',
  ilink_delivery_failed: 'iLink rejected the message.',
  uncertain_result: 'The iLink delivery outcome is uncertain and may have succeeded.',
  media_prepare_failed: 'The iLink image could not be prepared for delivery.',
  invalid_media_reference: 'The bound iLink image reference is unavailable.',
  ilink_tool_error: 'The iLink tool could not execute the message.',
};

const ERROR_INPUT_SCHEMA = z.strictObject({
  kind: z.string(),
  message: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
  ret: z.number().int().optional(),
});
const EXECUTOR_RECEIPT_SCHEMA = z.strictObject({
  status: z.enum(['accepted', 'failed', 'uncertain']),
  attemptId: z.string(),
  sendIndex: z.number().int().min(-1),
  type: z.enum(['text', 'image']),
  msgid: z.string(),
  error: ERROR_INPUT_SCHEMA.optional(),
});
const ERROR_OUTPUT_SCHEMA = z.strictObject({
  kind: z.enum(ERROR_KINDS),
  message: z.string(),
  code: z.union([
    z.string().regex(SAFE_CODE),
    z.number().finite(),
  ]).optional(),
  ret: z.number().int().optional(),
});
const RECEIPT_SCHEMA = z.strictObject({
  status: z.enum(['accepted', 'failed', 'uncertain']),
  attemptId: z.string(),
  sendIndex: z.number().int().min(-1),
  type: z.enum(['text', 'image']),
  msgid: z.string(),
  error: ERROR_OUTPUT_SCHEMA.optional(),
});
const SEND_TEXT_SCHEMA = z.strictObject({
  session: z.string().regex(SESSION),
  content: z.string()
    .refine((value) => value.trim().length > 0, 'content must not be blank')
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES,
      `content must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes`,
    ),
});
const SEND_IMAGE_SCHEMA = z.strictObject({
  session: z.string().regex(SESSION),
  mediaRef: z.string().regex(/^(?:media|artifact):(?:0|[1-9]\d?)$/u),
});

export type IlinkToolName = 'send_text' | 'send_image';

export interface IlinkSendTextInput {
  readonly session: string;
  readonly content?: string;
  readonly mediaRef?: string;
}

interface IlinkToolError {
  readonly kind: string;
  readonly message: string;
  readonly code?: string | number;
  readonly ret?: number;
}

export interface IlinkToolReceipt {
  readonly status: 'accepted' | 'failed' | 'uncertain';
  readonly attemptId: string;
  readonly sendIndex: number;
  readonly type: 'text' | 'image';
  readonly msgid: string;
  readonly error?: IlinkToolError;
}

export interface IlinkToolExecutor {
  execute(
    tool: IlinkToolName,
    input: IlinkSendTextInput,
  ): Promise<IlinkToolReceipt>;
}

function safeErrorKind(
  status: 'failed' | 'uncertain',
  kind: string | undefined,
): IlinkToolErrorKind {
  if ((ERROR_KINDS as readonly string[]).includes(kind || '')) {
    return kind as IlinkToolErrorKind;
  }
  return status === 'uncertain' ? 'uncertain_result' : 'ilink_delivery_failed';
}

function safeCode(value: string | number | undefined): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return value && SAFE_CODE.test(value) ? value : undefined;
}

function safeReceipt(value: unknown): IlinkToolReceipt {
  const parsed = EXECUTOR_RECEIPT_SCHEMA.parse(value);
  const { error, ...base } = parsed;
  if (base.status === 'accepted') return base;
  const kind = safeErrorKind(base.status, error?.kind);
  const code = safeCode(error?.code);
  return {
    ...base,
    error: {
      kind,
      message: SAFE_ERROR_MESSAGES[kind],
      ...(code !== undefined ? { code } : {}),
      ...(error?.ret !== undefined ? { ret: error.ret } : {}),
    },
  };
}

function toolResult(receipt: IlinkToolReceipt): CallToolResult {
  const result: Record<string, unknown> = { ...receipt };
  return {
    ...(receipt.status === 'failed' ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolFailure(type: 'text' | 'image'): CallToolResult {
  return toolResult({
    status: 'failed',
    attemptId: '',
    sendIndex: -1,
    type,
    msgid: '',
    error: {
      kind: 'ilink_tool_error',
      message: SAFE_ERROR_MESSAGES.ilink_tool_error,
    },
  });
}

export function createIlinkMcpServer(executor: IlinkToolExecutor): McpServer {
  const server = new McpServer(
    { name: 'weixin-ilink-tools', version: KINTIO_VERSION },
    {
      instructions:
        'Execute iLink message delivery for the conversation bound by the trusted host. accepted records provider acceptance rather than confirmed client display. uncertain means the message may already have been accepted and must not be repeated merely because the outcome is unknown. reply_window_expired and reply_quota_exhausted are terminal for the current window: do not retry until a new user message opens a fresh window. A blocked channel cannot notify the user about its own block. Routing and credentials cannot be selected through these tools.',
    },
  );

  for (const definition of [
    {
      name: 'send_text' as const,
      type: 'text' as const,
      description: 'Send one text message through the bound iLink conversation.',
      inputSchema: SEND_TEXT_SCHEMA,
    },
    {
      name: 'send_image' as const,
      type: 'image' as const,
      description: 'Send one image exposed by the bound session media catalog.',
      inputSchema: SEND_IMAGE_SCHEMA,
    },
  ]) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: RECEIPT_SCHEMA,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input: IlinkSendTextInput) => {
        try {
          const receipt = safeReceipt(await executor.execute(
            definition.name,
            input,
          ));
          if (receipt.type !== definition.type) throw new Error('tool receipt type mismatch');
          return toolResult(receipt);
        } catch {
          return toolFailure(definition.type);
        }
      },
    );
  }
  return server;
}

export async function handleIlinkMcpRequest({
  request,
  executor,
}: {
  request: Request;
  executor: IlinkToolExecutor;
}): Promise<Response> {
  return handleMcpHttpRequest({
    request,
    createServer: () => createIlinkMcpServer(executor),
  });
}
