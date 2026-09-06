import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { readDaemonRecord } from '../../src/runtime/daemon-protocol.ts';
import * as daemonProtocol from '../../src/runtime/daemon-protocol.ts';
import { RuntimeOperatorClient } from '../../src/runtime/operator-client.ts';
import { IlinkSecretBox, readOrCreateIlinkStorageKey } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { createIlinkCliRuntime } from '../support/ilink-cli-runtime.ts';

test('failure to attach the login control rolls back only the newly started empty daemon', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides,
    async ilinkConnect() { throw new Error('synthetic control attach failure'); },
  }), 1);
  assert.match(fixture.stderr.join(''), /synthetic control attach failure/u);
  assert.equal(Boolean(readDaemonRecord(fixture.home)), false);
  assert.deepEqual(fixture.requests(), []);
});

test('failed login attachment cannot roll back a new owner used by another terminal', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  let other: RuntimeOperatorClient | undefined;
  let offerId = '';
  t.onTestFinished(() => other?.close());
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides,
    async ilinkConnect(config, packageRoot) {
      other = await RuntimeOperatorClient.connect(config, packageRoot);
      offerId = (await other.begin(new AbortController().signal)).offerId;
      throw new Error('synthetic control attach failure');
    },
  }), 1);
  assert.ok(readDaemonRecord(fixture.home));
  assert.ok(other);
  assert.equal((await other.status(offerId, new AbortController().signal)).status, 'waiting');
  await other.close();
  await fixture.waitForStopped();
});

test('failed login attachment preserves a channel another operator enabled', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const persistence = new StatePersistence({ filePath: path.join(fixture.home, 'data/kintio.sqlite') });
  const accountKey = createIlinkAccountKey('other-channel@im.bot');
  const box = new IlinkSecretBox(readOrCreateIlinkStorageKey(path.join(fixture.home, 'data/ilink-storage.key'), { allowCreate: true }));
  persistence.createIlinkStore().registerAccount({
    providerAccountId: 'other-channel@im.bot', ownerPeerId: 'other-owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    now: Date.now(),
    encryptedBotToken: box.seal('synthetic-other-token', {
      secretKind: 'bot_token', accountId: accountKey, peerId: 'other-owner@im.wechat', generation: 1,
    }),
  });
  persistence.close();
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides,
    async ilinkConnect(config, packageRoot) {
      const other = await RuntimeOperatorClient.connect(config, packageRoot);
      try {
        const account = (await other.listAccounts())[0]!;
        await other.setAccountRuntime(account.accountKey, true, account);
      } finally { await other.close(); }
      throw new Error('synthetic control attach failure');
    },
  }), 1);
  assert.ok(readDaemonRecord(fixture.home));
  assert.ok(fixture.requests().some((request) => request.path.endsWith('/notifystart')));
});

test('rollback rechecks unused state after another terminal starts an idle channel at the stop gate', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const persistence = new StatePersistence({ filePath: path.join(fixture.home, 'data/kintio.sqlite') });
  const accountKey = createIlinkAccountKey('concurrent-channel@im.bot');
  const box = new IlinkSecretBox(readOrCreateIlinkStorageKey(path.join(fixture.home, 'data/ilink-storage.key'), { allowCreate: true }));
  persistence.createIlinkStore().registerAccount({
    providerAccountId: 'concurrent-channel@im.bot', ownerPeerId: 'concurrent-owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com/', now: Date.now(),
    encryptedBotToken: box.seal('synthetic-concurrent-token', {
      secretKind: 'bot_token', accountId: accountKey, peerId: 'concurrent-owner@im.wechat', generation: 1,
    }),
  });
  persistence.close();
  let observer: RuntimeOperatorClient | undefined;
  let activated = false;
  t.onTestFinished(() => observer?.close());
  const request = daemonProtocol.requestControl;
  vi.spyOn(daemonProtocol, 'requestControl').mockImplementation(async (...args) => {
    if (String(args[1]).startsWith('stop-if-') && !activated) {
      assert.ok(observer);
      const account = (await observer.listAccounts())[0]!;
      await observer.setAccountRuntime(account.accountKey, true, account);
      activated = true;
      await observer.close();
    }
    return request(...args);
  });
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides,
    async ilinkConnect(config, packageRoot) {
      observer = await RuntimeOperatorClient.connect(config, packageRoot);
      throw new Error('synthetic control attach failure');
    },
  }), 1);
  assert.equal(activated, true);
  assert.equal(Boolean(readDaemonRecord(fixture.home)), true);
  assert.equal((await daemonProtocol.requestControl(fixture.home, 'stop-if-unused')).idle, false);
  assert.equal((await daemonProtocol.requestControl(fixture.home, 'stop-if-idle')).idle, true);
  await fixture.waitForStopped();
});

test('waiting for the retired login owner preserves a newly published daemon identity', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const request = daemonProtocol.requestControl;
  const replacementRunId = 'replacement_daemon';
  t.onTestFinished(() => {
    if (readDaemonRecord(fixture.home)?.runId === replacementRunId) {
      fs.unlinkSync(daemonProtocol.daemonRecordPath(fixture.home));
    }
  });
  vi.spyOn(daemonProtocol, 'requestControl').mockImplementation(async (...args) => {
    if (args[1] !== 'stop-if-unused') return request(...args);
    const previous = readDaemonRecord(fixture.home)!;
    const result = await request(...args);
    await fixture.waitForStopped();
    daemonProtocol.writeDaemonRecord(fixture.home, { ...previous, runId: replacementRunId });
    let time = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => { time += 200_000; return time; });
    return result;
  });
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides,
    async ilinkConnect() { throw new Error('synthetic control attach failure'); },
  }), 1);
  assert.equal(readDaemonRecord(fixture.home)?.runId, replacementRunId);
  assert.doesNotMatch(fixture.stderr.join(''), /or release its new runtime/u);
});
