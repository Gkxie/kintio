import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;

export interface FakeWecomRequest {
  method: string;
  pathname: string;
  searchParams: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: unknown;
}

export interface FakeWecomResponse {
  status?: number;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer | Uint8Array;
  json?: unknown;
  destroy?: boolean;
}

export type FakeWecomStep =
  | FakeWecomResponse
  | ((
      request: FakeWecomRequest,
    ) => FakeWecomResponse | Promise<FakeWecomResponse>);

export interface FakeWecomServerOptions {
  accessToken?: string;
  bodyLimit?: number;
}

export interface FakeWecomServer {
  baseUrl: string;
  enqueue(method: string, pathname: string, ...steps: FakeWecomStep[]): void;
  readonly requests: FakeWecomRequest[];
  requestsFor(pathname: string, method?: string): FakeWecomRequest[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new Error('fake request body exceeded its limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function sendResponse(
  response: ServerResponse,
  specification: FakeWecomResponse = {},
): void {
  if (specification.destroy === true) {
    response.destroy();
    return;
  }

  const status = Number(specification.status ?? 200);
  const headers: OutgoingHttpHeaders = { ...(specification.headers ?? {}) };
  let body: Buffer;
  if (specification.json !== undefined) {
    body = Buffer.from(JSON.stringify(specification.json));
    headers['Content-Type'] ??= 'application/json';
  } else if (Buffer.isBuffer(specification.body)) {
    body = specification.body;
  } else if (specification.body instanceof Uint8Array) {
    body = Buffer.from(specification.body);
  } else {
    body = Buffer.from(String(specification.body ?? ''));
  }

  response.writeHead(status, headers);
  response.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createFakeWecomServer(
  testContext: TestContext,
  {
    accessToken = 'fake-access-token',
    bodyLimit = DEFAULT_BODY_LIMIT,
  }: FakeWecomServerOptions = {},
): Promise<FakeWecomServer> {
  const scripts = new Map<string, FakeWecomStep[]>();
  const requests: FakeWecomRequest[] = [];

  function enqueue(
    method: string,
    pathname: string,
    ...steps: FakeWecomStep[]
  ): void {
    const key = `${method.toUpperCase()} ${pathname}`;
    const queue = scripts.get(key) ?? [];
    queue.push(...steps);
    scripts.set(key, queue);
  }

  const server: Server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fake-wecom.test');
      const body = await readBody(request, bodyLimit);
      let json: unknown;
      try {
        json = body.length ? JSON.parse(body.toString('utf8')) : undefined;
      } catch {
        json = undefined;
      }
      const record: FakeWecomRequest = {
        method: (request.method ?? 'GET').toUpperCase(),
        pathname: url.pathname,
        searchParams: Object.fromEntries(url.searchParams),
        headers: { ...request.headers },
        body,
        json,
      };
      requests.push(record);

      if (
        record.pathname === '/cgi-bin/gettoken' &&
        !scripts.has('GET /cgi-bin/gettoken')
      ) {
        sendResponse(response, {
          json: {
            errcode: 0,
            errmsg: 'ok',
            access_token: accessToken,
            expires_in: 7200,
          },
        });
        return;
      }

      const key = `${record.method} ${record.pathname}`;
      const queue = scripts.get(key) ?? [];
      const step = queue.shift();
      if (step === undefined) {
        sendResponse(response, {
          status: 500,
          json: {
            errcode: -1,
            errmsg: `unexpected fake WeChat request: ${key}`,
          },
        });
        return;
      }

      const specification =
        typeof step === 'function' ? await step(record) : step;
      sendResponse(response, specification);
    } catch (error) {
      if (!response.headersSent) {
        sendResponse(response, {
          status: 500,
          json: { errcode: -1, errmsg: errorMessage(error) },
        });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fake WeChat server did not bind a TCP address');
  }
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  async function close(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  testContext.after(() => close());
  return {
    baseUrl,
    enqueue,
    requests,
    requestsFor(pathname: string, method?: string): FakeWecomRequest[] {
      return requests.filter(
        (request) =>
          request.pathname === pathname &&
          (method === undefined || request.method === method.toUpperCase()),
      );
    },
    close,
  };
}
