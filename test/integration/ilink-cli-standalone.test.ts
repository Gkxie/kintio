import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { test, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { IlinkSecretBox, readOrCreateIlinkStorageKey } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { acquireSingleInstanceLock } from '../../src/runtime/single-instance-lock.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import { requestControl } from '../../src/runtime/daemon-protocol.ts';
import { createIlinkCliRuntime } from '../support/ilink-cli-runtime.ts';
import { startTestChild } from '../support/child-process.ts';

function confirmed(name: string) {
  return {
    status: 'confirmed', bot_token: `synthetic-${name}-token`,
    ilink_bot_id: `${name}@im.bot`, ilink_user_id: `${name}@im.wechat`,
    baseurl: 'https://ilinkai.weixin.qq.com/',
  };
}

function terminalEntry(fixture: Awaited<ReturnType<typeof createIlinkCliRuntime>>): string {
  const entry = path.join(fixture.directory, 'terminal.mjs');
  fs.writeFileSync(entry, [
    `import { runCli } from ${JSON.stringify(pathToFileURL(path.resolve('src/cli.ts')).href)};`,
    `const code = await runCli(['ilink', 'login', '--home', ${JSON.stringify(fixture.home)}], {`,
    `  env: {}, packageRoot: ${JSON.stringify(fixture.packageRoot)},`,
    `  stdinIsTTY: true, stdoutIsTTY: true, stdoutColumns: 200,`,
    `  stdout(text) { if (text.includes('Waiting for scan')) process.send?.('ready'); },`,
    `});`,
    `process.send?.({type: 'result', code}); process.exitCode = code; process.disconnect();`,
  ].join('\n'));
  return entry;
}

test('standalone iLink login starts its private owner without setup and releases it after enrollment', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  fixture.setReplies({ default: confirmed('standalone') });
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], fixture.overrides), 0, fixture.stderr.join(''));
  await fixture.waitForStopped();
  assert.equal(fixture.launches(), 1);
  assert.equal(fs.existsSync(path.join(fixture.home, '.env')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.lock')), false);
  assert.deepEqual(new Set(fixture.requests().map(({ path }) => path)), new Set([
    '/ilink/bot/get_bot_qrcode', '/ilink/bot/get_qrcode_status',
  ]));
  const persistence = new StatePersistence({ filePath: path.join(fixture.home, 'data/kintio.sqlite') });
  t.onTestFinished(() => persistence.close());
  const accountKey = createIlinkAccountKey('standalone@im.bot');
  const stored = persistence.createIlinkStore().getAccountWithSecret(accountKey)!;
  assert.equal(stored.account.agentAccess, 'host');
  assert.equal(stored.account.runtimeEnabled, false);
  const box = new IlinkSecretBox(readOrCreateIlinkStorageKey(path.join(fixture.home, 'data/ilink-storage.key'), { allowCreate: false }));
  assert.equal(box.open(stored.secret.sealedBotToken, {
    secretKind: 'bot_token', accountId: accountKey,
    peerId: stored.account.ownerPeerId, generation: stored.account.generation,
  }), 'synthetic-standalone-token');
  assert.doesNotMatch(fixture.stdout.join(''), /synthetic-standalone-token/u);
});

test('two simultaneous CLI logins share one writer and preserve the other pending offer', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const firstOutput: string[] = [];
  const secondOutput: string[] = [];
  const first = runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides, stdout: (text) => firstOutput.push(text),
  });
  const second = runCli(['ilink', 'login', '--home', fixture.home], {
    ...fixture.overrides, stdout: (text) => secondOutput.push(text),
  });
  await fixture.eventually(() => firstOutput.join('').includes('Waiting for scan') && secondOutput.join('').includes('Waiting for scan'));
  assert.equal(fixture.launches(), 1);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/lifecycle.lock')), false);
  fixture.setReplies({ 'synthetic-qr-1': confirmed('first') });
  assert.equal(await Promise.race([first, second]), 0, fixture.stderr.join(''));
  assert.equal([firstOutput, secondOutput].filter((output) => output.join('').includes('login succeeded')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.lock')), true);
  assert.equal((await requestControl(fixture.home, 'stop-if-idle')).idle, false);
  assert.equal(await runCli(['ilink', 'start', '--home', fixture.home, '--account', 'first@im.bot'], fixture.overrides), 0, fixture.stderr.join(''));
  assert.equal(await runCli(['ilink', 'stop', '--home', fixture.home, '--account', 'first@im.bot'], fixture.overrides), 0, fixture.stderr.join(''));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const wecomDirectory = path.join(fixture.home, 'wecom');
  fs.mkdirSync(wecomDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(wecomDirectory, '.env'), `PORT=${address.port}\nCODEX_ENABLED=false\n`, { mode: 0o600 });
  assert.equal(await runCli(['wecom', 'start', '--home', fixture.home], fixture.overrides), 0, fixture.stderr.join(''));
  assert.equal(await runCli(['wecom', 'stop', '--home', fixture.home], fixture.overrides), 0, fixture.stderr.join(''));
  assert.equal(fixture.launches(), 1);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.lock')), true);
  fixture.setReplies({ 'synthetic-qr-2': confirmed('second') });
  assert.deepEqual(await Promise.all([first, second]), [0, 0], fixture.stderr.join(''));
  await fixture.waitForStopped();
  const persistence = new StatePersistence({ filePath: path.join(fixture.home, 'data/kintio.sqlite') });
  t.onTestFinished(() => persistence.close());
  const accounts = persistence.createIlinkStore().listActiveAccounts();
  assert.deepEqual(accounts.map((account) => account.providerAccountId).sort(), ['first@im.bot', 'second@im.bot']);
  assert.ok(accounts.every((account) => !account.runtimeEnabled));
});

test('closing one terminal process cancels its QR without stopping another terminal login', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const entry = terminalEntry(fixture);
  const first = startTestChild(t, entry, { timeoutMs: 10_000 });
  await first.waitForMessage('ready');
  const second = startTestChild(t, entry, { timeoutMs: 10_000 });
  await second.waitForMessage('ready');
  await first.stop('SIGTERM');
  assert.equal(second.child.exitCode, null);
  assert.equal((await requestControl(fixture.home, 'stop-if-idle')).idle, false);
  fixture.setReplies({ 'synthetic-qr-2': confirmed('surviving-terminal') });
  assert.deepEqual(await second.waitForMessage('result'), { type: 'result', code: 0 });
  assert.equal((await second.waitForExit()).code, 0);
  await fixture.waitForStopped();
  const persistence = new StatePersistence({ filePath: path.join(fixture.home, 'data/kintio.sqlite') });
  assert.deepEqual(persistence.createIlinkStore().listActiveAccounts().map((account) => account.providerAccountId), ['surviving-terminal@im.bot']);
  persistence.close();
});

test.for(['SIGTERM', 'SIGKILL'] as const)('closing the last terminal with %s releases the idle worker after polling settles', async (signal, t) => {
  const fixture = await createIlinkCliRuntime(t);
  const terminal = startTestChild(t, terminalEntry(fixture), { timeoutMs: 10_000 });
  await terminal.waitForMessage('ready');
  await terminal.stop(signal);
  await fixture.waitForStopped();
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.lock')), false);
});

test('a locked instance without operator control never launches another writer', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const lock = acquireSingleInstanceLock({ filePath: path.join(fixture.home, 'data/kintio.lock') });
  t.onTestFinished(() => { lock.release(); });
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], fixture.overrides), 1);
  assert.equal(fixture.launches(), 0);
  assert.deepEqual(fixture.requests(), []);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.sqlite')), false);
});

test('a missing storage key blocks the shared login owner but not offline account deletion', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const databaseFile = path.join(fixture.home, 'data/kintio.sqlite');
  const persistence = new StatePersistence({ filePath: databaseFile });
  const box = new IlinkSecretBox(Buffer.alloc(32, 61).toString('base64url'));
  persistence.createIlinkStore().registerAccount({
    providerAccountId: 'lost-key@im.bot', ownerPeerId: 'lost-key@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: box.seal('synthetic-lost-token', {
      secretKind: 'bot_token', accountId: createIlinkAccountKey('lost-key@im.bot'),
      peerId: 'lost-key@im.wechat', generation: 1,
    }),
    agentAccess: 'host', now: Date.now(),
  });
  persistence.close();
  assert.equal(await runCli(['ilink', 'login', '--home', fixture.home], fixture.overrides), 1);
  await fixture.waitForStopped();
  assert.deepEqual(fixture.requests(), []);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/ilink-storage.key')), false);
  assert.equal(await runCli(['ilink', 'delete', '--home', fixture.home, '--account', 'lost-key@im.bot', '--yes'], fixture.overrides), 0, fixture.stderr.join(''));
  const inspected = new StatePersistence({ filePath: databaseFile });
  assert.deepEqual(inspected.createIlinkStore().listActiveAccounts(), []);
  inspected.close();
});

test('offline account checkpoint failure closes SQLite before releasing the instance lock', async (t) => {
  const fixture = await createIlinkCliRuntime(t);
  const databaseFile = path.join(fixture.home, 'data/kintio.sqlite');
  new StatePersistence({ filePath: databaseFile }).close();
  vi.spyOn(SqliteStore.prototype, 'checkpoint').mockImplementationOnce(() => {
    throw new Error('simulated checkpoint failure');
  });
  assert.equal(await runCli(['ilink', 'list', '--home', fixture.home], fixture.overrides), 1);
  assert.equal(fs.existsSync(path.join(fixture.home, 'data/kintio.lock')), false);
  new StatePersistence({ filePath: databaseFile }).close();
});
