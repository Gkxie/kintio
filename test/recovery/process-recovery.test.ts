import assert from 'node:assert/strict';
import type { Serializable } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { acquireSingleInstanceLock } from '../../src/runtime/single-instance-lock.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import {
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import { isForcedExit, startTestChild } from '../support/child-process.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const currentFile = fileURLToPath(import.meta.url);
const workerMode = process.argv[2] || '';

interface WorkerMessage extends Record<string, Serializable> {
  type: string;
}

function isWorkerMessage(
  message: Serializable,
  type: string,
): message is WorkerMessage {
  return typeof message === 'object' && message !== null &&
    'type' in message && message.type === type;
}

function sendToParent(
  message: Serializable,
  callback?: (error: Error | null) => void,
): void {
  if (typeof process.send !== 'function') {
    throw new Error('Recovery worker requires an IPC channel');
  }
  if (callback) process.send(message, callback);
  else process.send(message);
}

async function runLockWorker(lockFile: string): Promise<void> {
  try {
    const lock = acquireSingleInstanceLock({ filePath: lockFile });
    sendToParent({ type: 'lock-acquired', pid: process.pid });
    process.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' ||
          !('type' in message) || message.type !== 'release') return;
      const released = lock.release();
      sendToParent({ type: 'lock-released', released }, () => process.exit(0));
    });
  } catch (error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    sendToParent(
      {
        type: 'lock-rejected',
        name: failure.name,
        code: 'code' in failure ? String(failure.code) : '',
        message: failure.message,
      },
      () => process.exit(0),
    );
  }
}

async function runSendingWorker(databaseFile: string): Promise<void> {
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  const attempt = store.beginNextSend('wechat_kf');
  if (!attempt) {
    persistence.close();
    sendToParent({ type: 'send-claim-failed' }, () => process.exit(1));
    return;
  }
  sendToParent({
    type: 'send-claimed',
    attemptId: attempt.attemptId,
    status: attempt.status,
  });
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' ||
        !('type' in message) || message.type !== 'close') return;
    persistence.close();
    sendToParent({ type: 'store-closed' }, () => process.exit(0));
  });
}

if (workerMode === '--lock-worker') {
  await runLockWorker(process.argv[3] || '');
} else if (workerMode === '--sending-worker') {
  await runSendingWorker(process.argv[3] || '');
} else {
test('two real processes reject a live owner and recover its stale lock after SIGKILL', async (t) => {
    const temporary = await createTempSqlite(t, {
      prefix: 'wechat-process-lock-',
      filename: 'wecom.sqlite',
    });
    const lockFile = path.join(temporary.directory, 'wecom.lock');
    const seedPersistence = temporary.openPersistence();
    const seed = seedPersistence.core;
    seed.ingestSyncPage({
      accountKey: 'wk-lock-sentinel',
      nextCursor: 'intact',
      messages: [],
    });
    seedPersistence.close();

    const first = startTestChild(t, currentFile, {
      args: ['--lock-worker', lockFile],
    });
    const firstOwner = await first.waitForMessage(
      (message): message is WorkerMessage =>
        isWorkerMessage(message, 'lock-acquired'),
    );
    assert.ok(Number(firstOwner.pid) > 0);

    const second = startTestChild(t, currentFile, {
      args: ['--lock-worker', lockFile],
    });
    const rejected = await second.waitForMessage(
      (message): message is WorkerMessage =>
        isWorkerMessage(message, 'lock-rejected'),
    );
    assert.equal(rejected.name, 'SingleInstanceLockError');
    assert.equal(rejected.code, 'instance_locked');
    assert.match(String(rejected.message), new RegExp(String(firstOwner.pid), 'u'));
    assert.deepEqual(await second.waitForExit(), { code: 0, signal: null });

    assert.equal(isForcedExit(await first.stop('SIGKILL'), 'SIGKILL'), true);
    await fs.access(lockFile);

    const recovered = startTestChild(t, currentFile, {
      args: ['--lock-worker', lockFile],
    });
    const recoveredOwner = await recovered.waitForMessage(
      (message): message is WorkerMessage =>
        isWorkerMessage(message, 'lock-acquired'),
    );
    assert.notEqual(recoveredOwner.pid, firstOwner.pid);
    recovered.child.send({ type: 'release' });
    assert.deepEqual(await recovered.waitForMessage('lock-released'), {
      type: 'lock-released',
      released: true,
    });
    assert.deepEqual(await recovered.waitForExit(), { code: 0, signal: null });
    await assert.rejects(() => fs.access(lockFile), { code: 'ENOENT' });

    const verified = temporary.openPersistence().core;
    assert.equal(verified.getCursor('wk-lock-sentinel'), 'intact');
    assert.deepEqual(verified.integrityCheck().map(Object.values), [['ok']]);
    assert.deepEqual(verified.foreignKeyCheck(), []);
  });

test('SIGKILL after claiming a send changes sending to uncertain on startup without requeue', async (t) => {
    const temporary = await createTempSqlite(t, {
      prefix: 'wechat-process-send-',
      filename: 'wecom.sqlite',
    });
    const firstPersistence = temporary.openPersistence();
    const first = firstPersistence.core;
    first.ingestSyncPage({
      accountKey: 'wk-recovery',
      nextCursor: 'cursor-one',
      messages: [testWecomMessage({
        id: 'message-one',
        openKfId: 'wk-recovery',
        externalUserId: 'wm-recovery',
        text: 'send once',
      })],
    });
    const messageKey = stableMessageKey(
      'wechat_kf', 'wk-recovery', 'message-one',
    );
    first.claimInbound({ messageKey });
    const finalized = seedPendingAttempts(first, messageKey, [
        {
          sendIndex: 0,
          source: 'codex_tool',
          sentType: 'text',
          payload: { msgtype: 'text', text: { content: 'only once' } },
        },
      ]);
    const attemptId = finalized[0]?.attemptId;
    assert.ok(attemptId);
    firstPersistence.close();

    const sender = startTestChild(t, currentFile, {
      args: ['--sending-worker', temporary.filePath],
    });
    assert.deepEqual(await sender.waitForMessage('send-claimed'), {
      type: 'send-claimed',
      attemptId,
      status: 'sending',
    });
    assert.equal(isForcedExit(await sender.stop('SIGKILL'), 'SIGKILL'), true);

    const recovered = temporary.openPersistence().core;
    assert.equal(recovered.getAttempt(attemptId)?.status, 'sending');
    const summary = recovered.recoverStartup();
    assert.equal(summary.uncertainSends, 1);
    assert.equal(recovered.getAttempt(attemptId)?.status, 'uncertain');
    assert.equal(recovered.beginNextSend('wechat_kf'), undefined);
    assert.equal(recovered.getInbound(messageKey)?.status, 'completed');
    assert.deepEqual(recovered.integrityCheck().map(Object.values), [['ok']]);
  });
}
