import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';

import {
  SingleInstanceLockError,
  acquireSingleInstanceLock,
  type LockOwner,
} from '../../src/runtime/single-instance-lock.ts';

function lockPath(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-lock-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'wecom.lock');
}

function readOwner(filePath: string): LockOwner {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LockOwner;
}

test('O_EXCL lock rejects a second live process and releases by owner token', (t) => {
  const filePath = lockPath(t);
  const alive = (pid: number): boolean => pid === 111;
  const first = acquireSingleInstanceLock({
    filePath,
    pid: 111,
    clock: () => 1000,
    isProcessAlive: alive,
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  assert.throws(
    () =>
      acquireSingleInstanceLock({
        filePath,
        pid: 222,
        clock: () => 2000,
        isProcessAlive: alive,
      }),
    (error) =>
      error instanceof SingleInstanceLockError &&
      error.code === 'instance_locked' &&
      error.owner?.pid === 111,
  );
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  const second = acquireSingleInstanceLock({
    filePath,
    pid: 222,
    isProcessAlive: () => false,
  });
  assert.equal(second.owner.pid, 222);
  second.release();
});

test('dead PID is recovered under an exclusive recovery guard', (t) => {
  const filePath = lockPath(t);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ pid: 111, token: 'stale-token', createdAt: 1 }),
    { mode: 0o600 },
  );
  const lock = acquireSingleInstanceLock({
    filePath,
    pid: 222,
    clock: () => 2,
    isProcessAlive: () => false,
  });
  const owner = readOwner(filePath);
  assert.equal(owner.pid, 222);
  assert.notEqual(owner.token, 'stale-token');
  assert.equal(fs.existsSync(`${filePath}.recovery`), false);
  lock.release();
});

test('stale PID cannot be recovered while SQLite reports an active owner', (t) => {
  const filePath = lockPath(t);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ pid: 111, token: 'stale-token', createdAt: 1 }),
    { mode: 0o600 },
  );
  assert.throws(
    () =>
      acquireSingleInstanceLock({
        filePath,
        pid: 222,
        isProcessAlive: () => false,
        hasActiveDatabaseOwner: () => true,
      }),
    (error) =>
      error instanceof SingleInstanceLockError &&
      error.code === 'database_owner_active',
  );
  assert.equal(readOwner(filePath).pid, 111);
});

test('release never unlinks a lock replaced by another owner', (t) => {
  const filePath = lockPath(t);
  const lock = acquireSingleInstanceLock({
    filePath,
    pid: 111,
    isProcessAlive: () => false,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ pid: 222, token: 'replacement', createdAt: 2 }),
    { mode: 0o600 },
  );
  assert.equal(lock.release(), false);
  assert.equal(readOwner(filePath).token, 'replacement');
});

test('an abandoned partial recovery guard expires before stale recovery', (t) => {
  const filePath = lockPath(t);
  const recoveryPath = `${filePath}.recovery`;
  fs.writeFileSync(
    filePath,
    JSON.stringify({ pid: 111, token: 'stale-token', createdAt: 1 }),
    { mode: 0o600 },
  );
  fs.writeFileSync(recoveryPath, '{partial', { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(recoveryPath, old, old);
  const lock = acquireSingleInstanceLock({
    filePath,
    pid: 222,
    isProcessAlive: () => false,
    recoveryStaleMs: 30_000,
  });
  assert.equal(readOwner(filePath).pid, 222);
  assert.equal(fs.existsSync(recoveryPath), false);
  lock.release();
});
