import assert from 'node:assert/strict';
import type { Serializable } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AgentInput,
  AgentSubmission,
  HistoryInspection,
} from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { DeliveryService } from '../../src/services/delivery-service.ts';
import { OutboundPreparer } from '../../src/services/outbound-preparer.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
import { startTestChild } from '../support/child-process.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const currentFile = fileURLToPath(import.meta.url);
const mode = process.argv[2] || '';

interface SpoolReady extends Record<string, Serializable> {
  type: 'spool-ready';
  messageKey: string;
  spoolPath: string;
}

async function seedWorker(databaseFile: string, spoolDirectory: string): Promise<void> {
  const store = new SqliteStore({ filePath: databaseFile });
  store.ingestSyncPage({
    openKfId: 'wk-image-crash',
    nextCursor: 'cursor',
    messages: [testWecomMessage({
      id: 'generated-crash', openKfId: 'wk-image-crash',
      externalUserId: 'wm-image-crash', text: '生成图片',
    })],
  });
  const messageKey = stableMessageKey('wk-image-crash', 'generated-crash');
  store.claimInbound({ messageKey });
  store.markInboundPreparing(messageKey, 'turn-image-crash');
  store.setConversationThread({
    openKfId: 'wk-image-crash',
    externalUserId: 'wm-image-crash',
    threadId: 'thread-image-crash',
  });
  const preparer = new OutboundPreparer({
    spoolDirectory,
    mediaGateway: {
      async upload() { return { media_id: 'first-upload' }; },
      async cloneForSend() { throw new Error('not expected'); },
      async getCardThumbnailMediaId() { throw new Error('not expected'); },
    },
  });
  const png = Buffer.from('89504e470d0a1a0a09090909', 'hex');
  const prepared = await preparer.prepare({
    messageKey,
    candidates: [{
      type: 'generated_image', bytes: png, filename: 'generated.png',
      contentType: 'image/png', generationId: 'generation-crash',
      revisedPrompt: '生成一张测试图',
    }],
  });
  if (!process.send) throw new Error('IPC channel required');
  process.send({
    type: 'spool-ready', messageKey, spoolPath: prepared.spoolPaths[0]!,
  } satisfies SpoolReady);
  process.on('message', () => store.close());
}

if (mode === '--seed') {
  await seedWorker(process.argv[3] || '', process.argv[4] || '');
} else {
  test('[I04] real process crash restores and cleans the durable generated-image spool', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-spool-crash-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const databaseFile = path.join(directory, 'state.sqlite');
    const spoolDirectory = path.join(directory, 'spool');
    const child = startTestChild(t, currentFile, {
      args: ['--seed', databaseFile, spoolDirectory],
      execArgv: ['--experimental-strip-types'],
    });
    const ready = await child.waitForMessage(
      (message): message is SpoolReady =>
        typeof message === 'object' && message !== null &&
        'type' in message && message.type === 'spool-ready',
    );
    await fs.access(ready.spoolPath);
    assert.deepEqual(await child.stop('SIGKILL'), {
      code: null, signal: 'SIGKILL',
    });

    const store = new SqliteStore({ filePath: databaseFile });
    const sent: string[] = [];
    const preparer = new OutboundPreparer({
      spoolDirectory,
      mediaGateway: {
        async upload() { return { media_id: 'restored-upload' }; },
        async cloneForSend() { throw new Error('not expected'); },
        async getCardThumbnailMediaId() { throw new Error('not expected'); },
      },
    });
    const delivery = new DeliveryService({
      store,
      apiClient: {
        async sendPreparedMessage(input) {
          const image = input.payload.image as { media_id?: unknown };
          sent.push(String(image.media_id || ''));
          return { msgid: 'wx-restored-image' };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    const agent = {
      async inspectHistory(): Promise<HistoryInspection> {
        return {
          state: 'completed', turnId: 'turn-image-crash',
          foundClientInputIds: new Set([ready.messageKey]), candidates: [],
        };
      },
      async submit(_input: AgentInput): Promise<AgentSubmission> {
        throw new Error('completed history must restore spool without Codex replay');
      },
      async close() {},
      async abort() {},
    };
    const processor = new ConversationProcessor({
      store, codexAgent: agent,
      mediaGateway: { resolveForCodex: async () => [] },
      outboundPreparer: preparer, delivery,
      allowedUserIds: ['wm-image-crash'],
      logger: { info() {}, warn() {}, error() {} },
    });
    await processor.recover(store.recoverStartup().inbound);
    await processor.waitForIdle();
    await delivery.waitForIdle();
    assert.deepEqual(sent, ['restored-upload']);
    await assert.rejects(fs.access(ready.spoolPath), { code: 'ENOENT' });
    assert.deepEqual(
      inspectAttempts(store.database, ready.messageKey).map((attempt) => attempt.status),
      ['accepted'],
    );
    await processor.close();
    await delivery.close();
    store.close();
  });
}
