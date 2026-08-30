import type { NormalizedMessage } from '../types.ts';

export const MESSAGE_ORIGINS = {
  CUSTOMER: 'customer',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
} as const;

export const COMMON_MESSAGE_TYPES = {
  TEXT: 'text',
  EVENT: 'event',
  UNKNOWN: 'unknown',
} as const;

export function isProcessableCustomerMessage(
  message: Pick<NormalizedMessage, 'origin' | 'type'>,
): boolean {
  return message.origin === MESSAGE_ORIGINS.CUSTOMER &&
    Boolean(message.type.trim()) &&
    message.type !== COMMON_MESSAGE_TYPES.EVENT &&
    message.type !== COMMON_MESSAGE_TYPES.UNKNOWN;
}

export function isSystemEvent(
  message: Pick<NormalizedMessage, 'origin' | 'type'>,
): boolean {
  return message.origin === MESSAGE_ORIGINS.SYSTEM &&
    message.type === COMMON_MESSAGE_TYPES.EVENT;
}

export function renderMessageForAgent(
  message: Pick<NormalizedMessage, 'summary' | 'text'>,
): string {
  return String(
    message.summary || message.text || '[Channel message: no readable summary]',
  );
}
