import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { CoreState } from '../state/sqlite-store.ts';
import { normalizeIlinkBaseUrl } from './protocol/client.ts';
import { IlinkSecretBox } from './secret-box.ts';
import {
  assertIlinkAccountKey,
  type IlinkAccountKey,
} from './store-types.ts';

const ILINK_LOGIN_TTL_MS = 5 * 60 * 1_000;
const MAX_TTL_MS = 10 * 60 * 1_000;
const TERMINAL_ACCOUNT_ID = 'local';
const TERMINAL_PEER_ID = 'operator';

type ActiveStatus = 'waiting' | 'scanned';
export type IlinkLoginResult =
  | 'confirmed'
  | 'expired'
  | 'failed'
  | 'cancelled'
  | 'already_connected'
  | 'verification_required';
export type IlinkLoginStatus = ActiveStatus | IlinkLoginResult | 'unknown';
export type IlinkLoginSource =
  | { readonly kind: 'wechat_kf'; readonly sessionToken: string }
  | { readonly kind: 'terminal' };
type IlinkLoginInitiator = 'local_operator' | 'remote_adapter';

interface ResolvedSource {
  readonly initiatorKind: IlinkLoginInitiator;
  readonly channel: IlinkLoginSource['kind'];
  readonly messageKey: string;
  readonly accountId: string;
  readonly peerId: string;
}

interface OfferRow {
  offer_id: string;
  initiator_kind: IlinkLoginInitiator;
  source_channel: IlinkLoginSource['kind'];
  source_message_key: string;
  source_account_id: string;
  source_peer_id: string;
  candidate_account_keys_json: string;
  secret_generation: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  api_base_url: string;
  status: ActiveStatus;
  expires_at: number;
  last_polled_at: number;
  created_at: number;
  updated_at: number;
}

export interface IlinkLoginOffer {
  readonly offerId: string;
  readonly initiatorKind: IlinkLoginInitiator;
  readonly apiBaseUrl: string;
  readonly status: ActiveStatus;
  readonly expiresAt: number;
  readonly lastPolledAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IlinkLoginRuntimeOffer extends IlinkLoginOffer {
  readonly qrCode: string;
  readonly candidateAccountKeys: readonly IlinkAccountKey[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secretGeneration(offerId: string): number {
  return Number.parseInt(sha256(offerId).slice(0, 12), 16);
}

function rowAs<T>(value: unknown): T | undefined {
  return value === undefined ? undefined : value as T;
}

function mapped(row: OfferRow): IlinkLoginOffer {
  return {
    offerId: row.offer_id,
    initiatorKind: row.initiator_kind,
    apiBaseUrl: row.api_base_url,
    status: row.status,
    expiresAt: Number(row.expires_at),
    lastPolledAt: Number(row.last_polled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** @internal Construct through StatePersistence outside persistence tests. */
interface IlinkLoginStoreInternalOptions {
  readonly store: Pick<CoreState, 'getAgentSession'>;
  readonly database: DatabaseSync;
  readonly secretBox: IlinkSecretBox;
  readonly clock?: () => number;
}

export class IlinkLoginStore {
  readonly #store: Pick<CoreState, 'getAgentSession'>;
  readonly #database: DatabaseSync;
  readonly #secrets: IlinkSecretBox;
  readonly #clock: () => number;

  constructor({
    store,
    database,
    secretBox,
    clock = Date.now,
  }: IlinkLoginStoreInternalOptions) {
    this.#store = store;
    this.#database = database;
    this.#secrets = secretBox;
    this.#clock = clock;
  }

  #transaction<T>(operation: () => T): T {
    if (this.#database.isTransaction) return operation();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #row(offerId: string): OfferRow | undefined {
    return rowAs<OfferRow>(this.#database.prepare(`
      SELECT * FROM ilink_login_offers WHERE offer_id = ?
    `).get(offerId));
  }

  #runtime(row: OfferRow): IlinkLoginRuntimeOffer {
    const candidates = JSON.parse(row.candidate_account_keys_json) as unknown;
    if (!Array.isArray(candidates) || candidates.length > 10) {
      throw new Error('Invalid iLink login candidate accounts');
    }
    for (const accountKey of candidates) {
      if (typeof accountKey !== 'string') {
        throw new Error('Invalid iLink login candidate account');
      }
      assertIlinkAccountKey(accountKey);
    }
    return {
      ...mapped(row),
      candidateAccountKeys: Object.freeze([...candidates]) as readonly IlinkAccountKey[],
      qrCode: this.#secrets.open({
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      }, {
        secretKind: 'qr_token',
        accountId: row.source_account_id,
        peerId: row.source_peer_id,
        generation: row.secret_generation,
      }),
    };
  }

  #source(source: IlinkLoginSource): ResolvedSource {
    if (source.kind === 'terminal') {
      return {
        initiatorKind: 'local_operator',
        channel: source.kind,
        messageKey: '',
        accountId: TERMINAL_ACCOUNT_ID,
        peerId: TERMINAL_PEER_ID,
      };
    }
    const session = this.#store.getAgentSession(source.sessionToken);
    if (session.channel !== 'wechat_kf') throw new Error('Wrong channel for iLink offer');
    return {
      initiatorKind: 'remote_adapter',
      channel: source.kind,
      messageKey: session.messageKey,
      accountId: session.accountKey,
      peerId: session.peerId,
    };
  }

  #expire(now = Number(this.#clock())): void {
    const expired = this.#database.prepare(`
      SELECT * FROM ilink_login_offers
      WHERE status IN ('waiting', 'scanned') AND expires_at <= ?
    `).all(now) as unknown as OfferRow[];
    for (const row of expired) this.#finishRow(row, 'expired', '', now);
  }

  #finishRow(
    row: OfferRow,
    result: IlinkLoginResult,
    accountKey: string,
    now: number,
  ): void {
    this.#database.prepare(`
      INSERT INTO ilink_enrollment_audit (
        offer_id, initiator_kind, source_channel, source_message_key,
        source_account_id, source_peer_id,
        account_key, result, offered_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(offer_id) DO NOTHING
    `).run(
      row.offer_id,
      row.initiator_kind,
      row.source_channel,
      row.source_message_key,
      row.source_account_id,
      row.source_peer_id,
      accountKey,
      result,
      row.created_at,
      now,
    );
    this.#database.prepare(`
      DELETE FROM ilink_login_offers WHERE offer_id = ?
    `).run(row.offer_id);
  }

  find(source: IlinkLoginSource): IlinkLoginOffer | undefined {
    const identity = this.#source(source);
    return this.#transaction(() => {
      this.#expire();
      const row = rowAs<OfferRow>(this.#database.prepare(`
        SELECT * FROM ilink_login_offers
        WHERE source_channel = ? AND source_account_id = ? AND source_peer_id = ?
          AND status IN ('waiting', 'scanned')
      `).get(identity.channel, identity.accountId, identity.peerId));
      return row ? mapped(row) : undefined;
    });
  }

  create({
    source,
    qrCode,
    apiBaseUrl,
    ttlMs = ILINK_LOGIN_TTL_MS,
    candidateAccountKeys = [],
  }: {
    source: IlinkLoginSource;
    qrCode: string;
    apiBaseUrl: string;
    ttlMs?: number;
    candidateAccountKeys?: readonly IlinkAccountKey[];
  }): IlinkLoginRuntimeOffer {
    const identity = this.#source(source);
    if (!qrCode || Buffer.byteLength(qrCode, 'utf8') > 8_192) {
      throw new Error('Invalid iLink QR token');
    }
    const lifetime = Math.max(1_000, Math.min(Number(ttlMs) || 0, MAX_TTL_MS));
    const offerId = `qo_${randomBytes(20).toString('base64url')}`;
    const generation = secretGeneration(offerId);
    if (candidateAccountKeys.length > 10) {
      throw new Error('Too many iLink login candidate accounts');
    }
    for (const accountKey of candidateAccountKeys) assertIlinkAccountKey(accountKey);
    const candidates = JSON.stringify([...new Set(candidateAccountKeys)]);
    const sealed = this.#secrets.seal(qrCode, {
      secretKind: 'qr_token',
      accountId: identity.accountId,
      peerId: identity.peerId,
      generation,
    });
    const now = Number(this.#clock());
    return this.#transaction(() => {
      this.#expire(now);
      const existing = this.#database.prepare(`
        SELECT 1 FROM ilink_login_offers
        WHERE source_channel = ? AND source_account_id = ? AND source_peer_id = ?
          AND status IN ('waiting', 'scanned')
      `).get(identity.channel, identity.accountId, identity.peerId);
      if (existing) throw new Error('An iLink login offer is already pending');
      this.#database.prepare(`
        INSERT INTO ilink_login_offers (
          offer_id, initiator_kind, source_channel, source_message_key,
          source_account_id, source_peer_id, secret_generation,
          candidate_account_keys_json, nonce, ciphertext, auth_tag,
          api_base_url, status,
          expires_at, last_polled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, 0, ?, ?)
      `).run(
        offerId,
        identity.initiatorKind,
        identity.channel,
        identity.messageKey,
        identity.accountId,
        identity.peerId,
        generation,
        candidates,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authTag,
        normalizeIlinkBaseUrl(apiBaseUrl),
        now + lifetime,
        now,
        now,
      );
      return this.#runtime(this.#row(offerId)!);
    });
  }

  listActive(): readonly IlinkLoginRuntimeOffer[] {
    return this.#transaction(() => {
      this.#expire();
      return (this.#database.prepare(`
        SELECT * FROM ilink_login_offers
        WHERE status IN ('waiting', 'scanned') ORDER BY created_at
      `).all() as unknown as OfferRow[]).map((row) => this.#runtime(row));
    });
  }

  isActive(offerId: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM ilink_login_offers
      WHERE offer_id = ? AND status IN ('waiting', 'scanned')
        AND expires_at > ?
    `).get(offerId, Number(this.#clock())));
  }

  status(offerId: string): { readonly status: IlinkLoginStatus } {
    return this.#transaction(() => {
      this.#expire();
      const active = this.#row(offerId);
      if (active) return { status: active.status };
      const audit = rowAs<{ result: IlinkLoginResult }>(this.#database.prepare(`
        SELECT result FROM ilink_enrollment_audit WHERE offer_id = ?
      `).get(offerId));
      return { status: audit?.result || 'unknown' };
    });
  }

  update(offerId: string, input: {
    readonly status: ActiveStatus;
    readonly apiBaseUrl?: string;
  }): IlinkLoginRuntimeOffer {
    const now = Number(this.#clock());
    return this.#transaction(() => {
      this.#expire(now);
      const current = this.#row(offerId);
      if (!current) throw new Error('Unknown or expired iLink login offer');
      this.#database.prepare(`
        UPDATE ilink_login_offers
        SET status = ?, api_base_url = ?, last_polled_at = ?, updated_at = ?
        WHERE offer_id = ? AND status IN ('waiting', 'scanned')
      `).run(
        input.status,
        input.apiBaseUrl
          ? normalizeIlinkBaseUrl(input.apiBaseUrl)
          : current.api_base_url,
        now,
        now,
        offerId,
      );
      return this.#runtime(this.#row(offerId)!);
    });
  }

  finish(
    offerId: string,
    result: IlinkLoginResult = 'cancelled',
    accountKey = '',
  ): boolean {
    return this.#transaction(() => {
      const row = this.#row(offerId);
      if (!row) return false;
      this.#finishRow(row, result, accountKey, Number(this.#clock()));
      return true;
    });
  }

  cleanup(auditMaxAgeMs = 30 * 24 * 60 * 60 * 1_000): number {
    const maximumAge = Math.max(1, Number(auditMaxAgeMs) || 0);
    return this.#transaction(() => {
      const now = Number(this.#clock());
      this.#expire(now);
      return Number(this.#database.prepare(`
        DELETE FROM ilink_enrollment_audit WHERE completed_at < ?
      `).run(now - maximumAge).changes);
    });
  }
}
