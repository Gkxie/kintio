import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const SENT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_MEDIA_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SENT_MESSAGE_RECORDS = 10_000;
const MAX_INBOUND_MEDIA_PER_CONVERSATION = 50;

function createEmptyState() {
  return {
    version: STATE_VERSION,
    cursors: {},
    threads: {},
    messages: {},
    sessions: {},
    inboundMedia: {},
    customerAuthorizations: {},
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class JsonStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = null;
    this.lock = Promise.resolve();
  }

  async #runExclusive(operation) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      await this.#load();
      return await operation(this.state);
    } finally {
      release();
    }
  }

  async #load() {
    if (this.state) {
      return;
    }

    try {
      const contents = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(contents);

      if (parsed.version !== STATE_VERSION) {
        throw new Error(`Unsupported state version: ${parsed.version}`);
      }

      this.state = {
        ...createEmptyState(),
        ...parsed,
        cursors: parsed.cursors || {},
        threads: parsed.threads || {},
        messages: parsed.messages || {},
        sessions: parsed.sessions || {},
        inboundMedia: parsed.inboundMedia || {},
        customerAuthorizations: parsed.customerAuthorizations || {},
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.state = createEmptyState();
        return;
      }

      throw new Error(`Unable to load state file: ${error.message}`);
    }
  }

  #cleanupMessageRecords() {
    const cutoff = Date.now() - SENT_MESSAGE_TTL_MS;
    const completedEntries = Object.entries(this.state.messages)
      .filter(([, record]) =>
        ['sent', 'ignored', 'absorbed', 'failed'].includes(record.status),
      )
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt);

    for (const [messageId, record] of completedEntries) {
      if (record.updatedAt < cutoff) {
        delete this.state.messages[messageId];
      }
    }

    for (const [messageId] of completedEntries.slice(MAX_SENT_MESSAGE_RECORDS)) {
      delete this.state.messages[messageId];
    }
  }

  #cleanupInboundMedia() {
    const cutoff = Date.now() - INBOUND_MEDIA_TTL_MS;

    for (const [conversationKey, entries] of Object.entries(
      this.state.inboundMedia,
    )) {
      const retained = (Array.isArray(entries) ? entries : [])
        .filter((entry) => Number(entry.rememberedAt || 0) >= cutoff)
        .sort((left, right) => right.rememberedAt - left.rememberedAt)
        .slice(0, MAX_INBOUND_MEDIA_PER_CONVERSATION);

      if (retained.length) {
        this.state.inboundMedia[conversationKey] = retained;
      } else {
        delete this.state.inboundMedia[conversationKey];
      }
    }
  }

  async #save() {
    this.#cleanupMessageRecords();
    this.#cleanupInboundMedia();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const contents = `${JSON.stringify(this.state, null, 2)}\n`;

    await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async getCursor(openKfId) {
    return this.#runExclusive((state) => state.cursors[openKfId] || '');
  }

  async setCursor(openKfId, cursor) {
    return this.#runExclusive(async (state) => {
      state.cursors[openKfId] = cursor;
      await this.#save();
    });
  }

  async getThreadId(threadKey) {
    return this.#runExclusive((state) => state.threads[threadKey] || '');
  }

  async setThreadId(threadKey, threadId) {
    return this.#runExclusive(async (state) => {
      state.threads[threadKey] = threadId;
      await this.#save();
    });
  }

  async getSession(sessionKey) {
    return this.#runExclusive((state) => clone(state.sessions[sessionKey]));
  }

  async setSession(sessionKey, session) {
    return this.#runExclusive(async (state) => {
      state.sessions[sessionKey] = {
        ...session,
        updatedAt: Date.now(),
      };
      await this.#save();
      return clone(state.sessions[sessionKey]);
    });
  }

  async getCustomerAuthorization(externalUserId) {
    return this.#runExclusive((state) =>
      clone(state.customerAuthorizations[externalUserId]),
    );
  }

  async evaluateCustomerAuthorization({
    openKfId,
    externalUserId,
    messageId,
    isTrigger,
    requiredConsecutive = 3,
  }) {
    return this.#runExclusive(async (state) => {
      const existingMessage = state.messages[messageId];
      const current = state.customerAuthorizations[externalUserId] || {};

      if (
        existingMessage?.status === 'ignored' &&
        existingMessage.ignoreReason === 'unauthorized'
      ) {
        return {
          allowed: false,
          duplicate: true,
          newlyAuthorized: false,
          consecutiveMatches: Number(current.consecutiveMatches || 0),
        };
      }

      if (current.authorized === true) {
        return {
          allowed: true,
          duplicate: false,
          newlyAuthorized: false,
          consecutiveMatches: Number(current.consecutiveMatches || 0),
        };
      }

      const threshold = Math.max(1, Number(requiredConsecutive) || 3);
      const sameCustomerService =
        !current.openKfId || current.openKfId === openKfId;
      const consecutiveMatches = isTrigger
        ? (sameCustomerService ? Number(current.consecutiveMatches || 0) : 0) +
          1
        : 0;
      const newlyAuthorized = consecutiveMatches >= threshold;
      const now = Date.now();

      state.customerAuthorizations[externalUserId] = {
        authorized: newlyAuthorized,
        consecutiveMatches,
        openKfId,
        lastMessageId: messageId,
        authorizedAt: newlyAuthorized ? now : 0,
        updatedAt: now,
      };
      state.messages[messageId] = {
        openKfId,
        externalUserId,
        status: newlyAuthorized ? 'authorization_pending' : 'ignored',
        ignoreReason: 'unauthorized',
        sentChunks: 0,
        updatedAt: now,
      };
      await this.#save();

      return {
        allowed: false,
        duplicate: false,
        newlyAuthorized,
        consecutiveMatches,
      };
    });
  }

  async getMessage(messageId) {
    return this.#runExclusive((state) => clone(state.messages[messageId]));
  }

  async getPendingCodexMessages() {
    return this.#runExclusive((state) =>
      clone(
        Object.entries(state.messages)
          .filter(
            ([, record]) =>
              ['processing', 'steered'].includes(record.status) &&
              record.inboundMessage,
          )
          .map(([messageId, record]) => ({ messageId, ...record }))
          .sort(
            (left, right) =>
              Number(left.inboundMessage?.sentAt || left.updatedAt || 0) -
              Number(right.inboundMessage?.sentAt || right.updatedAt || 0),
          ),
      ),
    );
  }

  async setProcessingMessage(messageId, record) {
    return this.#runExclusive(async (state) => {
      const existing = state.messages[messageId];
      if (['sent', 'ignored', 'absorbed'].includes(existing?.status)) {
        return clone(existing);
      }
      state.messages[messageId] = {
        ...record,
        status: 'processing',
        sentChunks: existing?.sentChunks || 0,
        updatedAt: Date.now(),
      };
      await this.#save();
      return clone(state.messages[messageId]);
    });
  }

  async setSteeredMessage(messageId, record) {
    return this.#runExclusive(async (state) => {
      const primary = state.messages[record.primaryMessageId];
      state.messages[messageId] = {
        ...record,
        status: primary?.status === 'sent' ? 'absorbed' : 'steered',
        updatedAt: Date.now(),
      };
      await this.#save();
      return clone(state.messages[messageId]);
    });
  }

  async markSteeredMessagesAbsorbed(primaryMessageId) {
    return this.#runExclusive(async (state) => {
      let changed = false;
      for (const record of Object.values(state.messages)) {
        if (
          record.status === 'steered' &&
          record.primaryMessageId === primaryMessageId
        ) {
          record.status = 'absorbed';
          record.updatedAt = Date.now();
          changed = true;
        }
      }
      if (changed) await this.#save();
    });
  }

  async markProcessingFailed(messageId, error) {
    return this.#runExclusive(async (state) => {
      const record = state.messages[messageId];
      if (!record || record.status === 'sent') return clone(record);
      record.status = 'failed';
      record.errorMessage = String(error?.message || error || 'unknown error');
      record.updatedAt = Date.now();
      for (const candidate of Object.values(state.messages)) {
        if (
          candidate.status === 'steered' &&
          candidate.primaryMessageId === messageId
        ) {
          candidate.status = 'failed';
          candidate.errorMessage = record.errorMessage;
          candidate.updatedAt = record.updatedAt;
        }
      }
      await this.#save();
      return clone(record);
    });
  }

  async getRecentOutboundMessages({
    openKfId,
    externalUserId,
    limit = 20,
  }) {
    return this.#runExclusive((state) => {
      const messages = Object.values(state.messages)
        .filter(
          (record) =>
            record.status === 'sent' &&
            record.openKfId === openKfId &&
            record.externalUserId === externalUserId,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .flatMap((record) => record.outboundMessages || [])
        .slice(0, Math.max(0, Math.min(Number(limit) || 0, 100)));

      return clone(messages);
    });
  }

  async getLatestGeneratedImageDelivery({ openKfId, externalUserId }) {
    return this.#runExclusive((state) => {
      const record = Object.values(state.messages)
        .filter(
          (candidate) =>
            candidate.status === 'sent' &&
            candidate.deliveryStatus !== 'failed' &&
            candidate.openKfId === openKfId &&
            candidate.externalUserId === externalUserId &&
            (candidate.toolDispatches || []).some(
              (dispatch) => dispatch.tool === 'send_generated_image',
            ),
        )
        .sort(
          (left, right) =>
            Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
        )[0];
      if (!record) return undefined;
      const dispatch = record.toolDispatches.find(
        (item) => item.tool === 'send_generated_image',
      );
      const receipt = (record.sendReceipts || []).find(
        (item) => item.sentType === 'image',
      );
      return clone({
        delivered: ['accepted', 'uncertain'].includes(receipt?.status),
        revisedPrompt: String(dispatch?.arguments?.revisedPrompt || ''),
        byteLength: Number(dispatch?.arguments?.byteLength || 0),
        updatedAt: Number(record.updatedAt || 0),
      });
    });
  }

  async rememberInboundAttachments({
    openKfId,
    externalUserId,
    messageId,
    sentAt = 0,
    attachments = [],
  }) {
    return this.#runExclusive(async (state) => {
      const conversationKey = `${openKfId}:${externalUserId}`;
      const existing = Array.isArray(state.inboundMedia[conversationKey])
        ? state.inboundMedia[conversationKey]
        : [];
      const withoutMessage = existing.filter(
        (entry) => entry.messageId !== messageId,
      );
      const rememberedAt = Date.now();
      const added = attachments
        .map((attachment, index) => ({
          id: `${messageId}:${index}`,
          messageId: String(messageId || ''),
          kind: String(attachment?.kind || ''),
          mediaId: String(attachment?.mediaId || ''),
          filename: String(attachment?.filename || ''),
          sentAt: Number(sentAt || 0),
          rememberedAt,
        }))
        .filter(
          (entry) => entry.messageId && entry.kind && entry.mediaId,
        );

      state.inboundMedia[conversationKey] = [...added, ...withoutMessage].slice(
        0,
        MAX_INBOUND_MEDIA_PER_CONVERSATION,
      );
      await this.#save();
      return clone(added);
    });
  }

  async getRecentInboundAttachments({
    openKfId,
    externalUserId,
    limit = 10,
  }) {
    return this.#runExclusive((state) => {
      const conversationKey = `${openKfId}:${externalUserId}`;
      const cutoff = Date.now() - INBOUND_MEDIA_TTL_MS;
      return clone(
        (state.inboundMedia[conversationKey] || [])
          .filter((entry) => Number(entry.rememberedAt || 0) >= cutoff)
          .sort((left, right) => right.rememberedAt - left.rememberedAt)
          .slice(0, Math.max(0, Math.min(Number(limit) || 0, 20))),
      );
    });
  }

  async setGeneratedMessage(messageId, record) {
    return this.#runExclusive(async (state) => {
      const existing = state.messages[messageId];

      if (existing?.status === 'sent') {
        return clone(existing);
      }

      state.messages[messageId] = {
        ...record,
        status: 'generated',
        sentChunks: existing?.sentChunks || 0,
        updatedAt: Date.now(),
      };
      await this.#save();
      return clone(state.messages[messageId]);
    });
  }

  async markChunkSent(messageId, sentChunks, receipt = undefined) {
    return this.#runExclusive(async (state) => {
      const record = state.messages[messageId];

      if (!record) {
        throw new Error(`Unknown message record: ${messageId}`);
      }

      record.sentChunks = sentChunks;
      if (receipt?.wecomMsgId) {
        record.sendReceipts ||= [];
        record.sendReceipts[sentChunks - 1] = {
          wecomMsgId: String(receipt.wecomMsgId),
          sentType: String(receipt.sentType || ''),
          status: 'accepted',
          acceptedAt: Date.now(),
        };
      }
      record.updatedAt = Date.now();
      await this.#save();
      return clone(record);
    });
  }

  async markMessageSent(messageId) {
    return this.#runExclusive(async (state) => {
      const record = state.messages[messageId];

      if (!record) {
        throw new Error(`Unknown message record: ${messageId}`);
      }

      record.status = 'sent';
      const receiptStatuses = (record.sendReceipts || []).map(
        (receipt) => receipt?.status,
      );
      record.deliveryStatus = receiptStatuses.includes('failed')
        ? 'failed'
        : receiptStatuses.includes('uncertain')
          ? 'uncertain'
          : 'accepted';
      record.updatedAt = Date.now();
      await this.#save();
      return clone(record);
    });
  }

  async markOutboundFailed({ wecomMsgId, failType }) {
    return this.#runExclusive(async (state) => {
      for (const record of Object.values(state.messages)) {
        const receipt = (record.sendReceipts || []).find(
          (item) => item?.wecomMsgId === wecomMsgId,
        );

        if (!receipt) continue;

        receipt.status = 'failed';
        receipt.failType = Number(failType || 0);
        receipt.failedAt = Date.now();
        record.deliveryStatus = 'failed';
        record.updatedAt = Date.now();
        await this.#save();
        return true;
      }

      return false;
    });
  }
}
