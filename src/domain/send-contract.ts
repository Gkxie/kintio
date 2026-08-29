import { isIP } from 'node:net';

const SEND_TYPES = [
  'text',
  'image',
  'link',
  'miniprogram',
  'location',
] as const;
type SendType = (typeof SEND_TYPES)[number];

export const SEND_TOOL_NAMES = [
  'send_text',
  'send_image',
  'send_link',
  'send_miniprogram',
  'send_location',
] as const;

export interface MediaCapability {
  readonly ref: string;
  readonly kind: 'image';
}

export type SendIntent =
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'image'; readonly mediaRef: string }
  | {
      readonly type: 'link';
      readonly title: string;
      readonly description: string;
      readonly url: string;
    }
  | {
      readonly type: 'miniprogram';
      readonly appId: string;
      readonly title: string;
      readonly pagePath: string;
      readonly sourceUrl: string;
    }
  | {
      readonly type: 'location';
      readonly name: string;
      readonly address: string;
      readonly latitude: number;
      readonly longitude: number;
    };

type SendInput = Record<string, unknown> | undefined;

const TOOL_TYPES = new Map<string, SendType>(
  SEND_TOOL_NAMES.map((name, index) => [name, SEND_TYPES[index]!]),
);
const MEDIA_REFERENCE = /^(?:media|artifact):(?:0|[1-9]\d?)$/u;
const MAX_TEXT_BYTES = 2048;

export class SendContractError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid_send_intent') {
    super(message);
    this.name = 'SendContractError';
    this.code = code;
  }
}

function fail(message: string, code?: string): never {
  throw new SendContractError(message, code);
}

function requiredText(value: unknown, label: string, maxBytes: number): string {
  const result = String(value ?? '').trim();
  if (!result) fail(`${label} cannot be empty`);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    fail(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return result;
}

function optionalText(value: unknown, label: string, maxBytes: number): string {
  const result = String(value ?? '').trim();
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    fail(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return result;
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) {
    return false;
  }
  const a = octets[0]!;
  const b = octets[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function privateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === '::' || normalized === '::1') return true;
  if (/^(?:fc|fd|fe[89ab])/u.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return true;
  const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped?.[1] ? privateIpv4(mapped[1]) : false;
}

function publicHttpUrl(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail(`${label} must be a valid public HTTP(S) URL`);
  }

  const hostname = url.hostname.toLowerCase();
  const ipVersion = isIP(hostname.replace(/^\[|\]$/gu, ''));
  const forbiddenName =
    !ipVersion &&
    (!hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal'));

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    forbiddenName ||
    (ipVersion === 4 && privateIpv4(hostname)) ||
    (ipVersion === 6 && privateIpv6(hostname))
  ) {
    fail(`${label} must be a valid public HTTP(S) URL`);
  }
  if (Buffer.byteLength(url.toString(), 'utf8') > 2048) {
    fail(`${label} exceeds 2048 UTF-8 bytes`);
  }
  return url.toString();
}

export function normalizeMediaCatalog(
  mediaCatalog: unknown = [],
): readonly MediaCapability[] {
  if (!Array.isArray(mediaCatalog) || mediaCatalog.length > 100) {
    fail('Media catalog must contain at most 100 entries', 'invalid_media_catalog');
  }

  const seen = new Set<string>();
  return Object.freeze(
    mediaCatalog.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('Media catalog entries must be objects', 'invalid_media_catalog');
      }
      const record = item as Record<string, unknown>;
      const extra = Object.keys(record).filter(
        (key) => !['ref', 'kind'].includes(key),
      );
      if (extra.length) {
        fail(
          `Media catalog must not expose ${extra.join(', ')}`,
          'unsafe_media_catalog',
        );
      }
      const ref = String(record.ref || '');
      const kind = String(record.kind || '');
      if (!MEDIA_REFERENCE.test(ref) || kind !== 'image' || seen.has(ref)) {
        fail('Media catalog requires unique media:N image references', 'invalid_media_catalog');
      }
      seen.add(ref);
      return Object.freeze({ ref, kind: 'image' as const });
    }),
  );
}

function normalizeText(input: SendInput): Extract<SendIntent, { type: 'text' }> {
  return Object.freeze({
    type: 'text',
    content: requiredText(
      input?.content,
      'Text content',
      MAX_TEXT_BYTES,
    ),
  });
}

function normalizeImage(
  input: SendInput,
  mediaCatalog: readonly MediaCapability[],
  allowUnboundMediaReference: boolean,
): Extract<SendIntent, { type: 'image' }> {
  const mediaRef = String(input?.mediaRef || '');
  if (!MEDIA_REFERENCE.test(mediaRef)) {
    fail('Image reference must use media:N', 'invalid_media_reference');
  }
  if (
    !allowUnboundMediaReference &&
    !mediaCatalog.some((entry) => entry.ref === mediaRef)
  ) {
    fail('Image reference is not available in this turn', 'invalid_media_reference');
  }
  return Object.freeze({ type: 'image', mediaRef });
}

function normalizeLink(input: SendInput): Extract<SendIntent, { type: 'link' }> {
  return Object.freeze({
    type: 'link',
    title: requiredText(input?.title, 'Link title', 128),
    description: optionalText(input?.description, 'Link description', 512),
    url: publicHttpUrl(input?.url, 'Link URL'),
  });
}

function normalizeMiniProgram(
  input: SendInput,
): Extract<SendIntent, { type: 'miniprogram' }> {
  const appId = String(input?.appId || '').trim();
  if (!/^wx[A-Za-z0-9]{16}$/u.test(appId)) {
    fail('Mini-program appId must use wx followed by 16 letters or digits');
  }
  const pagePath = requiredText(input?.pagePath, 'Mini-program pagePath', 1024);
  if (
    /^[a-z][a-z\d+.-]*:\/\//iu.test(pagePath) ||
    pagePath.includes('..') ||
    /[\u0000-\u001f\u007f]/u.test(pagePath)
  ) {
    fail('Mini-program pagePath is invalid');
  }
  return Object.freeze({
    type: 'miniprogram',
    appId,
    title: requiredText(input?.title, 'Mini-program title', 64),
    pagePath,
    sourceUrl: publicHttpUrl(input?.sourceUrl, 'Mini-program source URL'),
  });
}

function normalizeLocation(
  input: SendInput,
): Extract<SendIntent, { type: 'location' }> {
  const latitude = Number(input?.latitude);
  const longitude = Number(input?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    fail('Location latitude must be between -90 and 90');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    fail('Location longitude must be between -180 and 180');
  }
  return Object.freeze({
    type: 'location',
    name: requiredText(input?.name, 'Location name', 128),
    address: requiredText(input?.address, 'Location address', 512),
    latitude,
    longitude,
  });
}

export function normalizeSendIntent(
  typeOrToolName: string,
  input: SendInput,
  options: {
    mediaCatalog?: unknown;
    allowUnboundMediaReference?: boolean;
  } = {},
): SendIntent {
  const type = TOOL_TYPES.get(typeOrToolName) || String(typeOrToolName || '');
  if (!SEND_TYPES.includes(type as SendType)) {
    fail(`Unsupported send type: ${type || 'unknown'}`, 'unsupported_send_type');
  }
  const mediaCatalog = normalizeMediaCatalog(options.mediaCatalog || []);
  if (type === 'text') return normalizeText(input);
  if (type === 'image') {
    return normalizeImage(
      input,
      mediaCatalog,
      options.allowUnboundMediaReference === true,
    );
  }
  if (type === 'link') return normalizeLink(input);
  if (type === 'miniprogram') return normalizeMiniProgram(input);
  return normalizeLocation(input);
}
