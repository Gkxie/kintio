import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

const MAX_REQUEST_BYTES = 256 * 1024;

function localRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    request.headers.get('host') === url.host && !request.headers.has('origin');
}

async function boundedRequest(request: Request): Promise<Request | Response> {
  if (request.method !== 'POST' || !request.body) return request;
  const declared = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'request too large' }, { status: 413 });
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return Response.json({ error: 'request too large' }, { status: 413 });
    }
    chunks.push(value);
  }
  return new Request(request, { body: Buffer.concat(chunks, size) });
}

export async function handleMcpHttpRequest({
  request,
  createServer,
}: {
  readonly request: Request;
  readonly createServer: () => McpServer;
}): Promise<Response> {
  if (!localRequest(request)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const bounded = await boundedRequest(request);
  if (bounded instanceof Response) return bounded;
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await createServer().connect(transport);
  return transport.handleRequest(bounded);
}
