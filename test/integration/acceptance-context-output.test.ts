import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  prepareSendBatch,
  normalizeSendIntent,
} from '../../src/domain/send-contract.js';
import {
  normalizeWecomMessage,
  renderMessageForCodex,
} from '../../src/domain/wecom-message.js';
import { CodexAgent, type AgentInput } from '../../src/services/codex-agent.js';
import type {
  CodexBoundary,
  CodexInput,
  CodexRun,
  CodexThread,
  CodexThreadOptions,
} from '../../src/services/codex-app-server.js';
import { withStagedImages } from '../../src/services/image-stager.js';
import { WecomMediaGateway } from '../../src/services/media-gateway.js';
import { OutboundPreparer } from '../../src/services/outbound-preparer.js';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.js';
import { testWecomMessage } from '../support/wecom-message.js';

const base = {
  open_kfid: 'wk-acceptance',
  external_userid: 'wm-acceptance',
  origin: 3,
  send_time: 1,
};

async function tempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('[C02] link title, description, and URL enter the Codex summary', () => {
  const message = normalizeWecomMessage({
    ...base,
    msgid: 'link-one',
    msgtype: 'link',
    link: {
      title: '@示例博主主页',
      desc: '主要分享 AI 编程与开源项目',
      url: 'https://example.com/creator',
    },
  });
  const summary = renderMessageForCodex(message);
  assert.match(summary, /@示例博主主页/u);
  assert.match(summary, /AI 编程与开源项目/u);
  assert.match(summary, /https:\/\/example\.com\/creator/u);
});

test('[C04] voice, video, and file remain explicit unresolved summaries with zero downloads', async () => {
  let downloads = 0;
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia() {
        downloads += 1;
        return { bytes: Buffer.from('unused'), contentType: 'application/octet-stream' };
      },
      async uploadMedia() { return { media_id: 'unused' }; },
    },
  });
  const fixtures = [
    ['voice', { voice: { media_id: 'voice-secret' } }, /未下载、未转写/u],
    ['video', { video: { media_id: 'video-secret' } }, /未下载、未观看或转写/u],
    [
      'file',
      { file: { media_id: 'file-secret', filename: '合同.pdf' } },
      /内容未下载或打开/u,
    ],
  ] as const;
  for (const [msgtype, payload, expected] of fixtures) {
    const message = normalizeWecomMessage({
      ...base,
      msgid: `${msgtype}-one`,
      msgtype,
      ...payload,
    });
    assert.match(renderMessageForCodex(message), expected);
    assert.deepEqual(await gateway.resolveForCodex(message), []);
  }
  assert.equal(downloads, 0);
});

test('[C06] multiple images stage in input order and clean on success and failure', async (t) => {
  const directory = await tempDirectory(t, 'ordered-images-');
  const png = Buffer.from('89504e470d0a1a0a01010101', 'hex');
  const jpeg = Buffer.from('ffd8ff020202', 'hex');
  let successfulPaths: readonly string[] = [];
  await withStagedImages(
    [
      { bytes: png },
      { bytes: jpeg },
    ],
    { temporaryRoot: directory },
    async (paths) => {
      successfulPaths = [...paths];
      assert.deepEqual(await fs.readFile(paths[0]!), png);
      assert.deepEqual(await fs.readFile(paths[1]!), jpeg);
      assert.match(paths[0]!, /image-0\.png$/u);
      assert.match(paths[1]!, /image-1\.jpg$/u);
    },
  );
  for (const filePath of successfulPaths) {
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  }

  let failedPaths: readonly string[] = [];
  await assert.rejects(
    withStagedImages(
      [{ bytes: png }],
      { temporaryRoot: directory },
      async (paths) => {
        failedPaths = [...paths];
        throw new Error('operation failed');
      },
    ),
    /operation failed/u,
  );
  for (const filePath of failedPaths) {
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  }
});

function stagedText(content: string) {
  return {
    id: `tool-${content}`,
    type: 'mcpToolCall',
    server: 'wechat_kf',
    tool: 'send_text',
    status: 'completed',
    startedSequence: 1,
    result: {
      structuredContent: {
        staged: true,
        candidate: { type: 'text', content },
      },
    },
  };
}

class PromptBoundary implements CodexBoundary {
  readonly prompts: CodexInput[] = [];
  readonly thread: CodexThread = {
    id: 'thread-channel-prompt',
    startRun: async (input): Promise<CodexRun> => {
      this.prompts.push(input);
      return {
        turnId: `turn-${this.prompts.length}`,
        completion: Promise.resolve({ items: [stagedText('ack')] }),
      };
    },
    steer: async () => { throw new Error('no active steer expected'); },
  };
  startThread(_options: CodexThreadOptions): CodexThread { return this.thread; }
  resumeThread(_threadId: string, _options: CodexThreadOptions): CodexThread {
    return this.thread;
  }
  async readThread(): Promise<unknown> { return { thread: { turns: [] } }; }
  async close(): Promise<void> {}
}

test('[C07] accepted, failed, and uncertain remain independent channel facts in prompts', async (t) => {
  const directory = await tempDirectory(t, 'channel-prompt-');
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  const boundary = new PromptBoundary();
  const agent = new CodexAgent({
    codex: boundary,
    store,
    config: {
      model: 'gpt-channel', reasoningEffort: 'none', sandboxMode: 'read-only',
      workingDirectory: directory, imageTempDirectory: directory,
      generatedImageDirectory: path.join(directory, 'generated'),
    },
  });
  t.after(async () => {
    await agent.close();
    store.close();
  });
  let cursor = '';
  const states: NonNullable<AgentInput['channelState']>[] = [
    { accepted: true, recent: [{ sentType: 'image', status: 'accepted' }] },
    { accepted: false, recent: [{ sentType: 'text', status: 'failed', failType: 13 }] },
    { accepted: false, recent: [{ sentType: 'image', status: 'uncertain' }] },
  ];
  for (const [index, channelState] of states.entries()) {
    const msgid = `channel-${index}`;
    const page = store.ingestSyncPage({
      openKfId: 'wk-channel',
      expectedCursor: cursor,
      nextCursor: `${cursor}-${index}`,
      messages: [testWecomMessage({
        id: msgid,
        openKfId: 'wk-channel',
        externalUserId: 'wm-channel',
      })],
    });
    cursor = `${cursor}-${index}`;
    const messageKey = page.insertedMessageKeys[0]!;
    const submission = await agent.submit({
      message: {
        id: msgid, messageKey, origin: 'customer', type: 'text', rawType: 'text',
        sentAt: index, sync: { cursor, index: 0 },
        conversation: { openKfId: 'wk-channel', externalUserId: 'wm-channel' },
        actor: { servicerUserId: '' }, text: msgid, summary: msgid,
        attributes: {}, attachments: [],
      },
      contextText: msgid,
      channelState,
    });
    assert.equal(submission.kind, 'started');
    if (submission.kind === 'started') await submission.completion;
  }
  assert.match(String(boundary.prompts[0]), /image:accepted/u);
  assert.match(String(boundary.prompts[1]), /text:failed\(fail_type=13\)/u);
  assert.match(String(boundary.prompts[2]), /image:uncertain/u);
  assert.doesNotMatch(String(boundary.prompts[2]), /已被微信 API 接受/u);
});

test('[O03] multiple reliable locations stay native, within five, and add no pending text', async (t) => {
  const directory = await tempDirectory(t, 'native-locations-');
  const preparer = new OutboundPreparer({
    spoolDirectory: path.join(directory, 'spool'),
    mediaGateway: {
      async upload() { return { media_id: 'unused' }; },
      async cloneForSend() { return 'unused'; },
      async getCardThumbnailMediaId() { return 'unused'; },
    },
  });
  const locations = ['甲店', '乙店', '丙店'].map((name, index) => ({
    type: 'location' as const,
    name,
    address: `${name}地址`,
    latitude: 39 + index / 100,
    longitude: 116 + index / 100,
  }));
  const prepared = await preparer.prepare({
    messageKey: 'locations',
    candidates: locations,
  });
  assert.equal(prepared.attempts.length, 5);
  assert.deepEqual(
    prepared.attempts.filter((item) => item.status !== 'blocked')
      .map((item) => item.sentType),
    ['location', 'location', 'location'],
  );
  assert.equal(
    prepared.attempts.some((item) => item.sentType === 'text' && item.status !== 'blocked'),
    false,
  );
});

test('[O04] map URL remains a link, never a location, and private URLs are rejected', () => {
  const link = normalizeSendIntent('send_link', {
    title: '地图',
    description: '导航链接',
    url: 'https://maps.example.com/place/one',
  });
  assert.equal(link.type, 'link');
  assert.deepEqual(prepareSendBatch([link]), [link]);
  assert.throws(
    () => normalizeSendIntent('send_link', {
      title: '内网地图', description: '', url: 'http://127.0.0.1/map',
    }),
    /public HTTP/u,
  );
});

test('[O05] unverifiable mini-program fields reject while text fallback remains valid', () => {
  assert.throws(
    () => normalizeSendIntent('send_miniprogram', {
      appId: '', title: '猜测入口', pagePath: '', sourceUrl: 'https://example.com',
    }),
    /appId|pagePath/u,
  );
  assert.deepEqual(normalizeSendIntent('send_text', {
    content: '暂时找不到可核验的小程序入口。',
  }), {
    type: 'text',
    content: '暂时找不到可核验的小程序入口。',
  });
});

interface AttemptStatusRow {
  readonly status: string;
  readonly sent_type: string;
}

test('[O08] every outbound format has at most one definitive fallback and uncertain activates none', async (t) => {
  const directory = await tempDirectory(t, 'native-fallbacks-');
  const candidates = [
    { type: 'text', content: '文字' },
    { type: 'image', mediaRef: 'media:0' },
    { type: 'link', title: '链接', description: '说明', url: 'https://example.com' },
    {
      type: 'miniprogram', appId: 'wx1234567890abcdef', title: '小程序',
      pagePath: 'pages/index', sourceUrl: 'https://example.com/mini',
    },
    {
      type: 'location', name: '地点', address: '地址',
      latitude: 39, longitude: 116,
    },
  ] as const;

  for (const [index, candidate] of candidates.entries()) {
    const store = new SqliteStore({
      filePath: path.join(directory, `format-${index}.sqlite`),
    });
    const preparer = new OutboundPreparer({
      spoolDirectory: path.join(directory, `spool-${index}`),
      mediaGateway: {
        async upload() { return { media_id: 'unused' }; },
        async cloneForSend() { return 'cloned-image'; },
        async getCardThumbnailMediaId() { return 'thumbnail'; },
      },
    });
    const mediaCatalog = candidate.type === 'image'
      ? [{
          ref: 'media:0', messageKey: 'source', openKfId: 'wk-one',
          externalUserId: 'wm-one', kind: 'image' as const, mediaId: 'source-image',
          filename: 'source.png', sentAt: 1, rememberedAt: 1,
        }]
      : [];
    store.ingestSyncPage({
      openKfId: 'wk-one', nextCursor: 'cursor',
      messages: [testWecomMessage({
        id: 'source', openKfId: 'wk-one', externalUserId: 'wm-one',
      })],
    });
    const key = stableMessageKey('wk-one', 'source');
    const claimed = store.claimInbound({ messageKey: key }).message;
    const prepared = await preparer.prepare({
      messageKey: key,
      candidates: [candidate],
      mediaCatalog,
    });
    store.finalizeInboundBatch({
      messageKey: key,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: prepared.attempts,
    });
    const primary = store.beginNextSend()!;
    store.failSend(primary.attemptId, new Error('definitive'));
    const rows = store.database.prepare(`
      SELECT status, sent_type FROM send_attempts
      WHERE source_message_key = ? ORDER BY send_index
    `).all(key) as unknown as AttemptStatusRow[];
    assert.equal(rows.filter((row) => row.status === 'pending').length, index === 0 ? 0 : 1);
    assert.ok(rows.filter((row) => row.status === 'pending').length <= 1);
    store.close();
  }

  const store = new SqliteStore({ filePath: path.join(directory, 'uncertain.sqlite') });
  store.ingestSyncPage({
    openKfId: 'wk-one', nextCursor: 'cursor',
    messages: [testWecomMessage({
      id: 'uncertain', openKfId: 'wk-one', externalUserId: 'wm-one',
      text: 'source',
    })],
  });
  const key = stableMessageKey('wk-one', 'uncertain');
  const claimed = store.claimInbound({ messageKey: key }).message;
  const preparer = new OutboundPreparer({
    spoolDirectory: path.join(directory, 'uncertain-spool'),
    mediaGateway: {
      async upload() { return { media_id: 'unused' }; },
      async cloneForSend() { return 'unused'; },
      async getCardThumbnailMediaId() { return 'unused'; },
    },
  });
  const prepared = await preparer.prepare({
    messageKey: key,
    candidates: [{
      type: 'location', name: '地点', address: '地址', latitude: 39, longitude: 116,
    }],
  });
  store.finalizeInboundBatch({
    messageKey: key,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: prepared.attempts,
  });
  store.markSendUncertain(store.beginNextSend()!.attemptId, new Error('network'));
  const rows = store.database.prepare(
    'SELECT status, sent_type FROM send_attempts WHERE source_message_key = ? ORDER BY send_index',
  ).all(key) as unknown as AttemptStatusRow[];
  assert.deepEqual(rows.map((row) => row.status), ['uncertain', 'blocked']);
  store.close();
});

test('[SEC04] database and durable spool are private and orphan cleanup preserves active files', async (t) => {
  const directory = await tempDirectory(t, 'private-state-');
  const databaseFile = path.join(directory, 'private', 'wecom.sqlite');
  const store = new SqliteStore({ filePath: databaseFile });
  t.after(() => store.close());
  assert.equal((await fs.stat(path.dirname(databaseFile))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(databaseFile)).mode & 0o777, 0o600);

  const spoolDirectory = path.join(directory, 'spool');
  const png = Buffer.from('89504e470d0a1a0a08080808', 'hex');
  const preparer = new OutboundPreparer({
    spoolDirectory,
    mediaGateway: {
      async upload() { throw new Error('keep durable spool'); },
      async cloneForSend() { return 'unused'; },
      async getCardThumbnailMediaId() { return 'unused'; },
    },
  });
  const prepared = await preparer.prepare({
    messageKey: 'active_spool',
    candidates: [{
      type: 'generated_image', bytes: png, filename: 'generated.png',
      contentType: 'image/png', generationId: 'generation', revisedPrompt: 'edit',
    }],
  });
  const activePath = prepared.spoolPaths[0]!;
  const orphanPath = path.join(spoolDirectory, 'orphan.json');
  await fs.writeFile(orphanPath, '{}', { mode: 0o600 });
  assert.equal((await fs.stat(spoolDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(activePath)).mode & 0o777, 0o600);
  await preparer.cleanupOrphans(new Set(['active_spool']));
  assert.equal(await fs.access(activePath).then(() => true), true);
  await assert.rejects(fs.access(orphanPath), { code: 'ENOENT' });
  await preparer.cleanup(prepared.spoolPaths);

  const outsidePath = path.join(directory, 'outside.txt');
  await fs.writeFile(outsidePath, 'sentinel');
  const linkedSpool = path.join(spoolDirectory, 'linked.json');
  await fs.symlink(outsidePath, linkedSpool);
  await assert.rejects(
    preparer.restoreGenerated('linked'),
    /regular file/u,
  );
  assert.equal(await fs.readFile(outsidePath, 'utf8'), 'sentinel');
});
