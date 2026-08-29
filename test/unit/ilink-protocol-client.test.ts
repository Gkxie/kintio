import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  DEFAULT_ILINK_BASE_URL,
  IlinkClient,
  IlinkProtocolError,
  ilinkRedirectHostToBaseUrl,
  normalizeIlinkBaseUrl,
} from '../../src/ilink/protocol/client.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';

interface FetchCall {
  url: string;
  options: RequestInit;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestJson(call: FetchCall | undefined): unknown {
  assert.ok(call);
  const body = call.options.body;
  if (typeof body !== 'string') assert.fail('request body must be JSON text');
  return JSON.parse(body);
}

function protocolErrorKind(error: unknown, kind: string): boolean {
  return error instanceof IlinkProtocolError && error.kind === kind;
}

test('getUpdates sends the 2.4.6 wire contract with token auth and AbortSignal', async () => {
  const calls: FetchCall[] = [];
  const client = new IlinkClient({
    token: ' bot-token ',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ret: 0,
        msgs: [{ message_id: 7, from_user_id: 'user@im.wechat' }],
        get_updates_buf: 'cursor-two',
        longpolling_timeout_ms: 34_000,
      });
    },
  });

  const result = await client.getUpdates({ get_updates_buf: 'cursor-one' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${DEFAULT_ILINK_BASE_URL}ilink/bot/getupdates`);
  assert.equal(calls[0]?.options.method, 'POST');
  assert.equal(calls[0]?.options.redirect, 'error');
  assert.ok(calls[0]?.options.signal instanceof AbortSignal);
  const headers = new Headers(calls[0]?.options.headers);
  assert.equal(headers.get('authorization'), 'Bearer bot-token');
  assert.equal(headers.get('authorizationtype'), 'ilink_bot_token');
  assert.equal(headers.get('ilink-app-id'), 'bot');
  assert.equal(headers.get('ilink-app-clientversion'), '132102');
  assert.match(
    Buffer.from(headers.get('x-wechat-uin') ?? '', 'base64').toString('utf8'),
    /^\d+$/u,
  );
  assert.deepEqual(requestJson(calls[0]), {
    get_updates_buf: 'cursor-one',
    base_info: {
      channel_version: '2.4.6',
      bot_agent: 'WechatBot/1.0.0',
    },
  });
  assert.equal(result.get_updates_buf, 'cursor-two');
  assert.equal(result.msgs?.[0]?.message_id, 7);
});

test('account lifecycle notifications use the authenticated 2.4.6 wire contract', async () => {
  const calls: FetchCall[] = [];
  const responses = [
    jsonResponse({ ret: 0 }),
    jsonResponse({ ret: 17, errmsg: 'stop rejected' }),
  ];
  const client = new IlinkClient({
    token: 'bot-token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });

  assert.equal((await client.notifyStart()).ret, 0);
  await assert.rejects(
    () => client.notifyStop(),
    (error) =>
      error instanceof IlinkProtocolError &&
      error.kind === 'business' &&
      error.operation === 'notifyStop' &&
      error.ret === 17 &&
      error.message.includes('stop rejected'),
  );

  assert.deepEqual(calls.map((call) => call.url), [
    `${DEFAULT_ILINK_BASE_URL}ilink/bot/msg/notifystart`,
    `${DEFAULT_ILINK_BASE_URL}ilink/bot/msg/notifystop`,
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'POST');
    assert.equal(
      new Headers(call.options.headers).get('authorization'),
      'Bearer bot-token',
    );
    assert.deepEqual(requestJson(call), {
      base_info: {
        channel_version: '2.4.6',
        bot_agent: 'WechatBot/1.0.0',
      },
    });
  }
});

test('sendMessage preserves the caller message and validates business ret', async () => {
  const calls: FetchCall[] = [];
  const responses = [
    jsonResponse({ ret: 0, errmsg: 'ok' }),
    jsonResponse({ ret: 23, errmsg: 'rejected' }),
  ];
  const client = new IlinkClient({
    token: 'bot-token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });
  const request = {
    msg: {
      to_user_id: 'user@im.wechat',
      client_id: 'stable-client-id',
      message_type: IlinkMessageType.BOT,
      message_state: IlinkMessageState.FINISH,
      context_token: 'context-token',
      item_list: [{
        type: IlinkMessageItemType.TEXT,
        text_item: { text: '你好' },
      }],
    },
  };

  const accepted = await client.sendMessage(request);
  assert.equal(accepted.ret, 0);
  assert.deepEqual(requestJson(calls[0]), {
    ...request,
    base_info: {
      channel_version: '2.4.6',
      bot_agent: 'WechatBot/1.0.0',
    },
  });
  await assert.rejects(
    () => client.sendMessage(request),
    (error) =>
      error instanceof IlinkProtocolError &&
      error.kind === 'business' &&
      error.operation === 'sendMessage' &&
      error.ret === 23 &&
      error.message.includes('rejected'),
  );
});

test('getUploadUrl uses authenticated protocol metadata and validates its response', async () => {
  const calls: FetchCall[] = [];
  const client = new IlinkClient({
    token: 'bot-token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ret: 0,
        upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=x',
      });
    },
  });
  const result = await client.getUploadUrl({
    filekey: 'a'.repeat(32),
    media_type: 1,
    to_user_id: 'owner@im.wechat',
    rawsize: 8,
    rawfilemd5: 'b'.repeat(32),
    filesize: 16,
    no_need_thumb: true,
    aeskey: 'c'.repeat(32),
  });
  assert.match(result.upload_full_url || '', /novac2c/u);
  assert.equal(calls[0]?.url, `${DEFAULT_ILINK_BASE_URL}ilink/bot/getuploadurl`);
  assert.equal(new Headers(calls[0]?.options.headers).get('authorization'), 'Bearer bot-token');
  assert.equal((requestJson(calls[0]) as { base_info?: unknown }).base_info !== undefined, true);
});

test('QR create/status use the official endpoints without exposing bot auth', async () => {
  const calls: FetchCall[] = [];
  const client = new IlinkClient({
    token: 'must-not-be-sent-to-qr-status',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? jsonResponse({ qrcode: 'qr-secret', qrcode_img_content: 'https://qr.example/payload' })
        : jsonResponse({
            status: 'scaned_but_redirect',
            redirect_host: 'shard.ilink.weixin.qq.com',
          });
    },
  });

  const created = await client.createQr({
    bot_type: '3',
    local_token_list: [' old-token-one ', 'old-token-two'],
  });
  const status = await client.getQrStatus({
    qrcode: created.qrcode,
    verify_code: '123456',
  });

  const createUrl = new URL(calls[0]?.url ?? '');
  assert.equal(createUrl.pathname, '/ilink/bot/get_bot_qrcode');
  assert.equal(createUrl.searchParams.get('bot_type'), '3');
  assert.deepEqual(requestJson(calls[0]), {
    local_token_list: ['old-token-one', 'old-token-two'],
  });
  const createHeaders = new Headers(calls[0]?.options.headers);
  assert.equal(createHeaders.get('authorization'), null);
  assert.equal(createHeaders.get('authorizationtype'), 'ilink_bot_token');

  const statusUrl = new URL(calls[1]?.url ?? '');
  assert.equal(statusUrl.pathname, '/ilink/bot/get_qrcode_status');
  assert.equal(statusUrl.searchParams.get('qrcode'), 'qr-secret');
  assert.equal(statusUrl.searchParams.get('verify_code'), '123456');
  assert.equal(calls[1]?.options.method, 'GET');
  const statusHeaders = new Headers(calls[1]?.options.headers);
  assert.equal(statusHeaders.get('authorization'), null);
  assert.equal(statusHeaders.get('authorizationtype'), null);
  assert.equal(statusHeaders.get('x-wechat-uin'), null);
  assert.equal(status.redirect_host, 'shard.ilink.weixin.qq.com');
  assert.equal(
    client.resolveRedirectBaseUrl(status.redirect_host),
    'https://shard.ilink.weixin.qq.com/',
  );
});

test('QR confirmed baseurl is validated and normalized', async () => {
  const client = new IlinkClient({
    fetchImpl: async () => jsonResponse({
      status: 'confirmed',
      bot_token: 'new-token',
      ilink_bot_id: 'bot@im.bot',
      ilink_user_id: 'scanner@im.wechat',
      baseurl: 'https://REGION.ILINK.WEIXIN.QQ.COM',
    }),
  });

  const result = await client.getQrStatus({ qrcode: 'qr-secret' });

  assert.equal(result.baseurl, 'https://region.ilink.weixin.qq.com/');
  assert.equal(result.ilink_user_id, 'scanner@im.wechat');
});

describe('business and response validation', () => {
  test('getUpdates validates errcode as well as ret', async () => {
    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => jsonResponse({ ret: 0, errcode: -14, errmsg: 'stale token' }),
    });

    await assert.rejects(
      () => client.getUpdates(),
      (error) =>
        error instanceof IlinkProtocolError &&
        error.kind === 'business' &&
        error.ret === 0 &&
        error.errcode === -14,
    );
  });

  test('QR methods validate business errors and required fields', async () => {
    const responses = [
      jsonResponse({ ret: 9, errmsg: 'create denied' }),
      jsonResponse({ qrcode: '', qrcode_img_content: 'payload' }),
      jsonResponse({ status: 'future_status' }),
      jsonResponse({ status: 'confirmed', ilink_bot_id: 7 }),
    ];
    const client = new IlinkClient({
      fetchImpl: async () => {
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    });

    await assert.rejects(() => client.createQr(), (error) => protocolErrorKind(error, 'business'));
    await assert.rejects(
      () => client.createQr(),
      (error) => protocolErrorKind(error, 'invalid_response'),
    );
    await assert.rejects(
      () => client.getQrStatus({ qrcode: 'qr' }),
      (error) => protocolErrorKind(error, 'invalid_response'),
    );
    await assert.rejects(
      () => client.getQrStatus({ qrcode: 'qr' }),
      (error) => protocolErrorKind(error, 'invalid_response'),
    );
  });

  test('HTTP, JSON, object-shape, and transport failures remain typed', async () => {
    const results: Array<Response | Error> = [
      new Response('unavailable', { status: 503 }),
      new Response('not json', { status: 200 }),
      jsonResponse([]),
      new Error('network down'),
    ];
    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => {
        const result = results.shift();
        assert.ok(result);
        if (result instanceof Error) throw result;
        return result;
      },
    });

    for (const kind of ['http', 'invalid_json', 'invalid_response', 'transport']) {
      await assert.rejects(
        () => client.getUpdates(),
        (error) => protocolErrorKind(error, kind),
      );
    }
  });

  test('protocol responses are bounded before JSON parsing', async () => {
    const responses = [
      new Response('{}', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }),
      new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    ];
    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => responses.shift()!,
    });
    for (let index = 0; index < 2; index += 1) {
      await assert.rejects(
        () => client.getUpdates(),
        (error) => protocolErrorKind(error, 'invalid_response'),
      );
    }
  });

  test('getUpdates rejects malformed cursor, messages, timeout, and business-code types', async () => {
    const responses = [
      { ret: '0' },
      { ret: 0, msgs: {} },
      { ret: 0, get_updates_buf: 12 },
      { ret: 0, longpolling_timeout_ms: -1 },
    ];
    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => jsonResponse(responses.shift()),
    });

    for (let index = 0; index < 4; index += 1) {
      await assert.rejects(
        () => client.getUpdates(),
        (error) => protocolErrorKind(error, 'invalid_response'),
      );
    }
  });
});

describe('AbortSignal behavior', () => {
  test('a pre-aborted request does not invoke fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({ ret: 0 });
      },
    });

    await assert.rejects(
      () => client.getUpdates({}, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(fetchCalls, 0);
  });

  test('external cancellation and request timeout abort an in-flight fetch', async () => {
    const abortingFetch: typeof fetch = async (_url, options = {}) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = options.signal;
        assert.ok(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const client = new IlinkClient({ token: 'bot-token', fetchImpl: abortingFetch });
    const controller = new AbortController();
    const externalRequest = client.getUpdates({}, { signal: controller.signal });
    controller.abort();

    await assert.rejects(
      () => externalRequest,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    await assert.rejects(
      () => client.getUpdates({}, { timeoutMs: 5 }),
      (error: unknown) => error instanceof Error && error.name === 'TimeoutError',
    );
  });
});

describe('URL policy and request validation', () => {
  test('accepts only allowlisted public HTTPS origins and protocol redirects', () => {
    assert.equal(
      normalizeIlinkBaseUrl('https://ilinkai.weixin.qq.com'),
      DEFAULT_ILINK_BASE_URL,
    );
    assert.equal(
      ilinkRedirectHostToBaseUrl('edge.weixin.qq.com'),
      'https://edge.weixin.qq.com/',
    );
    assert.equal(
      normalizeIlinkBaseUrl('https://api.example.com', ['example.com']),
      'https://api.example.com/',
    );

    for (const baseUrl of [
      'http://ilinkai.weixin.qq.com',
      'https://user:pass@ilinkai.weixin.qq.com',
      'https://ilinkai.weixin.qq.com:8443',
      'https://ilinkai.weixin.qq.com/path',
      'https://ilinkai.weixin.qq.com/?query=1',
      'https://ilinkai.weixin.qq.com/#fragment',
      'https://127.0.0.1',
      'https://weixin.qq.com.evil.example',
      ' https://ilinkai.weixin.qq.com',
      'not a URL',
    ]) {
      assert.throws(
        () => normalizeIlinkBaseUrl(baseUrl),
        (error) => protocolErrorKind(error, 'unsafe_url'),
      );
    }

    for (const redirectHost of [
      '127.0.0.1',
      'weixin.qq.com.evil.example',
      'weixin.qq.com:443',
      'weixin.qq.com/path',
      'user@weixin.qq.com',
      '.weixin.qq.com',
      'weixin.qq.com.',
      'bad..weixin.qq.com',
      '',
    ]) {
      assert.throws(
        () => ilinkRedirectHostToBaseUrl(redirectHost),
        (error) => protocolErrorKind(error, 'unsafe_url'),
      );
    }
  });

  test('rejects an unsafe redirect_host returned by QR status', async () => {
    const client = new IlinkClient({
      fetchImpl: async () => jsonResponse({
        status: 'scaned_but_redirect',
        redirect_host: 'metadata.internal',
      }),
    });

    await assert.rejects(
      () => client.getQrStatus({ qrcode: 'qr' }),
      (error) => protocolErrorKind(error, 'unsafe_url'),
    );
  });

  test('rejects missing tokens and malformed QR/request configuration before fetch', async () => {
    let fetchCalls = 0;
    const client = new IlinkClient({
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({ ret: 0 });
      },
    });

    await assert.rejects(() => client.getUpdates(), (error) => protocolErrorKind(error, 'configuration'));
    await assert.rejects(
      () => client.sendMessage({ msg: undefined as never }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.createQr({ bot_type: 'bot' }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.createQr({ local_token_list: Array.from({ length: 11 }, () => 'token') }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.createQr({ local_token_list: [' '] }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.getQrStatus({ qrcode: '' }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.getQrStatus({ qrcode: 'q', verify_code: '' }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    assert.equal(fetchCalls, 0);
  });

  test('validates client configuration and per-request baseUrl/timeout overrides', async () => {
    for (const construct of [
      () => new IlinkClient({ timeoutMs: 0 }),
      () => new IlinkClient({ longPollTimeoutMs: Number.NaN }),
      () => new IlinkClient({ allowedHostSuffixes: [] }),
      () => new IlinkClient({ allowedHostSuffixes: ['localhost'] }),
      () => new IlinkClient({ appId: '' }),
      () => new IlinkClient({ appClientVersion: -1 }),
      () => new IlinkClient({ fetchImpl: 7 as never }),
    ]) {
      assert.throws(construct, (error) => protocolErrorKind(error, 'configuration'));
    }

    const client = new IlinkClient({
      token: 'bot-token',
      fetchImpl: async () => jsonResponse({ ret: 0, msgs: [] }),
    });
    await assert.rejects(
      () => client.getUpdates({}, { timeoutMs: 0 }),
      (error) => protocolErrorKind(error, 'configuration'),
    );
    await assert.rejects(
      () => client.getUpdates({}, { baseUrl: 'https://example.com' }),
      (error) => protocolErrorKind(error, 'unsafe_url'),
    );
  });
});
