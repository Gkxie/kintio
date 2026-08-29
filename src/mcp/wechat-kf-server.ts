import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import { KINTIO_VERSION } from '../version.ts';
import { handleMcpHttpRequest } from './http.ts';
import {
  WechatKfToolExecutor,
  type WechatToolReceipt,
} from './wechat-kf-executor.ts';

const TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const SEND_TYPES = [
  'text',
  'image',
  'link',
  'miniprogram',
  'location',
] as const;
type SendType = (typeof SEND_TYPES)[number];
const ATTEMPT_ID = /^sa_[A-Za-z0-9_-]+$/u;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,128}$/u;
const ERROR_KINDS = [
  'sensitive_content',
  'wechat_delivery_failed',
  'uncertain_result',
  'invalid_agent_session',
  'closed_agent_session',
  'expired_agent_session',
  'stale_agent_session',
  'send_budget_exceeded',
  'wrong_channel',
  'invalid_media_reference',
  'media_preparation_failed',
  'ilink_unavailable',
  'invalid_send_intent',
  'invalid_media_catalog',
  'unsafe_media_catalog',
  'unsupported_send_type',
  'wechat_tool_error',
] as const;
type WechatToolErrorKind = (typeof ERROR_KINDS)[number];
const SAFE_ERROR_MESSAGES: Readonly<Record<WechatToolErrorKind, string>> = {
  sensitive_content:
    'The channel rejected this message as potentially sensitive content. Do not send unlawful content; if the request is legitimate, revise the wording before deciding whether to try once more.',
  wechat_delivery_failed: 'The channel rejected this message.',
  uncertain_result:
    'The delivery result is uncertain and the message may already have been sent. Do not retry merely because the outcome is unknown.',
  invalid_agent_session: 'The conversation capability is invalid. Wait for the host runtime to provide a new session.',
  closed_agent_session: 'The conversation session is closed. Wait for the host runtime to provide a new session.',
  expired_agent_session: 'The conversation session expired. Wait for the host runtime to provide a new session.',
  stale_agent_session: 'This conversation direction is stale. Continue from the participant\'s latest message.',
  send_budget_exceeded: 'The reply budget for this conversation is exhausted. Stop sending.',
  wrong_channel: 'This session does not belong to the WeChat KF adapter.',
  invalid_media_reference: 'This conversation cannot use the requested image reference.',
  media_preparation_failed: 'Media preparation failed before any message was sent.',
  ilink_unavailable: 'An independent iLink Bot conversation cannot be established right now.',
  invalid_send_intent: 'The message parameters do not satisfy the adapter requirements.',
  invalid_media_catalog: 'The conversation media catalog is invalid.',
  unsafe_media_catalog: 'The conversation media catalog contains unsafe fields.',
  unsupported_send_type: 'This adapter does not support the requested message type.',
  wechat_tool_error: 'The adapter tool could not execute this operation.',
};

const EXECUTOR_ERROR_SCHEMA = z.strictObject({
  kind: z.string(),
  message: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
  failType: z.number().int().optional(),
});
const EXECUTOR_RECEIPT_SCHEMA = z.strictObject({
  status: z.enum(['accepted', 'failed', 'uncertain']),
  attemptId: z.string().regex(ATTEMPT_ID),
  sendIndex: z.number().int().min(0).max(999),
  type: z.enum(SEND_TYPES),
  msgid: z.string().max(512),
  error: EXECUTOR_ERROR_SCHEMA.optional(),
});
const ERROR_OUTPUT_SCHEMA = z.strictObject({
  kind: z.enum(ERROR_KINDS),
  message: z.string(),
  code: z.union([
    z.string().regex(SAFE_CODE),
    z.number().finite(),
  ]).optional(),
  failType: z.number().int().nonnegative().optional(),
});
const RECEIPT_SCHEMA = z.strictObject({
  status: z.enum(['accepted', 'failed', 'uncertain']),
  attemptId: z.string().max(128),
  sendIndex: z.number().int().min(-1).max(999),
  type: z.enum(SEND_TYPES),
  msgid: z.string().max(512),
  error: ERROR_OUTPUT_SCHEMA.optional(),
});

type JsonRecord = Record<string, unknown>;
type ToolDefinition = {
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
};
type ToolExecutor = Pick<WechatKfToolExecutor, 'execute'>;

function response(result: JsonRecord, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function safeErrorKind(
  status: 'failed' | 'uncertain',
  kind: string | undefined,
  failType = 0,
): WechatToolErrorKind {
  if (status === 'failed' && failType === 13) return 'sensitive_content';
  if ((ERROR_KINDS as readonly string[]).includes(kind || '')) {
    return kind as WechatToolErrorKind;
  }
  return status === 'uncertain' ? 'uncertain_result' : 'wechat_delivery_failed';
}

function safeCode(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

function safeReceipt(value: unknown): WechatToolReceipt {
  const parsed = EXECUTOR_RECEIPT_SCHEMA.parse(value);
  const { error, ...base } = parsed;
  if (base.status === 'accepted') return base;
  const failType = Number.isInteger(error?.failType) && Number(error?.failType) >= 0
    ? Number(error?.failType)
    : 0;
  const kind = safeErrorKind(base.status, error?.kind, failType);
  const code = safeCode(error?.code);
  return {
    ...base,
    error: {
      kind,
      message: SAFE_ERROR_MESSAGES[kind],
      ...(code !== undefined ? { code } : {}),
      ...(failType ? { failType } : {}),
    },
  };
}

function toolFailure(error: unknown, type: SendType): CallToolResult {
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
  const kind = (ERROR_KINDS as readonly string[]).includes(errorCode)
    ? errorCode as WechatToolErrorKind
    : 'wechat_tool_error';
  const result = {
    status: 'failed',
    attemptId: '',
    sendIndex: -1,
    type,
    msgid: '',
    error: { kind, message: SAFE_ERROR_MESSAGES[kind] },
  };
  return response(result, true);
}

function toolResult(result: WechatToolReceipt): CallToolResult {
  const safe = safeReceipt(result);
  return response({ ...safe }, safe.status === 'failed');
}

function toolType(name: string): SendType {
  if (name === 'offer_weixin_bot_channel' || name === 'send_image') return 'image';
  const type = name.replace(/^send_/u, '');
  return (SEND_TYPES as readonly string[]).includes(type)
    ? type as SendType
    : 'text';
}

function register(
  server: McpServer,
  executor: ToolExecutor,
  name: string,
  definition: ToolDefinition,
): void {
  server.registerTool(
    name,
    {
      ...definition,
      outputSchema: RECEIPT_SCHEMA,
      annotations: TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolResult(await executor.execute(name, input as JsonRecord));
      } catch (error: unknown) {
        return toolFailure(error, toolType(name));
      }
    },
  );
}

const SESSION = z.string().regex(/^ws_[A-Za-z0-9_-]{32}$/u);
const TOOL_DEFINITIONS: readonly [string, string, Record<string, z.ZodType>][] = [
  [
    'offer_weixin_bot_channel',
    'Offer an optional independent Weixin iLink Bot channel by sending a login QR image to the bound conversation. Use only after the user clearly asks to switch or establish that channel.',
    {},
  ],
  ['send_text', 'Send one WeChat text message.', { content: z.string().min(1) }],
  ['send_image', 'Send one available image referenced by media:N or artifact:N.', {
    mediaRef: z.string().regex(/^(?:media|artifact):(?:0|[1-9]\d?)$/u),
  }],
  ['send_link', 'Send one native WeChat link card.', {
    title: z.string().min(1), description: z.string(), url: z.string().url(),
  }],
  ['send_miniprogram', 'Send one verified WeChat mini-program card.', {
    appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
    title: z.string().min(1), pagePath: z.string().min(1).max(1024),
    sourceUrl: z.string().url(),
  }],
  ['send_location', 'Send one native WeChat location card.', {
    name: z.string().min(1), address: z.string().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }],
];

export function createWechatKfMcpServer(executor: ToolExecutor): McpServer {
  const server = new McpServer(
    { name: 'wechat-kf-tools', version: KINTIO_VERSION },
    {
      instructions:
        'These tools execute real WeChat KF channel API calls for the bound conversation. accepted means the API accepted the request, not confirmed client delivery. uncertain means the message may already have been sent and must not be repeated merely because the outcome is unknown. The server never selects another recipient or retries automatically.',
    },
  );

  for (const [name, description, inputSchema] of TOOL_DEFINITIONS) {
    register(server, executor, name, {
      description,
      inputSchema: { session: SESSION, ...inputSchema },
    });
  }
  return server;
}

export async function handleWechatKfMcpRequest({
  request,
  executor,
  bearerToken,
}: {
  request: Request;
  executor: ToolExecutor;
  bearerToken: string;
}): Promise<Response> {
  return handleMcpHttpRequest({
    request,
    bearerToken,
    createServer: () => createWechatKfMcpServer(executor),
  });
}
