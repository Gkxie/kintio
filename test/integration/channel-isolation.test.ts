import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { loadConfig, loadSharedRuntimeConfig } from '../../src/config.ts';
import { readIlinkAccountSnapshot } from '../../src/ilink/cli-accounts.ts';
import { openIlinkOperatorControl, controlWecom, restartIlinkListeners } from '../../src/ilink/cli-login.ts';
import { IlinkClient } from '../../src/ilink/protocol/client.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import net from 'node:net';
import { createRuntime } from '../../src/runtime.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';

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


  it('shares one database and recovery pass while listeners start, stop, restart, and restore independently', async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-shared-runtime-'));
    t.onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await fs.mkdir(path.join(home, 'wecom'), { mode: 0o700 });
    await fs.writeFile(path.join(home, 'wecom/.env'), [
      'PORT=' + port,
      'WECOM_CALLBACK_TOKEN=TestCallback',
      'WECOM_ENCODING_AES_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      'WECOM_CORP_ID=ww-test', 'WECOM_KF_SECRET=synthetic-secret',
    ].join('\n'), { mode: 0o600 });
    const key = Buffer.alloc(32, 4).toString('base64url');
    await fs.writeFile(path.join(home, '.env'), 'ILINK_STORAGE_KEY=' + key, { mode: 0o600 });
    const config = loadSharedRuntimeConfig({ root: home, environment: {} });
    const wecom = loadConfig({ root: home, environment: {} });
    assert.equal(wecom.state.databaseFile, config.state.databaseFile);
    assert.equal(wecom.state.lockFile, config.state.lockFile);
    assert.notEqual(wecom.codex.workingDirectory, config.codex.workingDirectory);
    const persistence = new StatePersistence({ filePath: config.state.databaseFile });
    const accountKey = createIlinkAccountKey('shared-test@im.bot');
    persistence.createIlinkStore().registerAccount({
      providerAccountId: 'shared-test@im.bot', ownerPeerId: 'peer-test',
      baseUrl: 'https://ilinkai.weixin.qq.com/', agentAccess: 'host', now: Date.now(),
      encryptedBotToken: new IlinkSecretBox(key).seal('synthetic-token', {
        secretKind: 'bot_token', accountId: accountKey, peerId: 'peer-test', generation: 1,
      }),
    });
    persistence.close();
    vi.spyOn(WecomSync.prototype, 'catchUp').mockResolvedValue(undefined);
    vi.spyOn(IlinkClient.prototype, 'getUpdates').mockImplementation(async (_cursor, { signal } = {}) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted synthetic poll');
    });
    const recovery = vi.spyOn(SqliteStore.prototype, 'recoverStartup');
    const stopRequested = vi.fn();
    let runtime = await createRuntime({ config, logger, onStopRequested: stopRequested });
    t.onTestFinished(() => runtime.close());
    await runtime.start();
    assert.equal(recovery.mock.calls.length, 1);
    assert.deepEqual(await controlWecom(config, path.resolve('.'), 'status'), { running: false });
    await assert.rejects(fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(500) }));
    const operator = await openIlinkOperatorControl(config, path.resolve('.'), AbortSignal.timeout(10_000));
    t.onTestFinished(() => operator.close());
    const [account] = await operator.listAccounts();
    assert.ok(account);
    const revision = { generation: account.generation, incarnation: account.incarnation };
    await operator.setAccountRuntime(account.accountKey, true, revision);
    const ilinkImage = path.join(config.codex.imageTempDirectory, 'kintio-image-active');
    const wecomOrphan = path.join(wecom.codex.imageTempDirectory, 'kintio-image-orphan');
    await fs.mkdir(ilinkImage, { mode: 0o700 });
    await fs.mkdir(wecomOrphan, { recursive: true, mode: 0o700 });
    // Repeated/concurrent starts attach to the same singleton; no second bind or recovery.
    await Promise.all([controlWecom(config, path.resolve('.'), 'start'), controlWecom(config, path.resolve('.'), 'start')]);
    await fs.access(ilinkImage);
    await fs.access(wecom.codex.imageTempDirectory);
    await assert.rejects(fs.access(wecomOrphan), { code: 'ENOENT' });
    assert.equal(await (await fetch('http://127.0.0.1:' + port + '/', { headers: { connection: 'close' } })).text(), 'hello world');
    assert.equal(recovery.mock.calls.length, 1);
    await controlWecom(config, path.resolve('.'), 'stop');
    assert.equal(stopRequested.mock.calls.length, 0);
    assert.equal((await operator.listAccounts())[0]?.runtimeEnabled, true);
    await controlWecom(config, path.resolve('.'), 'start');
    await restartIlinkListeners(config, path.resolve('.'));
    assert.equal(recovery.mock.calls.length, 1);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/', { headers: { connection: 'close' } })).status, 200);
    const errors: string[] = [];
    const cli = { env: {}, packageRoot: path.resolve('.'), stdout() {}, stderr: (message: string) => errors.push(message) };
    // Foreground runtimes expose the same operator control; CLI commands must not spawn a second worker.
    assert.equal(await runCli(['wecom', 'start', '--home', home], cli), 0, errors.join(''));
    assert.equal(await runCli(['ilink', 'restart', '--home', home], cli), 0, errors.join(''));
    assert.equal(recovery.mock.calls.length, 1);
    await operator.setAccountRuntime(account.accountKey, false, revision);
    assert.equal(stopRequested.mock.calls.length, 0);
    await operator.close();
    // Whole-runtime shutdown preserves the desired state, unlike channel stop.
    await runtime.close();
    runtime = await createRuntime({ config, logger, onStopRequested: stopRequested });
    await runtime.start();
    assert.equal(recovery.mock.calls.length, 2);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/', { headers: { connection: 'close' } })).status, 200);
    const snapshot = await readIlinkAccountSnapshot({ config, packageRoot: path.resolve('.'), signal: AbortSignal.timeout(5_000) });
    assert.equal(snapshot.accounts[0]?.runtimeEnabled, false);
    await assert.rejects(fs.access(path.join(config.codex.workingDirectory, '.agents/skills/wechat-kf-reply-sop/SKILL.md')));
    await controlWecom(config, path.resolve('.'), 'stop');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopRequested.mock.calls.length, 1);
  });
});
