import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';

import { loadSharedRuntimeConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import * as agentModule from '../../src/services/codex-agent.ts';
import { CodexAppServer, type SpawnProcess } from '../../src/services/codex-app-server.ts';

for (const boundary of ['restricted', 'host'] as const) {
  test(`${boundary} Agent failure stops shared ingress and releases ownership for the next worker`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-agent-failure-'));
    const config = loadSharedRuntimeConfig({ root: directory, environment: {} });
    const servers = new Map<string, CodexAppServer>();
    const factory = vi.spyOn(agentModule, 'createCodexAppServer').mockImplementation((options) => {
      const server = new CodexAppServer({
        spawnProcess: (() => { throw new Error('synthetic spawn failure'); }) as SpawnProcess,
      });
      servers.set(options.agentAccess || 'restricted', server);
      return server;
    });
    const logger = { info() {}, warn() {}, error() {} };
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({ config, logger });
      await runtime.start();
      assert.equal(servers.size, 2);
      await assert.rejects(servers.get(boundary)!.initialize(), /synthetic spawn failure/u);
      assert.match((await runtime.failure).message, /initialization failed/u);
      await assert.rejects(runtime.start(), /runtime is stopping/u);
      await runtime.close();
      await assert.rejects(fs.stat(config.state.lockFile), { code: 'ENOENT' });

      // A fresh owner can open the same persisted state, without resetting data
      // or resurrecting the closed Agent adapter in the previous worker.
      runtime = await createRuntime({ config, logger });
      await runtime.start();
      assert.equal(servers.size, 2);
    } finally {
      await runtime?.close();
      factory.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
