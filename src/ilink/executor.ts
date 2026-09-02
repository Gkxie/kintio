import { randomBytes } from 'node:crypto';

import type { IlinkToolExecutor, IlinkToolReceipt } from '../mcp/ilink-server.ts';
import type { AttemptRecord, CoreState } from '../state/sqlite-store.ts';
import {
  IlinkClient,
  IlinkProtocolError,
} from './protocol/client.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
  type IlinkMessage,
} from './protocol/types.ts';
import { IlinkSecretBox } from './secret-box.ts';
import {
  IlinkMediaError,
  uploadIlinkImageBuffer,
  type IlinkImageUploadClient,
} from './media.ts';
import type { IlinkMediaGateway } from './media-gateway.ts';
import {
  IlinkSqliteStore,
  IlinkSqliteStoreError,
} from './sqlite-store.ts';

type CoreStore = Pick<
  CoreState,
  | 'getAgentSession'
  | 'completeSend'
  | 'failSend'
  | 'markSendUncertain'
  | 'getAgentArtifact'
  | 'getAttempt'
>;

interface SendClient {
  sendMessage(request: Parameters<IlinkClient['sendMessage']>[0]): Promise<unknown>;
  getUploadUrl?: IlinkImageUploadClient['getUploadUrl'];
}

type ClientFactory = (input: {
  readonly token: string;
  readonly baseUrl: string;
}) => SendClient;
type UploadImage = typeof uploadIlinkImageBuffer;

interface DeliveryContext {
  readonly client: SendClient;
  readonly contextToken: string;
  readonly peerId: string;
}

function receipt(attempt: AttemptRecord, error?: {
  readonly kind: string;
  readonly message: string;
  readonly code?: string | number;
  readonly ret?: number;
}): IlinkToolReceipt {
  return {
    status: attempt.status === 'failed'
      ? 'failed'
      : attempt.status === 'uncertain' ? 'uncertain' : 'accepted',
    attemptId: attempt.attemptId,
    sendIndex: attempt.sendIndex,
    type: attempt.type === 'image' ? 'image' : 'text',
    providerMessageId: attempt.providerMessageId,
    ...(error ? { error } : {}),
  };
}

function preflightError(
  error: unknown,
  forcedKind?: string,
) {
  const code = error instanceof IlinkSqliteStoreError ? error.code : '';
  const kind = forcedKind || (code === 'reply_window_expired'
    ? 'reply_window_expired'
    : code === 'reply_quota_exhausted'
      ? 'reply_quota_exhausted'
      : 'ilink_session_invalid');
  return { kind, message: 'iLink send precondition failed' };
}

function preflightFailure(
  error: unknown,
  type: 'text' | 'image' = 'text',
  forcedKind?: string,
): IlinkToolReceipt {
  return {
    status: 'failed',
    attemptId: '',
    sendIndex: -1,
    type,
    providerMessageId: '',
    error: preflightError(error, forcedKind),
  };
}

function definitive(error: unknown): boolean {
  return error instanceof IlinkProtocolError && (
    error.kind === 'business' ||
    (error.kind === 'http' && Number(error.status || 0) >= 400 &&
      Number(error.status || 0) < 500)
  );
}

function deliveryError(error: unknown, uncertain: boolean) {
  const protocol = error instanceof IlinkProtocolError ? error : undefined;
  return {
    kind: uncertain ? 'uncertain_result' : 'ilink_delivery_failed',
    message: uncertain
      ? 'The iLink delivery outcome is uncertain'
      : 'iLink rejected the message',
    ...(protocol?.ret !== undefined ? { ret: protocol.ret } : {}),
    ...(protocol?.status !== undefined ? { code: protocol.status } : {}),
  };
}

export class IlinkSendExecutor implements IlinkToolExecutor {
  readonly #store: CoreStore;
  readonly #ilink: IlinkSqliteStore;
  readonly #secrets: IlinkSecretBox;
  readonly #createClient: ClientFactory;
  readonly #media: Pick<IlinkMediaGateway, 'resolveReference'> | undefined;
  readonly #uploadImage: UploadImage;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor({
    store,
    ilinkStore,
    secretBox,
    createClient = ({ token, baseUrl }) => new IlinkClient({ token, baseUrl }),
    mediaGateway,
    uploadImage = uploadIlinkImageBuffer,
  }: {
    store: CoreStore;
    ilinkStore: IlinkSqliteStore;
    secretBox: IlinkSecretBox;
    createClient?: ClientFactory;
    mediaGateway?: Pick<IlinkMediaGateway, 'resolveReference'>;
    uploadImage?: UploadImage;
  }) {
    this.#store = store;
    this.#ilink = ilinkStore;
    this.#secrets = secretBox;
    this.#createClient = createClient;
    this.#media = mediaGateway;
    this.#uploadImage = uploadImage;
  }

  #serialize<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(accountKey) || Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.#queues.set(accountKey, task);
    void task.finally(() => {
      if (this.#queues.get(accountKey) === task) this.#queues.delete(accountKey);
    }).catch(() => undefined);
    return task;
  }

  #releasePending(
    attemptId: string,
    error: unknown,
    type: 'text' | 'image',
    forcedKind?: string,
  ): IlinkToolReceipt {
    this.#ilink.releasePendingAttempt(
      attemptId,
      error instanceof IlinkSqliteStoreError &&
        error.code === 'reply_window_expired'
        ? 'reply_window_expired'
        : undefined,
    );
    const failed = this.#store.getAttempt(attemptId);
    return failed
      ? receipt(failed, preflightError(error, forcedKind))
      : preflightFailure(error, type, forcedKind);
  }

  async execute(
    tool: 'send_text' | 'send_image',
    input: {
      readonly session: string;
      readonly content?: string;
      readonly mediaRef?: string;
    },
  ): Promise<IlinkToolReceipt> {
    if (tool !== 'send_text' && tool !== 'send_image') {
      return preflightFailure(new Error('unsupported tool'));
    }
    let accountKey: string;
    try {
      const session = this.#store.getAgentSession(input.session);
      if (session.channel !== 'weixin_ilink') {
        return preflightFailure(new Error('wrong channel'));
      }
      accountKey = session.accountKey;
    } catch (error: unknown) {
      return preflightFailure(error);
    }
    return this.#serialize(accountKey, () =>
      tool === 'send_image' ? this.#executeImage(input) : this.#executeText(input),
    );
  }

  async #executeText(
    input: { readonly session: string; readonly content?: string },
  ): Promise<IlinkToolReceipt> {
    let pendingAttemptId = '';
    try {
      if (typeof input.content !== 'string' || !input.content) {
        return preflightFailure(new Error('missing text'));
      }
      const session = this.#store.getAgentSession(input.session);
      if (session.channel !== 'weixin_ilink' || !session.replyWindowId) {
        return preflightFailure(new Error('wrong channel'));
      }
      const clientId = `il_${randomBytes(16).toString('base64url')}`;
      const prepared = this.#ilink.prepareReplyAttempt({
        sessionToken: input.session,
        sentType: 'text',
        payload: { content: input.content, clientId },
        metadata: { tool: 'send_text' },
      });
      if (prepared.kind === 'rejected') {
        return receipt(prepared.attempt, preflightError(undefined, prepared.code));
      }
      pendingAttemptId = prepared.attempt.attemptId;
      const delivery = this.#deliveryContext(session.replyWindowId);
      const attempt = this.#ilink.startReplyAttempt({
        sessionToken: input.session,
        attemptId: pendingAttemptId,
      });
      return this.#transmit(attempt, delivery, {
        type: IlinkMessageItemType.TEXT,
        text_item: { text: input.content },
      }, clientId);
    } catch (error: unknown) {
      return pendingAttemptId
        ? this.#releasePending(pendingAttemptId, error, 'text')
        : preflightFailure(error);
    }
  }

  async #executeImage(
    input: { readonly session: string; readonly mediaRef?: string },
  ): Promise<IlinkToolReceipt> {
    let pendingAttemptId = '';
    try {
      const session = this.#store.getAgentSession(input.session);
      if (
        session.channel !== 'weixin_ilink' || !session.replyWindowId ||
        typeof input.mediaRef !== 'string'
      ) {
        return preflightFailure(new Error('invalid image session'), 'image');
      }
      let artifact: ReturnType<CoreStore['getAgentArtifact']> | undefined;
      if (input.mediaRef.startsWith('artifact:')) {
        try {
          artifact = this.#store.getAgentArtifact(input.session, input.mediaRef);
        } catch (error: unknown) {
          return preflightFailure(error, 'image', 'invalid_media_reference');
        }
      }
      const clientId = `il_${randomBytes(16).toString('base64url')}`;
      const prepared = this.#ilink.prepareReplyAttempt({
        sessionToken: input.session,
        sentType: 'image',
        payload: { mediaRef: input.mediaRef, clientId },
        metadata: artifact
          ? { ...(artifact.metadata || {}), tool: 'generated_image' }
          : { tool: 'send_image' },
      });
      if (prepared.kind === 'rejected') {
        return receipt(prepared.attempt, preflightError(undefined, prepared.code));
      }
      pendingAttemptId = prepared.attempt.attemptId;
      const delivery = this.#deliveryContext(session.replyWindowId);
      let bytes: Buffer;
      try {
        if (artifact) {
          bytes = artifact.bytes;
        } else {
          const source = session.mediaCatalog.find((item) => item.ref === input.mediaRef);
          if (!source || !this.#media) {
            return this.#releasePending(
              pendingAttemptId,
              new Error('image reference unavailable'),
              'image',
              'invalid_media_reference',
            );
          }
          bytes = (await this.#media.resolveReference({
            messageKey: source.messageKey,
            mediaId: source.mediaId,
          })).bytes;
        }
      } catch (error: unknown) {
        return this.#releasePending(
          pendingAttemptId,
          error,
          'image',
          input.mediaRef.startsWith('artifact:')
            ? 'invalid_media_reference'
            : 'media_prepare_failed',
        );
      }
      let imageItem: Awaited<ReturnType<typeof uploadIlinkImageBuffer>>;
      try {
        this.#ilink.validatePendingReplyAttempt({
          sessionToken: input.session,
          attemptId: pendingAttemptId,
        });
        imageItem = await this.#uploadImage({
          bytes,
          peerId: delivery.peerId,
          client: delivery.client as IlinkImageUploadClient,
        });
        this.#store.getAgentSession(input.session);
        const attempt = this.#ilink.startReplyAttempt({
          sessionToken: input.session,
          attemptId: pendingAttemptId,
        });
        return this.#transmit(attempt, delivery, imageItem, clientId);
      } catch (error: unknown) {
        return this.#releasePending(
          pendingAttemptId,
          error,
          'image',
          error instanceof IlinkMediaError ? 'media_prepare_failed' : undefined,
        );
      }
    } catch (error: unknown) {
      return pendingAttemptId
        ? this.#releasePending(pendingAttemptId, error, 'image')
        : preflightFailure(error, 'image');
    }
  }

  #deliveryContext(replyWindowId: number): DeliveryContext {
    const window = this.#ilink.getReplyWindowSecret(replyWindowId);
    const accountWithSecret = window
      ? this.#ilink.getAccountWithSecret(window.accountKey)
      : undefined;
    if (
      !accountWithSecret || !window ||
      window.peerId !== accountWithSecret.account.ownerPeerId
    ) {
      throw new Error('Missing bound iLink delivery state');
    }
    const botToken = this.#secrets.open(accountWithSecret.secret.sealedBotToken, {
      secretKind: 'bot_token',
      accountId: accountWithSecret.account.accountKey,
      peerId: accountWithSecret.account.ownerPeerId,
      generation: accountWithSecret.account.generation,
    });
    const contextToken = this.#secrets.open(window.sealedContextToken, {
      secretKind: 'context_token',
      accountId: window.accountKey,
      peerId: window.peerId,
      generation: window.secretGeneration,
    });
    return {
      client: this.#createClient({
        token: botToken,
        baseUrl: accountWithSecret.account.baseUrl,
      }),
      contextToken,
      peerId: window.peerId,
    };
  }

  async #transmit(
    attempt: AttemptRecord,
    delivery: DeliveryContext,
    item: NonNullable<IlinkMessage['item_list']>[number],
    clientId: string,
  ): Promise<IlinkToolReceipt> {
    try {
      await delivery.client.sendMessage({
        msg: {
          from_user_id: '',
          to_user_id: delivery.peerId,
          client_id: clientId,
          message_type: IlinkMessageType.BOT,
          message_state: IlinkMessageState.FINISH,
          context_token: delivery.contextToken,
          item_list: [item],
        },
      });
    } catch (error: unknown) {
      if (definitive(error)) {
        const failed = this.#store.failSend(attempt.attemptId, error);
        return receipt(failed, deliveryError(error, false));
      }
      const uncertain = this.#store.markSendUncertain(attempt.attemptId, error);
      return receipt(uncertain, deliveryError(error, true));
    }
    const accepted = this.#store.completeSend(attempt.attemptId, {
      providerMessageId: clientId,
    });
    return receipt(accepted);
  }

  async notifyQueued(
    messageKey: string,
    content = 'Your conversation is queued. Please wait.',
  ): Promise<void> {
    const window = this.#ilink.getReplyWindowSecretBySource(messageKey);
    if (!window) throw new Error('iLink queue notice has no reply window');
    await this.#serialize(window.accountKey, async () => {
      const delivery = this.#deliveryContext(window.replyWindowId);
      const clientId = `il_${randomBytes(16).toString('base64url')}`;
      const attempt = this.#ilink.reserveStartedSystemAttempt({
        messageKey,
        sentType: 'text',
        source: 'queue_notice',
        payload: { content, clientId },
        metadata: { tool: 'queue_notice' },
      });
      const result = await this.#transmit(attempt, delivery, {
        type: IlinkMessageItemType.TEXT,
        text_item: { text: content },
      }, clientId);
      if (result.status === 'failed') throw new Error('iLink queue notice failed');
    });
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
  }

  isIdle(): boolean {
    return this.#queues.size === 0;
  }
}
