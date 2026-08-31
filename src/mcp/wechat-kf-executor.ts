import {
  normalizeSendIntent,
  type SendIntent,
} from '../domain/send-contract.ts';
import {
  AgentSessionError,
  type AttemptRecord,
  type CoreState,
} from '../state/sqlite-store.ts';
import { WecomApiError, type WecomApiClient } from '../services/wecom-api.ts';
import type { WecomMediaGateway } from '../services/media-gateway.ts';
import type { Logger } from '../types.ts';

type JsonRecord = Record<string, unknown>;

interface WechatToolError {
  readonly kind: string;
  readonly message: string;
  readonly code?: string | number;
  readonly failType?: number;
}

interface IlinkOfferManager {
  offer(sessionToken: string): Promise<{ readonly offerId: string; readonly png: Buffer }>;
  cancel(offerId: string): void;
}

export interface WechatToolReceipt {
  readonly status: 'accepted' | 'failed' | 'uncertain';
  readonly attemptId: string;
  readonly sendIndex: number;
  readonly type: string;
  readonly msgid: string;
  readonly error?: WechatToolError;
}

type ExecutorStore = Pick<
  CoreState,
  | 'getAgentSession'
  | 'reserveAgentSend'
  | 'completeSend'
  | 'failSend'
  | 'markSendUncertain'
  | 'getAttempt'
  | 'beginNextSend'
  | 'getAgentArtifact'
>;

type ExecutorApi = Pick<WecomApiClient, 'sendPreparedMessage'>;
type ExecutorMedia = Pick<
  WecomMediaGateway,
  'upload' | 'cloneForSend' | 'getCardThumbnailMediaId'
>;

function exactPayload(message: SendIntent, mediaId = ''): JsonRecord {
  switch (message.type) {
    case 'text':
      return { msgtype: 'text', text: { content: message.content } };
    case 'image':
      return { msgtype: 'image', image: { media_id: mediaId } };
    case 'link':
      return {
        msgtype: 'link',
        link: {
          title: message.title,
          desc: message.description,
          url: message.url,
          thumb_media_id: mediaId,
        },
      };
    case 'miniprogram':
      return {
        msgtype: 'miniprogram',
        miniprogram: {
          appid: message.appId,
          title: message.title,
          pagepath: message.pagePath,
          thumb_media_id: mediaId,
        },
      };
    case 'location': {
      const { type, ...location } = message;
      return { msgtype: type, location };
    }
  }
}

function attemptError(attempt: AttemptRecord): WechatToolError | undefined {
  if (attempt.status === 'failed' && attempt.failType === 13) {
    return {
      kind: 'sensitive_content',
      message:
        'The channel rejected this message as potentially sensitive content. Do not send unlawful content; if the request is legitimate, revise the wording before deciding whether to try once more.',
      failType: 13,
    };
  }
  if (attempt.status === 'failed') {
    return {
      kind: 'wechat_delivery_failed',
      message: attempt.errorMessage || 'Channel message delivery failed',
      ...(attempt.errorCode ? { code: attempt.errorCode } : {}),
      ...(attempt.failType ? { failType: attempt.failType } : {}),
    };
  }
  if (attempt.status === 'uncertain') {
    return {
      kind: 'uncertain_result',
      message: attempt.errorMessage || 'Channel API result is uncertain',
      ...(attempt.errorCode ? { code: attempt.errorCode } : {}),
    };
  }
  return undefined;
}

function receipt(attempt: AttemptRecord): WechatToolReceipt {
  const status = attempt.status === 'failed'
    ? 'failed'
    : attempt.status === 'uncertain'
      ? 'uncertain'
      : 'accepted';
  const error = attemptError(attempt);
  return {
    status,
    attemptId: attempt.attemptId,
    sendIndex: attempt.sendIndex,
    type: attempt.type,
    msgid: attempt.wecomMsgId,
    ...(error ? { error } : {}),
  };
}

function definitive(error: unknown): boolean {
  return error instanceof WecomApiError && error.code !== undefined;
}

export class WechatKfToolExecutor {
  readonly #store: ExecutorStore;
  readonly #api: ExecutorApi;
  readonly #media: ExecutorMedia;
  readonly #observeMs: number;
  readonly #pollMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #logger: Logger;
  readonly #ilinkOffers: IlinkOfferManager | undefined;
  #draining: Promise<void> | undefined;
  #rerun = false;
  #closed = false;

  constructor({
    store,
    apiClient,
    mediaGateway,
    observeMs = 5_000,
    pollMs = 100,
    sleep = (milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    logger = console,
    ilinkOffers,
  }: {
    store: ExecutorStore;
    apiClient: ExecutorApi;
    mediaGateway: ExecutorMedia;
    observeMs?: number;
    pollMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    logger?: Logger;
    ilinkOffers?: IlinkOfferManager;
  }) {
    this.#store = store;
    this.#api = apiClient;
    this.#media = mediaGateway;
    this.#observeMs = Math.max(0, Math.min(Number(observeMs) || 0, 20_000));
    this.#pollMs = Math.max(10, Math.min(Number(pollMs) || 100, 1_000));
    this.#sleep = sleep;
    this.#logger = logger;
    this.#ilinkOffers = ilinkOffers;
  }

  async #payload(
    sessionToken: string,
    toolName: string,
    input: JsonRecord,
  ): Promise<{
    type: string;
    payload: JsonRecord;
    metadata?: JsonRecord;
  }> {
    const session = this.#store.getAgentSession(sessionToken);
    const artifactRef = String(input.mediaRef || '').startsWith('artifact:')
      ? [{ ref: String(input.mediaRef), kind: 'image' as const }]
      : [];
    const intent = normalizeSendIntent(toolName, input, {
      mediaCatalog: [
        ...session.mediaCatalog.map(({ ref, kind }) => ({ ref, kind })),
        ...artifactRef,
      ],
    });
    let mediaId = '';
    let metadata: JsonRecord | undefined;
    try {
      if (intent.type === 'image') {
        if (intent.mediaRef.startsWith('artifact:')) {
          const artifact = this.#store.getAgentArtifact(sessionToken, intent.mediaRef);
          metadata = artifact.metadata as JsonRecord | undefined;
          mediaId = (await this.#media.upload({
            kind: 'image',
            bytes: artifact.bytes,
            filename: artifact.filename,
            contentType: artifact.contentType,
          })).media_id;
        } else {
          const source = session.mediaCatalog.find((item) => item.ref === intent.mediaRef);
          if (!source) {
            throw new AgentSessionError(
              'The image reference is unavailable in this agent session',
              'invalid_media_reference',
            );
          }
          mediaId = await this.#media.cloneForSend({
            kind: 'image',
            sourceMediaId: source.mediaId,
            filename: source.filename,
          });
        }
      } else if (intent.type === 'link' || intent.type === 'miniprogram') {
        mediaId = await this.#media.getCardThumbnailMediaId();
      }
    } catch (error: unknown) {
      if (error instanceof AgentSessionError) throw error;
      throw new AgentSessionError(
        `Media preparation failed before send_msg was called: ${error instanceof Error ? error.message : String(error)}`,
        'media_preparation_failed',
      );
    }
    return {
      type: intent.type,
      payload: exactPayload(intent, mediaId),
      ...(metadata ? { metadata } : {}),
    };
  }

  async #observe(attemptId: string): Promise<AttemptRecord> {
    const deadline = Date.now() + this.#observeMs;
    let current = this.#store.getAttempt(attemptId);
    if (!current) throw new Error(`Missing WeChat attempt ${attemptId}`);
    while (current.status === 'accepted' && Date.now() < deadline) {
      await this.#sleep(Math.min(this.#pollMs, Math.max(1, deadline - Date.now())));
      current = this.#store.getAttempt(attemptId);
      if (!current) throw new Error(`Missing WeChat attempt ${attemptId}`);
    }
    return current;
  }

  async #transmit(
    attempt: AttemptRecord,
    observe: boolean,
  ): Promise<AttemptRecord> {
    let completed: AttemptRecord;
    try {
      if (!attempt.payload) throw new Error('Pending channel attempt has no payload');
      const result = await this.#api.sendPreparedMessage({
        toUser: attempt.externalUserId,
        openKfId: attempt.openKfId,
        payload: attempt.payload,
        messageId: attempt.clientMessageId,
      });
      const msgid = String(result.msgid || '');
      if (!msgid) throw new Error('The channel API accepted the request without returning msgid');
      completed = this.#store.completeSend(attempt.attemptId, {
        wecomMsgId: msgid,
      });
    } catch (error: unknown) {
      return definitive(error)
        ? this.#store.failSend(attempt.attemptId, error)
        : this.#store.markSendUncertain(attempt.attemptId, error);
    }
    return observe ? this.#observe(attempt.attemptId) : completed;
  }

  async #sendPrepared({
    sessionToken,
    type,
    payload,
    metadata,
  }: {
    sessionToken: string;
    type: string;
    payload: JsonRecord;
    metadata: JsonRecord;
  }): Promise<WechatToolReceipt> {
    const attempt = this.#store.reserveAgentSend({
      sessionToken,
      sentType: type,
      payload,
      metadata,
    });
    return receipt(await this.#transmit(attempt, true));
  }

  async execute(
    toolName: string,
    input: JsonRecord,
  ): Promise<WechatToolReceipt> {
    const sessionToken = String(input.session || '');
    const session = this.#store.getAgentSession(sessionToken);
    if (session.channel !== 'wechat_kf') {
      throw new AgentSessionError(
        'Agent session is bound to another channel',
        'wrong_channel',
      );
    }
    if (toolName === 'offer_weixin_bot_channel') {
      if (!this.#ilinkOffers) {
        throw new AgentSessionError(
          'iLink channel invitations are unavailable',
          'ilink_unavailable',
        );
      }
      const offered = await this.#ilinkOffers.offer(sessionToken);
      try {
        const uploaded = await this.#media.upload({
          kind: 'image',
          bytes: offered.png,
          filename: 'weixin-ilink-login.png',
          contentType: 'image/png',
        });
        const result = await this.#sendPrepared({
          sessionToken,
          type: 'image',
          payload: { msgtype: 'image', image: { media_id: uploaded.media_id } },
          metadata: { tool: toolName, offerId: offered.offerId },
        });
        if (result.status === 'failed') this.#ilinkOffers.cancel(offered.offerId);
        return result;
      } catch (error) {
        this.#ilinkOffers.cancel(offered.offerId);
        throw error;
      }
    }
    const { session: _session, ...argumentsWithoutSession } = input;
    const prepared = await this.#payload(
      sessionToken,
      toolName,
      argumentsWithoutSession,
    );
    return this.#sendPrepared({
      sessionToken,
      type: prepared.type,
      payload: prepared.payload,
      metadata: {
        ...(prepared.metadata || {}),
        tool: prepared.metadata ? 'generated_image' : toolName,
      },
    });
  }

  kick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#rerun = true;
    this.#draining ||= this.#runDrain().finally(() => {
      this.#draining = undefined;
      if (this.#rerun && !this.#closed) void this.kick();
    });
    return this.waitForIdle();
  }

  async #runDrain(): Promise<void> {
    do {
      this.#rerun = false;
      await this.#drain();
    } while (this.#rerun && !this.#closed);
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      const attempt = this.#store.beginNextSend();
      if (!attempt) return;
      const settled = await this.#transmit(attempt, false);
      if (settled.status === 'accepted') {
        this.#logger.info?.(
          `[wechat-kf-mcp] accepted type=${attempt.type} attempt=${attempt.attemptId}`,
        );
      } else if (settled.status === 'failed') {
        this.#logger.warn?.(`[wechat-kf-mcp] failed attempt=${attempt.attemptId}`);
      } else {
        this.#logger.error?.(`[wechat-kf-mcp] uncertain attempt=${attempt.attemptId}`);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.kick();
    this.#closed = true;
  }

  abort(): void {
    this.#closed = true;
    this.#rerun = false;
  }
}
