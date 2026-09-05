import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { loadConfig, loadIlinkRuntimeConfig } from '../../src/config.ts';
import { readIlinkAccountSnapshot } from '../../src/ilink/cli-accounts.ts';
import { findMcpDescriptorFile, operatorMcpInstanceKey } from '../../src/mcp/ipc-protocol.ts';
import { createRuntime } from '../../src/runtime.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';
import { KintioSupervisor } from '../../src/supervisor.ts';

const logger = { info() {}, warn() {}, error() {} };

describe('independent WeCom and iLink channels', () => {
  it('WeCom setup leaves existing iLink configuration and data byte-for-byte intact', async (t) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-channel-config-'));
    t.onTestFinished(() => fs.rm(profile, { recursive: true, force: true }));
    const ilinkHome = path.join(profile, '.kintio');
    await fs.mkdir(path.join(ilinkHome, 'data'), { recursive: true, mode: 0o700 });
    const existing = new Map([
      [path.join(ilinkHome, '.env'), 'ILINK_MAX_ACCOUNTS=7\n'],
      [path.join(ilinkHome, 'data/kintio.sqlite'), 'existing-account-data'],
      [path.join(ilinkHome, 'data/ilink-storage.key'), 'existing-encryption-key'],
    ]);
    for (const [file, content] of existing) await fs.writeFile(file, content, { mode: 0o600 });
    const errors: string[] = [];
    const overrides = {
      env: {}, cwd: profile, homeDirectory: profile, packageRoot: path.resolve('.'),
      stdout() {}, stderr: (message: string) => errors.push(message),
    };
    assert.equal(await runCli(['wecom', 'setup'], overrides), 0, errors.join(''));
    const configFile = path.join(ilinkHome, 'wecom/.env');
    const generated = await fs.readFile(configFile, 'utf8');
    assert.match(generated, /WECOM_CALLBACK_TOKEN=/u);
    assert.doesNotMatch(generated, /ILINK_/u);
    await fs.appendFile(configFile, '\nWECOM_AUTH_TRIGGER=keep-my-passphrase\n');
    const customized = await fs.readFile(configFile, 'utf8');
    assert.equal(await runCli(['wecom', 'setup'], overrides), 0);
    assert.equal(await runCli(['wecom', 'stop'], overrides), 0);
    assert.equal(await fs.readFile(configFile, 'utf8'), customized);
    for (const [file, content] of existing) assert.equal(await fs.readFile(file, 'utf8'), content);

    for (const command of ['setup', 'start', 'run', 'stop', 'restart', 'status', 'logs']) {
      assert.equal(await runCli([command], overrides), 1, command);
    }
  });

  for (const stopped of ['wecom', 'ilink'] as const) {
    it(`stopping ${stopped} leaves the other live runtime usable`, async (t) => {
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-channel-live-'));
      t.onTestFinished(() => fs.rm(profile, { recursive: true, force: true }));
      vi.spyOn(WecomSync.prototype, 'catchUp').mockResolvedValue(undefined);
      const wecomConfig = loadConfig({
        homeDirectory: profile,
        environment: {
          WECOM_CORP_ID: 'ww-isolation-test', WECOM_KF_SECRET: 'test-only-secret',
          ILINK_ENABLED: 'true', ILINK_STORAGE_KEY: 'invalid-but-unrelated',
        },
      });
      const ilinkConfig = loadIlinkRuntimeConfig({
        homeDirectory: profile,
        environment: { PORT: 'invalid-but-unrelated', WECOM_CORP_ID: 'incomplete' },
      });
      assert.equal(wecomConfig.state.databaseFile, path.join(profile, '.kintio/wecom/data/kintio.sqlite'));
      assert.equal(ilinkConfig.state.databaseFile, path.join(profile, '.kintio/data/kintio.sqlite'));
      assert.notEqual(wecomConfig.state.lockFile, ilinkConfig.state.lockFile);
      assert.notEqual(wecomConfig.codex.workingDirectory, ilinkConfig.codex.workingDirectory);
      await assert.rejects(createRuntime({
        config: { ...wecomConfig, ilink: ilinkConfig.ilink }, logger,
      }), /exactly one channel/u);

      const wecom = await createRuntime({ config: wecomConfig, logger });
      const supervisor = new KintioSupervisor({
        config: { ...wecomConfig, port: 0 }, runtime: wecom, logger,
      });
      t.onTestFinished(() => supervisor.close());
      const ilink = await createRuntime({ config: ilinkConfig, logger });
      t.onTestFinished(() => ilink.close());
      const [{ port }] = await Promise.all([supervisor.start(), ilink.start()]);
      assert.ok(wecom.messageProcessor);
      assert.equal(ilink.messageProcessor, null);
      await fs.access(wecomConfig.state.lockFile);
      await fs.access(ilinkConfig.state.lockFile);
      assert.throws(() => findMcpDescriptorFile(
        path.dirname(wecomConfig.state.lockFile), operatorMcpInstanceKey(wecomConfig.state.lockFile),
      ), /not running/u);
      await assert.rejects(fs.access(path.join(path.dirname(wecomConfig.state.databaseFile), 'ilink-storage.key')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(ilinkConfig.codex.workingDirectory, '.agents/skills/wechat-kf-reply-sop/SKILL.md')), { code: 'ENOENT' });

      if (stopped === 'wecom') {
        await supervisor.close();
        await fs.access(ilinkConfig.state.lockFile);
        const snapshot = await readIlinkAccountSnapshot({
          config: ilinkConfig, packageRoot: path.resolve('.'), signal: new AbortController().signal,
        });
        assert.equal(snapshot.mode, 'runtime');
        assert.deepEqual(snapshot.accounts, []);
      } else {
        await ilink.close();
        await fs.access(wecomConfig.state.lockFile);
        const response = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2_000) });
        assert.equal(await response.text(), 'hello world');
        assert.equal(supervisor.state, 'running');
      }
    });
  }
});
