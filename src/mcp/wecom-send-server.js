#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { WecomMediaGateway } from '../services/media-gateway.js';
import { WecomApiClient } from '../services/wecom-api.js';
import { SqliteToolJournal } from '../state/sqlite-tool-journal.js';
import { WecomSendTools } from '../tools/wecom-send-tools.js';

const RECEIPT_SCHEMA = {
  receipts: z.array(
    z.object({
      wecomMsgId: z.string(),
      sentType: z.string(),
      status: z.enum(['accepted', 'uncertain', 'staged']),
    }),
  ),
  remainingSends: z.number().int().min(0).max(5),
  deferred: z.boolean().optional(),
};

const MUTATING_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

function successResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: error?.code || 'tool_error',
          message: String(error?.message || 'Unknown send error'),
        }),
      },
    ],
  };
}

function registerSendTool(server, tools, name, config, handler) {
  server.registerTool(
    name,
    {
      ...config,
      outputSchema: RECEIPT_SCHEMA,
      annotations: MUTATING_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return successResult(await handler(tools, input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export function createWecomSendMcpServer({ tools }) {
  const server = new McpServer(
    { name: 'wechat-kf-send-tools', version: '1.0.0' },
    {
      instructions:
        'These tools deliver messages to exactly one pre-bound WeChat Customer Service conversation. During a steerable turn, successful calls are staged and committed only when the turn finishes; calls made before the latest customer steering input are superseded automatically. Never ask for or infer a recipient ID. Use at most five sends. Prefer one useful message except when the customer explicitly requests several locations: then send one verified location card per place without redundant text. Select images only from advertised media:N references. A receipt with status uncertain means a prior process may already have sent it: treat it as final and never retry.',
    },
  );

  registerSendTool(
    server,
    tools,
    'send_text',
    {
      description:
        'Send a concise text reply to the active customer. Use for explanations, clarification, or final fallback when no native format is more useful.',
      inputSchema: {
        content: z.string().min(1).describe('Customer-facing text'),
      },
    },
    (boundTools, input) => boundTools.sendText(input),
  );

  registerSendTool(
    server,
    tools,
    'send_location',
    {
      description:
        'Send a native WeChat location card. Use only with reliable coordinates; a map URL alone is not enough.',
      inputSchema: {
        name: z.string().describe('Place name'),
        address: z.string().describe('Full address'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      },
    },
    (boundTools, input) => boundTools.sendLocation(input),
  );

  registerSendTool(
    server,
    tools,
    'send_link',
    {
      description:
        'Send one native link card for a trustworthy public HTTP(S) destination. Prefer location or mini-program tools when those structures match better.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string(),
        url: z.string().url(),
      },
    },
    (boundTools, input) => boundTools.sendLink(input),
  );

  registerSendTool(
    server,
    tools,
    'send_miniprogram',
    {
      description:
        'Send a WeChat-internal mini-program deep-link card only when exact appId and pagePath are verified by the supplied public source URL.',
      inputSchema: {
        appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/),
        title: z.string().min(1),
        pagePath: z.string().min(1).max(1024),
        sourceUrl: z.string().url(),
      },
    },
    (boundTools, input) => boundTools.sendMiniProgram(input),
  );

  registerSendTool(
    server,
    tools,
    'send_image',
    {
      description:
        "Resend the customer's own recent image. Use only when explicitly requested and select an exact media:N image reference advertised in the turn.",
      inputSchema: {
        mediaRef: z.string().regex(/^media:(?:0|[1-9]\d?)$/),
      },
    },
    (boundTools, input) => boundTools.sendImage(input),
  );

  return server;
}

function requiredEnvironment(environment, name) {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`Missing required MCP environment variable: ${name}`);
  return value;
}

function parseMediaCatalog(value) {
  let parsed;

  try {
    parsed = JSON.parse(String(value || '[]'));
  } catch {
    throw new Error('WECOM_TOOL_MEDIA_CATALOG must be valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length > 10) {
    throw new Error('WECOM_TOOL_MEDIA_CATALOG must contain at most 10 items');
  }

  return parsed.map((item) => ({
    ref: String(item?.ref || ''),
    kind: String(item?.kind || ''),
    mediaId: String(item?.mediaId || ''),
    filename: String(item?.filename || ''),
  }));
}

export function createWecomSendToolsFromEnvironment(
  environment = process.env,
  { fetchImpl = globalThis.fetch } = {},
) {
  const apiClient = new WecomApiClient({
    corpId: requiredEnvironment(environment, 'WECOM_TOOL_CORP_ID'),
    kfSecret: requiredEnvironment(environment, 'WECOM_TOOL_KF_SECRET'),
    baseUrl:
      String(environment.WECOM_TOOL_API_BASE_URL || '').trim() || undefined,
    timeoutMs: Number(environment.WECOM_TOOL_API_TIMEOUT_MS || 10_000),
    fetchImpl,
  });
  const mediaGateway = new WecomMediaGateway({ apiClient });
  const idempotencyJournal = new SqliteToolJournal({
    filePath: requiredEnvironment(environment, 'WECOM_TOOL_JOURNAL_FILE'),
  });
  const mediaCatalogFile = String(
    environment.WECOM_TOOL_MEDIA_CATALOG_FILE || '',
  ).trim();
  const fallbackMediaCatalog = parseMediaCatalog(
    environment.WECOM_TOOL_MEDIA_CATALOG,
  );

  return new WecomSendTools({
    apiClient,
    mediaGateway,
    conversation: {
      openKfId: requiredEnvironment(environment, 'WECOM_TOOL_OPEN_KFID'),
      externalUserId: requiredEnvironment(
        environment,
        'WECOM_TOOL_EXTERNAL_USER_ID',
      ),
    },
    mediaCatalog: fallbackMediaCatalog,
    mediaCatalogProvider: mediaCatalogFile
      ? () => parseMediaCatalog(fs.readFileSync(mediaCatalogFile, 'utf8'))
      : undefined,
    deferSends: /^(1|true|yes|on)$/iu.test(
      String(environment.WECOM_TOOL_DEFER_SEND || ''),
    ),
    maxSends: Number(environment.WECOM_TOOL_MAX_SENDS || 5),
    idempotencyJournal,
    turnId: requiredEnvironment(environment, 'WECOM_TOOL_TURN_ID'),
  });
}

export async function runWecomSendMcpServer(environment = process.env) {
  const tools = createWecomSendToolsFromEnvironment(environment);
  const server = createWecomSendMcpServer({ tools });
  await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runWecomSendMcpServer().catch((error) => {
    console.error(`[wechat-kf-mcp] ${error.message}`);
    process.exitCode = 1;
  });
}
