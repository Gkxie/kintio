import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConfig } from '../../src/config.js';
import { CodexAgent, createCodexAppServer } from '../../src/services/codex-agent.js';
import { ConversationProcessor } from '../../src/services/conversation-processor.js';
import { DeliveryService } from '../../src/services/delivery-service.js';
import { WecomMediaGateway } from '../../src/services/media-gateway.js';
import { OutboundPreparer } from '../../src/services/outbound-preparer.js';
import { WecomApiClient } from '../../src/services/wecom-api.js';
import { WecomSync } from '../../src/services/wecom-sync.js';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.js';
import { inspectAttempts } from '../support/sqlite-inspect.js';

process.loadEnvFile?.('.env');
const targetOpenKfId = process.env.LIVE_WECOM_OPEN_KFID || '';
const targetUserId = process.env.LIVE_WECOM_EXTERNAL_USER_ID || '';
const allowedTargets = new Set(
  String(process.env.LIVE_WECOM_ALLOWLIST || '').split(',').map((item) => item.trim()),
);
if (
  process.env.LIVE_WECOM_ACK !== 'SEND_REAL_MESSAGE' ||
  process.env.LIVE_SCENARIO !== 'text' ||
  !targetOpenKfId ||
  !targetUserId ||
  !allowedTargets.has(targetUserId)
) {
  throw new Error(
    'Live test requires explicit open_kfid, external_userid, allowlist, LIVE_SCENARIO=text, and LIVE_WECOM_ACK=SEND_REAL_MESSAGE',
  );
}

test('[I08][I09] mock upstream sends one accepted text through real Codex and real WeChat', { timeout: 180_000 }, async (t) => {
  process.stdout.write(
    `LIVE target=${targetUserId} open_kfid=${targetOpenKfId} estimated=1/5 types=text\n`,
  );
  const config = createConfig(process.env);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-live-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  let sendRequests = 0;
  const trackingFetch: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (new URL(requestUrl).pathname === '/cgi-bin/kf/send_msg') sendRequests += 1;
    return globalThis.fetch(input, init);
  };
  const apiClient = new WecomApiClient({
    corpId: config.wecom.api.corpId,
    kfSecret: config.wecom.api.kfSecret,
    timeoutMs: config.wecom.api.timeoutMs,
    fetchImpl: trackingFetch,
  });
  const mediaGateway = new WecomMediaGateway({ apiClient });
  const codex = createCodexAppServer({
    apiKey: config.codex.apiKey,
    baseUrl: config.codex.baseUrl,
    pathOverride: config.codex.pathOverride,
    webSearchMode: config.codex.webSearchMode,
  });
  const agent = new CodexAgent({
    codex,
    store,
    config: {
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
      sandboxMode: config.codex.sandboxMode,
      workingDirectory: config.codex.workingDirectory,
      imageTempDirectory: config.codex.imageTempDirectory,
      generatedImageDirectory: config.codex.generatedImageDirectory,
    },
  });
  const delivery = new DeliveryService({ apiClient, store });
  const preparer = new OutboundPreparer({
    mediaGateway,
    spoolDirectory: path.join(directory, 'spool'),
  });
  const processor = new ConversationProcessor({
    store,
    codexAgent: agent,
    mediaGateway,
    outboundPreparer: preparer,
    delivery,
    allowedUserIds: [targetUserId],
    authorization: config.wecom.authorization,
  });
  const sourceMessageId = `live-${Date.now()}`;
  let syncCalls = 0;
  const sync = new WecomSync({
    store,
    processor,
    apiClient: {
      async syncMessages(input) {
        syncCalls += 1;
        assert.deepEqual(input, {
          cursor: '', callbackToken: 'mock-listener-token', openKfId: targetOpenKfId,
        });
        return {
          next_cursor: 'mock-complete',
          has_more: 0,
          msg_list: [{
            msgid: sourceMessageId,
            open_kfid: targetOpenKfId,
            external_userid: targetUserId,
            origin: 3,
            msgtype: 'text',
            text: { content: '请只使用一条 send_text 简短回复：全链路测试成功。' },
          }],
        };
      },
    },
  });
  t.after(async () => {
    await sync.close();
    await processor.close();
    await delivery.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await sync.enqueue({
    callbackToken: 'mock-listener-token',
    openKfId: targetOpenKfId,
  });
  await processor.waitForIdle();
  await delivery.waitForIdle();
  const messageKey = stableMessageKey(targetOpenKfId, sourceMessageId);
  const attempts = inspectAttempts(store.database, messageKey);
  assert.equal(syncCalls, 1);
  assert.equal(attempts.length, 1, 'live test refuses split or fallback sends');
  assert.equal(attempts[0]?.type, 'text');
  const exactText = attempts[0]?.payload?.text as
    | { content?: unknown }
    | undefined;
  assert.ok(
    typeof exactText?.content === 'string' &&
      Buffer.byteLength(exactText.content, 'utf8') <= 2048,
  );
  const attempt = attempts[0];
  assert.ok(attempt);
  assert.equal(attempt.status, 'accepted');
  assert.equal(sendRequests, 1, 'live test refuses more than one real send_msg request');
  process.stdout.write(
    `LIVE actual=${sendRequests}/5 status=accepted (not proof of client display)\n`,
  );
});
