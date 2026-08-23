import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { createConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import { createCodexAppServer } from '../../src/services/codex-agent.ts';
import type { SpawnProcess } from '../../src/services/codex-app-server.ts';

type RpcMessage = Record<string, unknown>;

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  #buffer = '';

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#buffer += chunk.toString();
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line) {
            const message = JSON.parse(line) as RpcMessage;
            if (message.method === 'initialize') {
              this.stdout.write(
                `${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`,
              );
            }
          }
          newline = this.#buffer.indexOf('\n');
        }
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('[S03][SEC01][SEC02][SEC05] host Codex CLI and trusted staging MCP receive no business secrets', async (t) => {
  const environmentCanaries = {
    WECOM_CORP_ID: 'corp-canary',
    WECOM_KF_SECRET: 'secret-canary',
    WECOM_TOOL_OPEN_KFID: 'wk-canary',
    WECOM_TOOL_EXTERNAL_USER_ID: 'wm-canary',
    WECOM_DB_FILE: '/private/database-canary.sqlite',
    WECOM_TOOL_MEDIA_CATALOG_FILE: '/private/media-catalog-canary.json',
    WECOM_TOOL_DEFER_SEND: 'defer-switch-canary',
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environmentCanaries)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let captured:
    | {
        command: string;
        argumentsList: readonly string[];
        environment: NodeJS.ProcessEnv;
      }
    | undefined;
  const child = new FakeCodexProcess();
  const spawnProcess: SpawnProcess = (command, argumentsList, options) => {
    captured = {
      command,
      argumentsList: [...argumentsList],
      environment: { ...options.env },
    };
    return child;
  };
  const server = createCodexAppServer(
    {
      pathOverride: '/mock/codex',
      webSearchMode: 'live',
      workingDirectory: '/mock/workspace',
    },
    { spawnProcess, logger: { warn() {} } },
  );
  t.after(() => server.close());
  await server.initialize();

  assert.ok(captured);
  assert.equal(captured.command, '/mock/codex');
  assert.deepEqual(captured.argumentsList.slice(0, 2), ['app-server', '--stdio']);
  const serializedArguments = JSON.stringify(captured.argumentsList);
  assert.ok(
    captured.argumentsList.includes(
      'mcp_servers.wechat_kf.env_vars=[]',
    ),
  );
  assert.ok(serializedArguments.includes('features={apps=false'));
  assert.ok(serializedArguments.includes('code_mode_host=true'));
  assert.ok(serializedArguments.includes('code_mode=false'));
  assert.ok(serializedArguments.includes('hooks=false'));
  assert.ok(serializedArguments.includes('unified_exec=false'));
  assert.ok(
    captured.argumentsList.includes('sandbox_workspace_write.network_access=false'),
  );
  assert.equal(captured.argumentsList.includes('--strict-config'), false);
  assert.ok(serializedArguments.includes('mcp_servers.wechat_kf.command'));
  for (const forbiddenName of Object.keys(environmentCanaries)) {
    assert.equal(forbiddenName in captured.environment, false, forbiddenName);
  }
  assert.equal(captured.environment.HOME, process.env.HOME);
  assert.equal(captured.environment.CODEX_HOME, process.env.CODEX_HOME);
  for (const canary of Object.values(environmentCanaries)) {
    assert.equal(serializedArguments.includes(canary), false, canary);
  }

  const mcpArgsOverride = captured.argumentsList.find((argument) =>
    argument.startsWith('mcp_servers.wechat_kf.args='),
  );
  assert.ok(mcpArgsOverride);
  const nested = JSON.parse(
    mcpArgsOverride.slice(mcpArgsOverride.indexOf('=') + 1),
  ) as string[];
  assert.ok(nested.some((argument) => /staging-server\.(?:js|ts)$/u.test(argument)));
  const commandOverride = captured.argumentsList.find((argument) =>
    argument.startsWith('mcp_servers.wechat_kf.command='),
  );
  assert.ok(commandOverride);
  assert.equal(
    JSON.parse(commandOverride.slice(commandOverride.indexOf('=') + 1)),
    process.execPath,
  );
});

test('[SEC03] root startup rejects a wildcard customer allowlist before creating runtime state', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => 0,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    else Reflect.deleteProperty(process, 'getuid');
  });

  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'CallbackToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-root-test',
    WECOM_KF_SECRET: 'root-test-secret',
    WECOM_ALLOWED_USER_IDS: '*',
  });
  assert.throws(
    () =>
      createRuntime({
        config,
        logger: { info() {}, warn() {}, error() {} },
      }),
    /Refusing WECOM_ALLOWED_USER_IDS=\* while running as root/u,
  );
});
