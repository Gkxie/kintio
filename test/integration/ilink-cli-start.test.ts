import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { loadIlinkRuntimeConfig } from '../../src/config.ts';
import { startIlinkCliRuntime } from '../../src/ilink/cli-start.ts';

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for iLink CLI runtime');
}

test('iLink start owns polling and Agent lifecycle without setup or Hono', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-start-'));
  t.onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = loadIlinkRuntimeConfig({ environment: {}, root: home });
  assert.equal('wecom' in config, false);
  assert.equal('port' in config, false);
  const controller = new AbortController();
  const output: string[] = [];
  const running = startIlinkCliRuntime({
    config,
    signal: controller.signal,
    stdout: (text) => output.push(text),
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(async () => {
    controller.abort();
    await running.catch(() => undefined);
  });
  await eventually(() => output.join('').includes('iLink runtime is active'));
  assert.equal(fs.existsSync(config.state.lockFile), true);
  controller.abort();
  assert.equal(await running, 130);
  assert.equal(fs.existsSync(config.state.lockFile), false);
  assert.equal(fs.existsSync(config.state.databaseFile), true);
});
