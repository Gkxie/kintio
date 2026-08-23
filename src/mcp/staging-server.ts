#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import {
  type SendIntent,
  normalizeSendIntent,
} from '../domain/send-contract.js';

const STAGING_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const CANDIDATE_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({ type: z.literal('image'), mediaRef: z.string() }),
  z.object({
    type: z.literal('link'),
    title: z.string(),
    description: z.string(),
    url: z.string(),
  }),
  z.object({
    type: z.literal('miniprogram'),
    appId: z.string(),
    title: z.string(),
    pagePath: z.string(),
    sourceUrl: z.string(),
  }),
  z.object({
    type: z.literal('location'),
    name: z.string(),
    address: z.string(),
    latitude: z.number(),
    longitude: z.number(),
  }),
]);
const STAGED_OUTPUT_SCHEMA = Object.freeze({
  staged: z.literal(true),
  candidate: CANDIDATE_SCHEMA,
});

type ToolDefinition = {
  description: string;
  inputSchema: Record<string, z.ZodType>;
};

function success(intent: SendIntent): CallToolResult {
  const result = { staged: true, candidate: intent };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          staged: false,
          code: String(
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : 'invalid_send_intent',
          ),
          message:
            error instanceof Error ? error.message : 'Invalid send intent',
        }),
      },
    ],
  };
}

function register(
  server: McpServer,
  name: string,
  definition: ToolDefinition,
): void {
  server.registerTool(
    name,
    {
      ...definition,
      outputSchema: STAGED_OUTPUT_SCHEMA,
      annotations: STAGING_ANNOTATIONS,
    },
    async (input) => {
      try {
        return success(normalizeSendIntent(name, input, {
          allowUnboundMediaReference: true,
        }));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

export function createStagingMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'wechat-kf-staging-tools', version: '1.0.0' },
    {
      instructions:
        'These tools only validate and stage candidate WeChat replies. They never send, reserve a real WeChat quota, select a recipient, access credentials, use the network, or write a database. Calls before the latest customer steering message may be discarded by the host. The host validates the final post-steering batch, current media ownership, and five-message limit before delivery.',
    },
  );

  register(server, 'send_text', {
    description:
      'Stage concise customer-facing text. This does not consume the final five-message budget until the host selects the final post-steering batch.',
    inputSchema: { content: z.string().min(1) },
  });
  register(server, 'send_image', {
    description:
      'Stage a media:N reference. The trusted host verifies that the current customer actually owns the advertised reference.',
    inputSchema: {
      mediaRef: z.string().regex(/^media:(?:0|[1-9]\d?)$/u),
    },
  });
  register(server, 'send_link', {
    description: 'Stage one native link card for a trustworthy public URL.',
    inputSchema: {
      title: z.string().min(1),
      description: z.string(),
      url: z.string().url(),
    },
  });
  register(server, 'send_miniprogram', {
    description:
      'Stage a mini-program card only when its appId, pagePath, and public verification source are known exactly.',
    inputSchema: {
      appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
      title: z.string().min(1),
      pagePath: z.string().min(1).max(1024),
      sourceUrl: z.string().url(),
    },
  });
  register(server, 'send_location', {
    description: 'Stage a native location card with reliable coordinates.',
    inputSchema: {
      name: z.string().min(1),
      address: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    },
  });

  return server;
}

export async function runStagingMcpServer(): Promise<void> {
  const server = createStagingMcpServer();
  await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runStagingMcpServer().catch((error: unknown) => {
    console.error(
      `[wechat-kf-staging] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
