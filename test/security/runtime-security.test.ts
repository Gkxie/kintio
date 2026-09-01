import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'vitest';

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

test('Codex Adapter uses native environment inheritance without adding Agent configuration', async (t) => {
  const environmentCanaries = {
    CODEX_SQLITE_HOME: '/private/codex-sqlite',
    CODEX_CA_CERTIFICATE: '/private/codex-ca.pem',
    http_proxy: 'http://proxy.example:8080',
    AGENT_HOST_CANARY: 'host-environment-canary',
  } as const;
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
        explicitEnvironment: boolean;
      }
    | undefined;
  const child = new FakeCodexProcess();
  const spawnProcess: SpawnProcess = (command, argumentsList, options) => {
    captured = {
      command,
      argumentsList: [...argumentsList],
      explicitEnvironment: 'env' in options,
    };
    return child;
  };
  const server = createCodexAppServer({
    spawnProcess,
    logger: { warn() {} },
    mcpLaunches: {
      wechatKf: { command: '/node', args: ['/relay', '--route', 'wechat_kf'] },
      memory: { command: '/node', args: ['/relay', '--route', 'conversation_memory'] },
    },
  });
  t.onTestFinished(() => server.close());
  await server.initialize();

  assert.ok(captured);
  assert.equal(captured.command, 'codex');
  assert.deepEqual(captured.argumentsList.slice(0, 2), ['app-server', '--stdio']);
  const serializedArguments = JSON.stringify(captured.argumentsList);
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.wechat_kf.command="/node"',
  ));
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.conversation_memory.args=["/relay","--route","conversation_memory"]',
  ));
  assert.ok(captured.argumentsList.includes(
    'mcp_servers.conversation_memory.enabled_tools=["read_archived_thread"]',
  ));
  assert.ok(captured.argumentsList.includes('features.apps=false'));
  assert.ok(captured.argumentsList.includes('features.goals=false'));
  assert.ok(captured.argumentsList.includes('features.code_mode.enabled=false'));
  assert.ok(captured.argumentsList.includes('features.hooks=false'));
  assert.ok(captured.argumentsList.includes('features.multi_agent=false'));
  assert.ok(captured.argumentsList.includes('features.unified_exec=false'));
  assert.ok(
    captured.argumentsList.includes('sandbox_workspace_write.network_access=false'),
  );
  assert.equal(captured.argumentsList.includes('--strict-config'), false);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.command'), true);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.args'), true);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.url'), false);
  assert.equal(serializedArguments.includes('mcp_servers.wechat_kf.env_vars'), false);
  assert.equal(/operator|begin_login|login_status|cancel_login/u.test(serializedArguments), false);
  assert.equal(/bearer_token|model_provider|reasoning|web_search/iu.test(serializedArguments), false);
  assert.equal(captured.explicitEnvironment, false);
  for (const canary of Object.values(environmentCanaries)) {
    assert.equal(serializedArguments.includes(canary), false, canary);
  }
});
