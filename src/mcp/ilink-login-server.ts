import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IlinkLoginStatus } from '../ilink/login-store.ts';
import { KINTIO_VERSION } from '../version.ts';

const OFFER_ID = z.string().regex(/^qo_[A-Za-z0-9_-]{1,128}$/u);
const LOGIN_STATUS = z.enum([
  'waiting',
  'scanned',
  'confirmed',
  'expired',
  'failed',
  'cancelled',
  'already_connected',
  'verification_required',
  'unknown',
]);

export interface IlinkLoginOperator {
  begin(): Promise<{
    readonly offerId: string;
    readonly qrContent: string;
    readonly expiresAt: number;
  }>;
  status(offerId: string): {
    readonly status: IlinkLoginStatus;
  };
  cancel(offerId: string): boolean;
}

function textResult(
  text: string,
  structuredContent: Record<string, unknown>,
) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const code = /account limit reached/iu.test(message)
    ? 'account_limit_reached'
    : /already pending/iu.test(message)
      ? 'login_pending'
      : 'login_unavailable';
  const publicMessage = code === 'account_limit_reached'
    ? 'The iLink account limit has been reached.'
    : code === 'login_pending'
      ? 'An iLink terminal login is already pending.'
      : 'The iLink login operation is unavailable.';
  return {
    content: [{ type: 'text' as const, text: publicMessage }],
    isError: true,
  };
}

export function createIlinkLoginMcpServer(operator: IlinkLoginOperator): McpServer {
  const server = new McpServer(
    { name: 'kintio-ilink-login', version: KINTIO_VERSION },
    {
      instructions:
        'Private local operator tools for one iLink QR login. Never expose this server to an Agent.',
    },
  );

  server.registerTool(
    'begin_login',
    {
      description: 'Create one terminal iLink login offer.',
      inputSchema: {},
      outputSchema: {
        offerId: OFFER_ID,
        qrContent: z.string().min(1).max(2_048),
        expiresAt: z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (_input, { signal }) => {
      let offered: Awaited<ReturnType<IlinkLoginOperator['begin']>> | undefined;
      try {
        offered = await operator.begin();
        if (signal.aborted) {
          throw signal.reason;
        }
        return textResult('iLink login started.', offered);
      } catch (error: unknown) {
        if (offered && signal.aborted) operator.cancel(offered.offerId);
        return failure(error);
      }
    },
  );

  server.registerTool(
    'login_status',
    {
      description: 'Read one terminal iLink login status.',
      inputSchema: { offerId: OFFER_ID },
      outputSchema: {
        status: LOGIN_STATUS,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ offerId }) => {
      try {
        return textResult('iLink login status.', operator.status(offerId));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'cancel_login',
    {
      description: 'Cancel one terminal iLink login offer.',
      inputSchema: { offerId: OFFER_ID },
      outputSchema: { cancelled: z.boolean() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ offerId }) => {
      try {
        return textResult('iLink login cancelled.', {
          cancelled: operator.cancel(offerId),
        });
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  return server;
}
