import { preferredReplyType } from '../domain/reply-policy.js';
import {
  REPLY_TYPES,
  createLocationReply,
} from '../domain/reply.js';

const MAX_MAP_PAGE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

function parseCoordinatePair(value, order = 'latitude-longitude') {
  const match = String(value || '').match(
    /(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)/u,
  );

  if (!match) return null;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const latitude = order === 'longitude-latitude' ? second : first;
  const longitude = order === 'longitude-latitude' ? first : second;

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude };
}

function coordinatesEmbeddedInMapUrl(url) {
  const hostname = url.hostname.toLowerCase();

  if (hostname === 'maps.apple.com') {
    return parseCoordinatePair(url.searchParams.get('ll'));
  }

  if (hostname === 'uri.amap.com' || hostname === 'ditu.amap.com') {
    for (const key of ['location', 'position', 'center']) {
      const coordinates = parseCoordinatePair(
        url.searchParams.get(key),
        'longitude-latitude',
      );
      if (coordinates) return coordinates;
    }
    return null;
  }

  if (hostname === 'www.google.com' || hostname === 'maps.google.com') {
    const pathMatch = url.pathname.match(
      /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    );
    if (pathMatch) {
      return parseCoordinatePair(`${pathMatch[1]},${pathMatch[2]}`);
    }

    return (
      parseCoordinatePair(url.searchParams.get('query')) ||
      parseCoordinatePair(url.searchParams.get('q'))
    );
  }

  return null;
}

function metaContent(html, property) {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const propertyMatch = tag.match(/\bproperty\s*=\s*["']([^"']+)["']/iu);

    if (propertyMatch?.[1]?.toLowerCase() !== property.toLowerCase()) {
      continue;
    }

    return tag.match(/\bcontent\s*=\s*["']([^"']+)["']/iu)?.[1] || '';
  }

  return '';
}

function coordinatesFromAppleMapPage(html) {
  const latitude = Number(
    metaContent(html, 'place:location:latitude'),
  );
  const longitude = Number(
    metaContent(html, 'place:location:longitude'),
  );

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude };
}

function normalizedPlaceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/(地图)?位置$/u, '');
}

function comparablePlaceText(left, right, minimumLength) {
  const normalizedLeft = normalizedPlaceText(left);
  const normalizedRight = normalizedPlaceText(right);

  return (
    normalizedLeft.length >= minimumLength &&
    normalizedRight.length >= minimumLength &&
    (normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft))
  );
}

function describesSamePlace(currentLink, historicalMessage) {
  const historicalPlace =
    historicalMessage.type === REPLY_TYPES.LOCATION
      ? {
          title: historicalMessage.location?.name,
          description: historicalMessage.location?.address,
        }
      : {
          title: historicalMessage.link?.title,
          description: historicalMessage.link?.description,
        };

  return (
    comparablePlaceText(currentLink.title, historicalPlace.title, 4) ||
    comparablePlaceText(
      currentLink.description,
      historicalPlace.description,
      8,
    )
  );
}

function historicalPlaceDetails(historicalMessage) {
  if (historicalMessage.type === REPLY_TYPES.LOCATION) {
    return {
      name: historicalMessage.location?.name || '',
      address: historicalMessage.location?.address || '',
    };
  }

  return {
    name: historicalMessage.link?.title || '',
    address: historicalMessage.link?.description || '',
  };
}

function looksLikeAddress(value) {
  const text = String(value || '').trim();
  return text.length >= 6 && /[省市区县乡镇村路街巷号楼层]/u.test(text);
}

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);

  if (declaredLength > maxBytes) {
    throw new Error('map page exceeds the response limit');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error('map page exceeds the response limit');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export class MapLocationResolver {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    historyStore,
    logger = console,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required');
    }

    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.historyStore = historyStore;
    this.logger = logger;
  }

  async #coordinatesForUrl(url) {
    let coordinates = coordinatesEmbeddedInMapUrl(url);

    if (
      !coordinates &&
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'maps.apple.com'
    ) {
      const response = await this.fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'text/html',
          'User-Agent': 'wechat-bot/1.0',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const contentType = String(
        response.headers.get('content-type') || '',
      ).toLowerCase();

      if (!response.ok || !contentType.includes('text/html')) {
        throw new Error(`map page returned HTTP ${response.status}`);
      }

      coordinates = coordinatesFromAppleMapPage(
        await readLimitedText(response, MAX_MAP_PAGE_BYTES),
      );
    }

    return coordinates;
  }

  async #coordinatesFromHistory(message, currentLink) {
    if (typeof this.historyStore?.getRecentOutboundMessages !== 'function') {
      return null;
    }

    const { openKfId, externalUserId } = message.conversation;
    const historicalMessages = await this.historyStore.getRecentOutboundMessages(
      { openKfId, externalUserId, limit: 20 },
    );

    for (const historicalMessage of historicalMessages) {
      if (!describesSamePlace(currentLink, historicalMessage)) continue;

      if (historicalMessage.type === REPLY_TYPES.LOCATION) {
        const { latitude, longitude } = historicalMessage.location || {};
        const coordinates = parseCoordinatePair(`${latitude},${longitude}`);
        if (coordinates) {
          return {
            coordinates,
            place: historicalPlaceDetails(historicalMessage),
          };
        }
      }

      if (historicalMessage.type === REPLY_TYPES.LINK) {
        try {
          const coordinates = await this.#coordinatesForUrl(
            new URL(historicalMessage.link.url),
          );
          if (coordinates) {
            return {
              coordinates,
              place: historicalPlaceDetails(historicalMessage),
            };
          }
        } catch (error) {
          this.logger.warn?.(
            `[map] historical map coordinate lookup failed: ${error.message}`,
          );
        }
      }
    }

    return null;
  }

  async resolve({ message, reply }) {
    if (
      preferredReplyType(message) !== REPLY_TYPES.LOCATION ||
      reply.type !== REPLY_TYPES.LINK
    ) {
      return reply;
    }

    let url;

    try {
      url = new URL(reply.link.url);
    } catch {
      return reply;
    }

    let coordinates;

    try {
      coordinates = await this.#coordinatesForUrl(url);
    } catch (error) {
      this.logger.warn?.(
        `[map] trusted map coordinate lookup failed: ${error.message}`,
      );
    }

    let historicalMatch;

    if (!coordinates) {
      try {
        historicalMatch = await this.#coordinatesFromHistory(
          message,
          reply.link,
        );
        coordinates = historicalMatch?.coordinates;
      } catch (error) {
        this.logger.warn?.(
          `[map] recent location lookup failed: ${error.message}`,
        );
      }
    }

    if (!coordinates) return reply;

    const historicalPlace = historicalMatch?.place || {};
    const currentName = String(reply.link.title || '').replace(
      /(地图)?位置$/u,
      '',
    );
    const name = currentName || historicalPlace.name;
    const address = looksLikeAddress(reply.link.description)
      ? reply.link.description
      : historicalPlace.address || reply.link.description;

    return createLocationReply({
      name,
      address,
      ...coordinates,
    });
  }
}
