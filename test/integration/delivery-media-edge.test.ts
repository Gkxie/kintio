import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { DeliveryService } from '../../src/services/delivery-service.js';
import { WecomMediaGateway } from '../../src/services/media-gateway.js';
import {
  SqliteStore,
  stableMessageKey,
  type AttemptRecord,
} from '../../src/state/sqlite-store.js';
import { inspectAttempt } from '../support/sqlite-inspect.js';
import { testWecomMessage } from '../support/wecom-message.js';

async function storeWithAttempt(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-edge-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [testWecomMessage({
      id: 'source', openKfId: 'wk-one', externalUserId: 'wm-one',
    })],
  });
  const messageKey = stableMessageKey('wk-one', 'source');
  const claimed = store.claimInbound({ messageKey }).message;
  const finalized = store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [{
      sendIndex: 0, sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'reply' } },
    }],
  });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, attempt: finalized.attempts[0]! };
}

test('[R07] API success without msgid is uncertain rather than accepted', async (t) => {
  const { store, attempt } = await storeWithAttempt(t);
  const service = new DeliveryService({
    store,
    logger: { info() {}, error() {} },
    apiClient: { async sendPreparedMessage() { return { errcode: 0 }; } },
  });
  await service.kick();
  assert.equal(inspectAttempt(store.database, attempt.attemptId)?.status, 'uncertain');
  assert.match(
    inspectAttempt(store.database, attempt.attemptId)?.errorMessage || '',
    /without a message ID/u,
  );
  await service.close();
});

test('[R01] kick arriving at drain completion cannot lose the next outbox wakeup', async () => {
  const accepted: string[] = [];
  let service!: DeliveryService;
  let phase = 0;
  const attempts: AttemptRecord[] = [0, 1].map((index) => ({
    attemptId: `attempt-${index}`,
    messageKey: `message-${index}`,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    sendIndex: index,
    source: 'test',
    type: 'text',
    payload: { msgtype: 'text', text: { content: `reply-${index}` } },
    fingerprint: `fingerprint-${index}`,
    clientMessageId: `client-${index}`,
    status: 'pending',
    wecomMsgId: '', errorCode: '', errorMessage: '', failType: 0,
    createdAt: index, updatedAt: index,
  }));
  const fakeStore = {
    async beginNextSend(): Promise<AttemptRecord | undefined> {
      if (phase === 0) {
        phase = 1;
        return attempts[0];
      }
      if (phase === 1) {
        phase = 2;
        queueMicrotask(() => void service.kick());
        return undefined;
      }
      if (phase === 2) {
        phase = 3;
        return attempts[1];
      }
      return undefined;
    },
    async completeSend(attemptId: string): Promise<void> {
      accepted.push(attemptId);
    },
    async failSend(): Promise<void> {},
    async markSendUncertain(): Promise<void> {},
  };
  service = new DeliveryService({
    store: fakeStore as unknown as SqliteStore,
    logger: { info() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input) {
        return { msgid: `wecom-${input.messageId}` };
      },
    },
  });
  await service.kick();
  await service.waitForIdle();
  assert.deepEqual(accepted, ['attempt-0', 'attempt-1']);
  await service.close();
});

test('[R01] a kick while the worker pool is saturated survives a stale empty read', async () => {
  const accepted: string[] = [];
  let enteredEmptyRead!: () => void;
  let releaseEmptyRead!: () => void;
  const emptyReadStarted = new Promise<void>((resolve) => {
    enteredEmptyRead = resolve;
  });
  const emptyReadRelease = new Promise<void>((resolve) => {
    releaseEmptyRead = resolve;
  });
  let phase = 0;
  const attempt: AttemptRecord = {
    attemptId: 'attempt-after-stale-read', messageKey: 'message-two',
    openKfId: 'wk-one', externalUserId: 'wm-one', sendIndex: 0,
    source: 'test', type: 'text',
    payload: { msgtype: 'text', text: { content: 'new work' } },
    fingerprint: 'fingerprint', clientMessageId: 'client-two',
    status: 'pending', wecomMsgId: '', errorCode: '', errorMessage: '', failType: 0,
    createdAt: 1, updatedAt: 1,
  };
  const fakeStore = {
    async beginNextSend(): Promise<AttemptRecord | undefined> {
      if (phase === 0) {
        phase = 1;
        enteredEmptyRead();
        await emptyReadRelease;
        return undefined;
      }
      if (phase === 1) {
        phase = 2;
        return attempt;
      }
      return undefined;
    },
    async completeSend(attemptId: string): Promise<void> { accepted.push(attemptId); },
    async failSend(): Promise<void> {},
    async markSendUncertain(): Promise<void> {},
  };
  const service = new DeliveryService({
    store: fakeStore as unknown as SqliteStore,
    concurrency: 1,
    logger: { info() {}, error() {} },
    apiClient: { async sendPreparedMessage() { return { msgid: 'accepted' }; } },
  });
  const initialKick = service.kick();
  await emptyReadStarted;
  const saturatedKick = service.kick();
  releaseEmptyRead();
  await Promise.all([initialKick, saturatedKick]);
  assert.deepEqual(accepted, ['attempt-after-stale-read']);
  await service.close();
});

test('[O06] image clone and card thumbnail caches avoid duplicate download/upload', async () => {
  const downloads: string[] = [];
  const uploads: Array<{ filename: string }> = [];
  let uploaded = 0;
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia(mediaId) {
        downloads.push(mediaId);
        return {
          bytes: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
          contentType: 'image/png',
        };
      },
      async uploadMedia(input) {
        uploads.push({ filename: input.filename });
        uploaded += 1;
        return { media_id: `uploaded-${uploaded}` };
      },
    },
  });
  assert.equal(
    await gateway.cloneForSend({ kind: 'image', sourceMediaId: 'source-one' }),
    'uploaded-1',
  );
  assert.equal(
    await gateway.cloneForSend({ kind: 'image', sourceMediaId: 'source-one' }),
    'uploaded-1',
  );
  assert.equal(await gateway.getCardThumbnailMediaId(), 'uploaded-2');
  assert.equal(await gateway.getCardThumbnailMediaId(), 'uploaded-2');
  assert.deepEqual(downloads, ['source-one']);
  assert.deepEqual(uploads.map((item) => item.filename), ['image.png', 'link-thumbnail.png']);
});

test('[O06] media gateway selects JPEG default filename and rejects unsupported kinds', async () => {
  const filenames: string[] = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia() {
        return {
          bytes: Buffer.from('ffd8ff000000', 'hex'),
          contentType: 'image/jpeg',
        };
      },
      async uploadMedia(input) {
        filenames.push(input.filename);
        return { media_id: 'jpeg-upload' };
      },
    },
  });
  await gateway.cloneForSend({ kind: 'image', sourceMediaId: 'jpeg-source' });
  assert.deepEqual(filenames, ['image.jpg']);
  await assert.rejects(
    gateway.upload({
      kind: 'audio', bytes: Buffer.from('audio'),
      filename: 'audio.amr', contentType: 'audio/amr',
    }),
    /Unsupported attachment kind/u,
  );
  await assert.rejects(
    gateway.cloneForSend({ kind: 'audio', sourceMediaId: 'audio-source' }),
    /Unsupported outbound attachment kind/u,
  );
});
