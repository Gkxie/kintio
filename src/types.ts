export interface Logger {
  info(message: string): void;
  warn?(message: string): void;
  error(message: string): void;
}

export interface ConversationRef {
  readonly openKfId: string;
  readonly externalUserId: string;
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
  readonly actor: { readonly servicerUserId: string };
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

export interface PreparedAttempt {
  readonly sendIndex: number;
  readonly source?: string;
  readonly sentType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly fallbackForIndex?: number;
  readonly status?: 'pending' | 'blocked';
}
