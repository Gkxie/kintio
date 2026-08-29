export interface Logger {
  info(message: string): void;
  warn?(message: string): void;
  error(message: string): void;
}

export type ChatChannel = 'wechat_kf' | 'weixin_ilink';

interface ConversationRef {
  readonly channel: ChatChannel;
  readonly accountKey: string;
  readonly peerId: string;
}

export interface ImageAttachment {
  readonly kind: 'image';
  readonly mediaId: string;
  readonly filename?: string;
  readonly status?: 'unresolved';
}

export interface NormalizedMessage {
  readonly id: string;
  readonly messageKey?: string;
  readonly origin: string;
  readonly type: string;
  readonly rawType: string;
  readonly sentAt: number;
  readonly sync: { readonly cursor: string; readonly index: number };
  readonly conversation: ConversationRef;
  readonly text: string;
  readonly summary: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly attachments: readonly ImageAttachment[];
}

export interface ResolvedImage {
  readonly kind: 'image';
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface MediaCatalogEntry {
  readonly ref: string;
  readonly messageKey: string;
  readonly openKfId: string;
  readonly externalUserId: string;
  readonly kind: 'image';
  readonly mediaId: string;
  readonly filename: string;
  readonly sentAt: number;
  readonly rememberedAt: number;
}
