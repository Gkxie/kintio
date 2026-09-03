import { createHash } from 'node:crypto';

import type { ChatChannel } from '../types.ts';

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function requiredText(value: unknown, name: string): string {
  const text = String(value || '');
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function canonicalValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || Buffer.isBuffer(value)) {
    throw new Error(`Unsupported JSON value: ${typeof value}`);
  }
  const source = value as Record<string, unknown>;
  const output: JsonObject = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) output[key] = canonicalValue(source[key]);
  }
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function stableMessageKey(
  channel: ChatChannel,
  accountKey: string,
  providerMessageId: string,
): string {
  const selectedChannel = requiredText(channel, 'channel') as ChatChannel;
  if (!['wechat_kf', 'weixin_ilink'].includes(selectedChannel)) {
    throw new Error(`Unsupported chat channel: ${selectedChannel}`);
  }
  const service = requiredText(accountKey, 'accountKey');
  const message = requiredText(providerMessageId, 'providerMessageId');
  return `im_${sha256(`${selectedChannel}\0${service}\0${message}`).slice(0, 40)}`;
}

export function stableClientMessageId(
  messageKey: string,
  sendIndex: number,
): string {
  return `wb_${sha256(`${requiredText(messageKey, 'messageKey')}\0${sendIndex}`).slice(0, 29)}`;
}

export function stableAttemptKey(messageKey: string, sendIndex: number): string {
  return `sa_${sha256(`${requiredText(messageKey, 'messageKey')}\0${sendIndex}`).slice(0, 29)}`;
}
