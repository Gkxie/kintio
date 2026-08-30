import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'vitest';

import { createCodexAppServer } from '../../src/services/codex-agent.ts';
import {
  CodexAppServer,
  type SpawnProcess,
} from '../../src/services/codex-app-server.ts';

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

test('Codex Adapter inherits the host environment and overlays its scoped MCP capability', async (t) => {
  const environmentCanaries = {
    CODEX_SQLITE_HOME: '/private/codex-sqlite',
    CODEX_CA_CERTIFICATE: '/private/codex-ca.pem',
    http_proxy: 'http://proxy.example:8080',
    AGENT_HOST_CANARY: 'host-environment-canary',
  } as const;
  const mcpBearerToken = 'mcp-bearer-canary-value-1234567890';
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environmentCanaries)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.onTestFinished(() => {
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
    {
      spawnProcess,
      logger: { warn() {} },
      mcpUrl: 'https://robot.example/mcp',
      mcpBearerToken,
    },
  );
  t.onTestFinished(() => server.close());
  await server.initialize();

  assert.ok(captured);
  assert.equal(captured.command, '/mock/codex');
  assert.deepEqual(captured.argumentsList.slice(0, 2), ['app-server', '--stdio']);
  const serializedArguments = JSON.stringify(captured.argumentsList);
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.wechat_kf.url="https://robot.example/mcp"',
  ));
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.wechat_kf.bearer_token_env_var="KINTIO_MCP_BEARER_TOKEN"',
  ));
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.conversation_memory.url="https://robot.example/mcp/memory"',
  ));
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.conversation_memory.enabled_tools=["read_archived_thread"]',
  ));
  assert.ok(serializedArguments.includes('features={apps=false'));
  assert.ok(serializedArguments.includes('code_mode_host=true'));
  assert.ok(serializedArguments.includes('code_mode=false'));
  assert.ok(serializedArguments.includes('hooks=false'));
  assert.ok(serializedArguments.includes('unified_exec=false'));
  assert.ok(
    captured.argumentsList.includes('sandbox_workspace_write.network_access=false'),
  );
  assert.equal(captured.argumentsList.includes('--strict-config'), false);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.command'), false);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.args'), false);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.env_vars'), false);
  assert.equal(
    captured.environment.KINTIO_MCP_BEARER_TOKEN,
    mcpBearerToken,
  );
  for (const [name, value] of Object.entries(environmentCanaries)) {
    assert.equal(captured.environment[name], value, name);
  }
  for (const canary of Object.values(environmentCanaries)) {
    assert.equal(serializedArguments.includes(canary), false, canary);
  }

});

test('low-level Codex app-server follows normal child-process environment inheritance', async (t) => {
  const name = 'KINTIO_LOW_LEVEL_ENV_CANARY';
  const previous = process.env[name];
  process.env[name] = 'must-cross-process-boundary';
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  let childEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new FakeCodexProcess();
  const server = new CodexAppServer({
    spawnProcess(_command, _argumentsList, options) {
      childEnvironment = { ...options.env };
      return child;
    },
  });
  t.onTestFinished(() => server.close());
  await server.initialize();
  assert.equal(childEnvironment?.[name], 'must-cross-process-boundary');
});
