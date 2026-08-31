import assert from 'node:assert/strict';
import type { Serializable } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { describe, test } from 'vitest';
import type { TestContext } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  stableMessageKey,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { isForcedExit, startTestChild } from '../support/child-process.ts';
import {
  createTempSqlite,
  openInjectedTestPersistence,
} from '../support/temp-sqlite.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const currentFile = fileURLToPath(import.meta.url);
const workerMode = process.argv[2] || '';
const openKfId = 'wk-authorization';
const externalUserId = 'wm-authorization';
const confirmationText = '暗号确认，请继续对话';

interface WorkerMessage extends Record<string, Serializable> {
  type: string;
}

function sendToParent(
  message: Serializable,
  callback?: (error: Error | null) => void,
): void {
  if (typeof process.send !== 'function') {
    throw new Error('Authorization recovery worker requires IPC');
  }
  if (callback) process.send(message, callback);
  else process.send(message);
}

function finishWorker(persistence: StatePersistence, message: Serializable): void {
  persistence.close();
  sendToParent(message, () => process.exit(0));
}

function evaluateThird(store: CoreState, messageKey: string): void {
  store.evaluateAuthorization({
    messageKey,
    openKfId,
    externalUserId,
    isTrigger: true,
    requiredConsecutive: 3,
    confirmationText,
  });
}

function holdWorker(): void {
  process.on('message', () => {});
}

function runAtomicWorker(
  databaseFile: string,
  messageKey: string,
  barrierFile: string,
): void {
  const persistence = openInjectedTestPersistence(databaseFile);
  persistence.database.function('authorization_crash_barrier', () => {
    fs.writeFileSync(barrierFile, 'inside-transaction', { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return 0;
  });
  const store = persistence.core;
  persistence.database.exec(`
    CREATE TEMP TRIGGER crash_before_authorization_attempt
    BEFORE INSERT ON send_attempts
    WHEN NEW.source = 'authorization'
    BEGIN
      SELECT authorization_crash_barrier();
    END
  `);
  evaluateThird(store, messageKey);
  throw new Error('Atomic authorization worker unexpectedly crossed barrier');
}

function runAuthorizationWorker(databaseFile: string, messageKey: string): void {
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  evaluateThird(store, messageKey);
  const attempt = store.listMessageAttempts(messageKey)[0];
  if (!attempt) {
    finishWorker(persistence, { type: 'authorization-failed' });
    return;
  }
  holdWorker();
  sendToParent({
    type: 'authorization-committed',
    attemptId: attempt.attemptId,
    status: attempt.status,
  });
}

function runSendWorker(databaseFile: string, behavior: string): void {
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  const attempt = store.beginNextSend();
  if (!attempt) {
    finishWorker(persistence, { type: 'no-send' });
    return;
  }
  if (behavior === 'hold') {
    holdWorker();
    sendToParent({
      type: 'send-claimed',
      attemptId: attempt.attemptId,
      status: attempt.status,
    });
    return;
  }
  const accepted = store.completeSend(attempt.attemptId, {
    wecomMsgId: `wecom-${attempt.clientMessageId}`,
  });
  const message = {
    type: 'send-accepted',
    attemptId: accepted.attemptId,
    status: accepted.status,
  };
  if (behavior === 'accept-hold') {
    holdWorker();
    sendToParent(message);
    return;
  }
  finishWorker(persistence, message);
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsPromises.access(filePath);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for crash barrier ${filePath}`);
}

function seedAuthorizationPrelude(store: CoreState, suffix: string): string {
  let cursor = '';
  for (let index = 1; index <= 3; index += 1) {
    const msgid = `${suffix}-${index}`;
    const nextCursor = `${suffix}-cursor-${index}`;
    store.ingestSyncPage({
      openKfId,
      expectedCursor: cursor,
      nextCursor,
      messages: [testWecomMessage({
        id: msgid,
        openKfId,
        externalUserId,
        sentAt: index,
        text: '发车',
      })],
    });
    cursor = nextCursor;
    const messageKey = stableMessageKey(openKfId, msgid);
    if (index < 3) {
      const result = store.evaluateAuthorization({
        messageKey,
        openKfId,
        externalUserId,
        isTrigger: true,
        requiredConsecutive: 3,
        confirmationText,
      });
      assert.equal(result.consecutiveMatches, index);
      assert.equal(result.decision, 'blocked');
    }
  }
  return stableMessageKey(openKfId, `${suffix}-3`);
}

async function seedDatabase(
  t: TestContext,
  suffix: string,
): Promise<{ filePath: string; messageKey: string }> {
  const temporary = await createTempSqlite(t, {
    prefix: `wechat-auth-${suffix}-`,
    filename: 'wecom.sqlite',
  });
  const persistence = temporary.openPersistence();
  const store = persistence.core;
  const messageKey = seedAuthorizationPrelude(store, suffix);
  persistence.close();
  return { filePath: temporary.filePath, messageKey };
}

async function assertNoChildSend(
  t: TestContext,
  databaseFile: string,
): Promise<void> {
  const child = startTestChild(t, currentFile, {
    args: ['--send-worker', databaseFile, 'none'],
  });
  assert.deepEqual(await child.waitForMessage('no-send'), { type: 'no-send' });
  assert.deepEqual(await child.waitForExit(), { code: 0, signal: null });
}

if (workerMode === '--atomic-worker') {
  runAtomicWorker(
    process.argv[3] || '',
    process.argv[4] || '',
    process.argv[5] || '',
  );
} else if (workerMode === '--authorization-worker') {
  runAuthorizationWorker(process.argv[3] || '', process.argv[4] || '');
} else if (workerMode === '--send-worker') {
  runSendWorker(process.argv[3] || '', process.argv[4] || '');
} else {
  describe('authorization confirmation crash boundaries', () => {
    test('transaction rollback keeps authorization and confirmation atomic', async (subtest) => {
      const seeded = await seedDatabase(subtest, 'atomic');
      const barrierFile = `${seeded.filePath}.authorization-barrier`;
      const child = startTestChild(subtest, currentFile, {
        args: [
          '--atomic-worker',
          seeded.filePath,
          seeded.messageKey,
          barrierFile,
        ],
      });
      await waitForFile(barrierFile);
      assert.equal(isForcedExit(await child.stop('SIGKILL'), 'SIGKILL'), true);

      const recoveredPersistence = new StatePersistence({ filePath: seeded.filePath });
      const recovered = recoveredPersistence.core;
      subtest.onTestFinished(() => recoveredPersistence.close());
      assert.deepEqual(recovered.getAuthorization(externalUserId), {
        externalUserId,
        authorized: false,
        consecutiveMatches: 2,
        lastOpenKfId: openKfId,
        lastMessageKey: stableMessageKey(openKfId, 'atomic-2'),
        authorizedAt: 0,
        updatedAt: recovered.getAuthorization(externalUserId)?.updatedAt,
      });
      assert.equal(recovered.getInbound(seeded.messageKey)?.status, 'received');
      assert.equal(recovered.listMessageAttempts(seeded.messageKey).length, 0);

      evaluateThird(recovered, seeded.messageKey);
      assert.equal(recovered.getAuthorization(externalUserId)?.authorized, true);
      assert.equal(recovered.listMessageAttempts(seeded.messageKey).length, 1);
      evaluateThird(recovered, seeded.messageKey);
      assert.equal(recovered.listMessageAttempts(seeded.messageKey).length, 1);
    });

    test('committed confirmation survives a crash and sends once', async (subtest) => {
      const seeded = await seedDatabase(subtest, 'pending');
      const authorizer = startTestChild(subtest, currentFile, {
        args: ['--authorization-worker', seeded.filePath, seeded.messageKey],
      });
      const committed = await authorizer.waitForMessage(
        (message): message is WorkerMessage =>
          typeof message === 'object' && message !== null &&
          'type' in message && message.type === 'authorization-committed',
      );
      assert.equal(committed.status, 'pending');
      assert.equal(isForcedExit(await authorizer.stop('SIGKILL'), 'SIGKILL'), true);

      const auditPersistence = new StatePersistence({ filePath: seeded.filePath });
      const audit = auditPersistence.core;
      const attempt = audit.listMessageAttempts(seeded.messageKey)[0];
      assert.ok(attempt);
      assert.equal(attempt.attemptId, committed.attemptId);
      assert.equal(attempt.status, 'pending');
      assert.equal(audit.getAuthorization(externalUserId)?.authorized, true);
      auditPersistence.close();

      const sender = startTestChild(subtest, currentFile, {
        args: ['--send-worker', seeded.filePath, 'accept-exit'],
      });
      const accepted = await sender.waitForMessage('send-accepted');
      assert.equal(
        typeof accepted === 'object' && accepted !== null &&
          'attemptId' in accepted ? accepted.attemptId : undefined,
        attempt.attemptId,
      );
      assert.deepEqual(await sender.waitForExit(), { code: 0, signal: null });
      await assertNoChildSend(subtest, seeded.filePath);
    });

    test('claimed confirmation becomes uncertain and is never retried', async (subtest) => {
      const seeded = await seedDatabase(subtest, 'sending');
      const preparedPersistence = new StatePersistence({ filePath: seeded.filePath });
      const prepared = preparedPersistence.core;
      evaluateThird(prepared, seeded.messageKey);
      const attempt = prepared.listMessageAttempts(seeded.messageKey)[0];
      assert.ok(attempt);
      preparedPersistence.close();

      const sender = startTestChild(subtest, currentFile, {
        args: ['--send-worker', seeded.filePath, 'hold'],
      });
      const claimed = await sender.waitForMessage('send-claimed');
      assert.equal(
        typeof claimed === 'object' && claimed !== null &&
          'attemptId' in claimed ? claimed.attemptId : undefined,
        attempt.attemptId,
      );
      assert.equal(isForcedExit(await sender.stop('SIGKILL'), 'SIGKILL'), true);

      const recoveredPersistence = new StatePersistence({ filePath: seeded.filePath });
      const recovered = recoveredPersistence.core;
      assert.equal(recovered.getAttempt(attempt.attemptId)?.status, 'sending');
      assert.equal(recovered.recoverStartup().uncertainSends, 1);
      assert.equal(recovered.getAttempt(attempt.attemptId)?.status, 'uncertain');
      assert.equal(recovered.beginNextSend(), undefined);
      recoveredPersistence.close();
      await assertNoChildSend(subtest, seeded.filePath);
    });

    test('accepted confirmation is never resent after a crash', async (subtest) => {
      const seeded = await seedDatabase(subtest, 'accepted');
      const preparedPersistence = new StatePersistence({ filePath: seeded.filePath });
      const prepared = preparedPersistence.core;
      evaluateThird(prepared, seeded.messageKey);
      const attempt = prepared.listMessageAttempts(seeded.messageKey)[0];
      assert.ok(attempt);
      preparedPersistence.close();

      const sender = startTestChild(subtest, currentFile, {
        args: ['--send-worker', seeded.filePath, 'accept-hold'],
      });
      const accepted = await sender.waitForMessage('send-accepted');
      assert.equal(
        typeof accepted === 'object' && accepted !== null &&
          'attemptId' in accepted ? accepted.attemptId : undefined,
        attempt.attemptId,
      );
      assert.equal(isForcedExit(await sender.stop('SIGKILL'), 'SIGKILL'), true);

      const recoveredPersistence = new StatePersistence({ filePath: seeded.filePath });
      const recovered = recoveredPersistence.core;
      assert.equal(recovered.recoverStartup().uncertainSends, 0);
      assert.equal(recovered.getAttempt(attempt.attemptId)?.status, 'accepted');
      assert.equal(recovered.beginNextSend(), undefined);
      recoveredPersistence.close();
      await assertNoChildSend(subtest, seeded.filePath);
    });
  });
}
