import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { normalizeIlinkInboundMessage } from '../../src/ilink/message.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { createIlinkAccountKey } from '../../src/ilink/store-types.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import type { AgentRuntime } from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

test('completed Agent image artifact recovers through send_image MCP without host spool', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-artifact-recovery-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
  });
  const store = persistence.core;
  const png = Buffer.from('89504e470d0a1a0a09090909', 'hex');
  const page = store.ingestSyncPage({
    openKfId: 'wk-image',
    nextCursor: 'cursor-one',
    messages: [normalizeWecomMessage({
      msgid: 'image-request', open_kfid: 'wk-image', external_userid: 'wm-image',
      origin: 3, msgtype: 'text', text: { content: '生成图片' },
    }, 'wk-image')],
  });
  const messageKey = page.insertedMessageKeys[0];
  if (!messageKey) throw new Error('Missing image recovery message');
  store.claimInbound({ messageKey });
  store.markInboundPreparing(messageKey, 'turn-image');
  store.setConversationThread({
    openKfId: 'wk-image', externalUserId: 'wm-image', threadId: 'thread-image',
  });

  const sent: Record<string, unknown>[] = [];
  const uploaded: Buffer[] = [];
  const channel = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage(input) {
        sent.push(structuredClone(input.payload));
        return { msgid: 'wx-image-recovered' };
      },
    },
    mediaGateway: {
      async upload(input) {
        uploaded.push(Buffer.from(input.bytes));
        return { media_id: 'uploaded-recovered-image' };
      },
      async cloneForSend() { throw new Error('not expected'); },
      async getCardThumbnailMediaId() { throw new Error('not expected'); },
    },
    observeMs: 0,
    logger: { info() {}, error() {} },
  });
  const recoveryInputs: Parameters<AgentRuntime['submit']>[0][] = [];
  const agent: AgentRuntime = {
    async ensureThread(_conversationId, threadId) {
      return threadId || 'thread-image';
    },
    activePrimary() { return undefined; },
    async inspectHistory() {
      return {
        state: 'completed' as const,
        turnId: 'turn-image',
        foundClientInputIds: new Set([messageKey]),
        artifacts: [{
          type: 'generated_image',
          bytes: png,
          filename: 'recovered.png',
          contentType: 'image/png',
          metadata: {
            generationId: 'generation-recovered',
            revisedPrompt: 'recovered prompt',
          },
        }],
        executedAttemptIds: [],
      };
    },
    async submit(input) {
      recoveryInputs.push(input);
      const artifact = input.artifactCatalog?.[0];
      assert.equal(artifact?.ref, 'artifact:0');
      const receipt = await channel.execute('send_image', {
        session: input.toolSessionToken,
        mediaRef: artifact?.ref,
      });
      return {
        kind: 'started' as const,
        primaryMessageKey: input.message.messageKey,
        turnId: 'turn-image-recovery',
        threadId: input.threadId,
        completion: Promise.resolve({
          executedAttemptIds: [receipt.attemptId],
        }),
      };
    },
    async close() {},
    async abort() {},
  };
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway: { async resolveForCodex() { return []; } },
    channel,
    allowedUserIds: ['wm-image'],
    logger: { info() {}, error() {} },
  });
  t.onTestFinished(async () => {
    await processor.close();
    await channel.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await processor.recover(store.recoverStartup().inbound);
  await processor.waitForIdle();

  assert.equal(recoveryInputs.length, 1);
  assert.match(recoveryInputs[0]?.contextText || '', /available as a deliverable artifact/u);
  assert.deepEqual(uploaded, [png]);
  assert.deepEqual(sent, [{
    msgtype: 'image', image: { media_id: 'uploaded-recovered-image' },
  }]);
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
  assert.deepEqual(store.listMessageAttempts(messageKey).map((attempt) => ({
    source: attempt.source,
    status: attempt.status,
    msgid: attempt.wecomMsgId,
  })), [{ source: 'mcp_tool', status: 'accepted', msgid: 'wx-image-recovered' }]);
});

test('accepted iLink generated image finalizes after restart without another send', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ilink-image-recovery-'));
  const now = 1_800_000_000_000;
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
    clock: () => now,
  });
  const store = persistence.core;
  const ilink = persistence.createIlinkStore({ clock: () => now });
  const secretBox = new IlinkSecretBox(Buffer.alloc(32, 31).toString('base64url'));
  const botId = 'image-recovery-bot@im.bot';
  const peerId = 'image-recovery-user@im.wechat';
  const accountKey = createIlinkAccountKey(botId);
  ilink.registerAccount({
    providerAccountId: botId,
    ownerPeerId: peerId,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    encryptedBotToken: secretBox.seal('image-recovery-token', {
      secretKind: 'bot_token', accountId: accountKey, peerId, generation: 1,
    }),
    now,
  });
  const normalized = normalizeIlinkInboundMessage({
    message_id: 91,
    seq: 91,
    from_user_id: peerId,
    to_user_id: botId,
    message_type: IlinkMessageType.USER,
    message_state: IlinkMessageState.FINISH,
    create_time_ms: now - 1_000,
    context_token: 'image-recovery-context',
    item_list: [{
      type: IlinkMessageItemType.TEXT,
      text_item: { text: '生成图片' },
    }],
  }, { accountKey, botId, ownerUserId: peerId }, { cursor: 'initial', index: 0 });
  assert.ok(normalized);
  const candidate = { ...normalized, sync: { cursor: '', index: 0 } };
  const page = ilink.commitPollPage({
    accountKey,
    expectedGeneration: 1,
    expectedCursor: '',
    nextCursor: 'image-recovery-cursor',
    messages: [{
      candidate,
      secretGeneration: 91,
      sealedContextToken: secretBox.seal(candidate.contextToken, {
        secretKind: 'context_token', accountId: accountKey, peerId, generation: 91,
      }),
    }],
  });
  const messageKey = page.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey });
  store.markInboundPreparing(messageKey, 'turn-ilink-image');
  store.setConversationThread({
    openKfId: accountKey,
    externalUserId: peerId,
    threadId: 'thread-ilink-image',
  });
  const session = store.createAgentSession({ messageKey });
  const png = Buffer.from('89504e470d0a1a0a0909090a', 'hex');
  const artifactRef = store.registerAgentArtifact({
    sessionToken: session.token,
    bytes: png,
    filename: 'ilink-recovered.png',
    contentType: 'image/png',
    metadata: {
      generationId: 'ilink-generation-recovered',
      revisedPrompt: 'preserve the subject and change only the background',
    },
  });
  let sends = 0;
  const executor = new IlinkSendExecutor({
    store,
    ilinkStore: ilink,
    secretBox,
    createClient: () => ({ async sendMessage() { sends += 1; } }),
    async uploadImage() {
      return {
        type: IlinkMessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: 'image-recovery-upload',
            aes_key: Buffer.alloc(16, 3).toString('base64'),
            encrypt_type: 1,
          },
          mid_size: png.length,
        },
      };
    },
  });
  const delivered = await executor.execute('send_image', {
    session: session.token,
    mediaRef: artifactRef,
  });
  assert.equal(delivered.status, 'accepted');
  assert.equal(sends, 1);
  assert.equal(store.getInbound(messageKey)?.status, 'preparing');

  let submissions = 0;
  const agent: AgentRuntime = {
    async ensureThread(_conversationId, threadId) { return threadId; },
    activePrimary() { return undefined; },
    async inspectHistory() {
      return {
        state: 'completed',
        turnId: 'turn-ilink-image',
        foundClientInputIds: new Set([messageKey]),
        artifacts: [{
          type: 'generated_image',
          bytes: png,
          filename: 'ilink-recovered.png',
          contentType: 'image/png',
          metadata: {
            generationId: 'ilink-generation-recovered',
            revisedPrompt: 'preserve the subject and change only the background',
          },
        }],
        executedAttemptIds: [delivered.attemptId],
      };
    },
    async submit() {
      submissions += 1;
      throw new Error('accepted iLink artifact must not be submitted again');
    },
    async close() {},
    async abort() {},
  };
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway: { async resolveForCodex() { return []; } },
    channel: { async kick() {} },
    logger: { info() {}, error() {} },
  });
  t.onTestFinished(async () => {
    await processor.close();
    await executor.waitForIdle();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await processor.recover(store.recoverStartup().inbound);
  await processor.waitForIdle();

  assert.equal(submissions, 0);
  assert.equal(sends, 1);
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
  assert.deepEqual(store.getAttempt(delivered.attemptId)?.metadata, {
    direction: store.getInbound(messageKey)?.inboxSeq,
    generationId: 'ilink-generation-recovered',
    replyWindowSendIndex: 0,
    revisedPrompt: 'preserve the subject and change only the background',
    tool: 'generated_image',
  });
});
