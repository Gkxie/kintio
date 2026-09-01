import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IlinkLoginStatus } from '../ilink/login-store.ts';
import { KINTIO_VERSION } from '../version.ts';

const OFFER_ID = z.string().regex(/^qo_[A-Za-z0-9_-]{1,128}$/u);
const ACCOUNT_KEY = z.string().regex(/^ia_[0-9a-f]{40}$/u);
const OPERATOR_ACCOUNT = z.object({
  accountKey: ACCOUNT_KEY,
  providerAccountId: z.string().min(1).max(512),
  runtimeEnabled: z.boolean(),
});
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
  begin(signal?: AbortSignal): Promise<{
    readonly offerId: string;
    readonly qrContent: string;
    readonly expiresAt: number;
  }>;
  status(offerId: string): {
    readonly status: IlinkLoginStatus;
  };
  cancel(offerId: string): boolean;
  listAccounts(): readonly z.infer<typeof OPERATOR_ACCOUNT>[];
  setAccountRuntime(accountKey: string, enabled: boolean): Promise<{
    readonly account: z.infer<typeof OPERATOR_ACCOUNT>;
    readonly runningCount: number;
  }>;
  deleteAccount(accountKey: string): Promise<{
    readonly account: z.infer<typeof OPERATOR_ACCOUNT>;
    readonly runningCount: number;
  }>;
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

function failure(error: unknown, operation: 'login' | 'account' = 'login') {
  const message = error instanceof Error ? error.message : '';
  const code = /account limit reached/iu.test(message)
    ? 'account_limit_reached'
    : /already pending/iu.test(message)
      ? 'login_pending'
      : operation === 'account'
        ? 'account_operation_unavailable'
        : 'login_unavailable';
  const publicMessage = code === 'account_limit_reached'
    ? 'The iLink account limit has been reached.'
    : code === 'login_pending'
      ? 'An iLink terminal login is already pending.'
      : code === 'account_operation_unavailable'
        ? 'The iLink account operation is unavailable.'
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
        'Private local operator tools for iLink enrollment and account lifecycle. Never expose this server to an Agent.',
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
        offered = await operator.begin(signal);
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

  server.registerTool(
    'list_accounts',
    {
      description: 'List enrolled iLink accounts without credentials.',
      inputSchema: {},
      outputSchema: { accounts: z.array(OPERATOR_ACCOUNT).max(1_000) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => {
      try {
        return textResult('iLink accounts.', { accounts: operator.listAccounts() });
      } catch (error: unknown) {
        return failure(error, 'account');
      }
    },
  );

  for (const [name, enabled] of [
    ['start_account', true],
    ['stop_account', false],
  ] as const) {
    server.registerTool(
      name,
      {
        description: `${enabled ? 'Start' : 'Stop'} one enrolled iLink account.`,
        inputSchema: { accountKey: ACCOUNT_KEY },
        outputSchema: {
          account: OPERATOR_ACCOUNT,
          runningCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      async ({ accountKey }) => {
        try {
          const result = await operator.setAccountRuntime(accountKey, enabled);
          return textResult(`iLink account ${enabled ? 'started' : 'stopped'}.`, result);
        } catch (error: unknown) {
          return failure(error, 'account');
        }
      },
    );
  }

  server.registerTool(
    'delete_account',
    {
      description: 'Permanently delete one iLink account and all Kintio data scoped to it.',
      inputSchema: { accountKey: ACCOUNT_KEY },
      outputSchema: {
        account: OPERATOR_ACCOUNT,
        runningCount: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
    },
    async ({ accountKey }) => {
      try {
        const result = await operator.deleteAccount(accountKey);
        return textResult('iLink account and its Kintio data were deleted.', result);
      } catch (error: unknown) {
        return failure(error, 'account');
      }
    },
  );

  return server;
}
