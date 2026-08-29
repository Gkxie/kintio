import { createHash, timingSafeEqual } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

function authorized(request: Request, bearerToken: string): boolean {
  if (!bearerToken) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(
    digest(request.headers.get('authorization') || ''),
    digest(`Bearer ${bearerToken}`),
  );
}

export async function handleMcpHttpRequest({
  request,
  bearerToken,
  createServer,
}: {
  readonly request: Request;
  readonly bearerToken: string;
  readonly createServer: () => McpServer;
}): Promise<Response> {
  if (!authorized(request, bearerToken)) {
    return Response.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport();
  await createServer().connect(transport);
  return transport.handleRequest(request);
}
