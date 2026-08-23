import { MESSAGE_TYPES } from './message.js';
import { REPLY_TYPES } from './reply.js';

const LOCATION_INTENT_PATTERN =
  /(位置|地址|定位|导航|地图|在哪|哪里|怎么走|路线|发.{0,4}(地点|位置|地址))/u;
const MINIPROGRAM_INTENT_PATTERN =
  /(小程序|微信.{0,4}(打开|直达|入口)|直达.{0,4}(微信|服务|页面)|小程序卡片)/u;
const MEDIA_RETURN_ACTION_PATTERN = /(发回|返还|再发|重新发|传回|给我|下载)/u;
const MEDIA_KIND_REQUESTS = Object.freeze([
  { pattern: /(图片|照片|原图)/u, kind: 'image', type: REPLY_TYPES.IMAGE },
]);

function requestedMediaType(message, mediaCatalog) {
  if (
    message.type !== MESSAGE_TYPES.TEXT ||
    !MEDIA_RETURN_ACTION_PATTERN.test(message.text)
  ) {
    return '';
  }

  const explicit = MEDIA_KIND_REQUESTS.find(
    (request) =>
      request.pattern.test(message.text) &&
      mediaCatalog.some((item) => item.kind === request.kind),
  );
  if (explicit) return explicit.type;

  const availableKinds = [...new Set(mediaCatalog.map((item) => item.kind))];
  if (availableKinds.length !== 1) return '';

  return MEDIA_KIND_REQUESTS.find(
    (request) => request.kind === availableKinds[0],
  )?.type || '';
}

export function preferredReplyType(message, mediaCatalog = []) {
  if (
    message.type === MESSAGE_TYPES.TEXT &&
    LOCATION_INTENT_PATTERN.test(message.text)
  ) {
    return REPLY_TYPES.LOCATION;
  }

  if (
    message.type === MESSAGE_TYPES.TEXT &&
    MINIPROGRAM_INTENT_PATTERN.test(message.text)
  ) {
    return REPLY_TYPES.MINIPROGRAM;
  }

  const mediaType = requestedMediaType(message, mediaCatalog);
  if (mediaType) return mediaType;

  return REPLY_TYPES.TEXT;
}

export function renderReplyPolicy(message, mediaCatalog = []) {
  const preferred = preferredReplyType(message, mediaCatalog);

  if (preferred === REPLY_TYPES.LOCATION) {
    return [
      '本轮客户明确表达了位置、地址或导航意图。',
      '微信原生 location 是首选回复格式；必须先通过网页搜索获得可靠经纬度，再返回 location。',
      '无法获得可靠坐标时，若能从可信公开来源精确核实相关微信小程序的 appId 与 pagePath，则返回 miniprogram；不得根据品牌名、门店名或普通网址猜测这些字段。',
      '再其次，有可信公网地图或商家 URL 时返回 link；优先选择指向具体地点的地图详情页，不要选择只有搜索关键词的通用搜索链接。',
      '只有 location、miniprogram 和 link 都不成立时才允许 text 兜底。',
    ].join('\n');
  }

  if (preferred === REPLY_TYPES.MINIPROGRAM) {
    return [
      '本轮客户明确希望获得微信小程序或微信内直达入口。',
      '先用实时网页搜索核实匹配的小程序；只有可信公开来源同时明确给出准确 appId 与 pagePath 时才返回 miniprogram，并把该来源填入 sourceUrl。',
      '不得猜测 appId、pagePath，也不得把普通网页 URL 当作 pagePath。无法精确核实时，有可信公网入口则返回 link，否则返回 text。',
    ].join('\n');
  }

  if (preferred === REPLY_TYPES.IMAGE) {
    return [
      `客户明确要求取回本会话中的${preferred}媒体。`,
      `优先返回 ${preferred}，且 media.reference 必须选择 available_customer_media 中类型匹配的现有引用。`,
      '不要编造媒体引用、URL 或本机路径；若无法唯一判断客户指的是哪一个媒体，返回 text 做简短追问。',
    ].join('\n');
  }

  return [
    '若答案天然对应一个微信内直达入口，且能从可信公开来源精确核实小程序 appId 与 pagePath，优先返回 miniprogram。',
    '否则，若答案包含一个主要、可信的公网 URL，返回 link；最后才返回 text。不得猜测小程序字段或 URL。',
  ].join('\n');
}

export function needsNativeFormatRetry(message, reply, mediaCatalog = []) {
  const preferred = preferredReplyType(message, mediaCatalog);

  if (preferred === REPLY_TYPES.LOCATION) {
    return ![REPLY_TYPES.LOCATION, REPLY_TYPES.MINIPROGRAM].includes(reply.type);
  }

  if (preferred === REPLY_TYPES.MINIPROGRAM) {
    return ![REPLY_TYPES.MINIPROGRAM, REPLY_TYPES.LINK].includes(reply.type);
  }

  if (preferred === REPLY_TYPES.IMAGE) {
    return reply.type !== preferred;
  }

  return false;
}

export function renderNativeRetryPrompt(message, mediaCatalog = []) {
  const preferred = preferredReplyType(message, mediaCatalog);

  if (preferred === REPLY_TYPES.MINIPROGRAM) {
    return [
      '上一个候选回复没有采用客户所需的微信内结构化入口。',
      '请用实时网页搜索重新核实是否存在与需求准确匹配的小程序。',
      '只有可信公开来源明确给出准确 appId 与 pagePath 时才能返回 miniprogram，并在 sourceUrl 填入核验来源；不能确认时返回可信公网 link，二者都没有才返回 text。',
    ].join('\n');
  }

  if (preferred === REPLY_TYPES.IMAGE) {
    return [
      `上一个候选回复没有采用客户明确要求的 ${preferred} 原生媒体。`,
      `请从 available_customer_media 中选择类型匹配且语义上唯一的 media.reference，返回 ${preferred}。`,
      '若无法唯一确定客户指代的媒体，返回 text 做简短追问；绝不能编造引用。',
    ].join('\n');
  }

  return [
    '上一个候选回复没有采用客户所需的微信原生位置或直达格式。',
    '请重新检查当前会话中的地点，使用实时网页搜索寻找可靠经纬度。',
    '地图 link 不是 location。请打开可信的具体地点详情页继续核实；Apple Maps 地点页的 place:location:latitude 与 place:location:longitude 元数据也可作为坐标来源。',
    '能确认坐标时必须返回 location；否则仅在能精确核实 appId 与 pagePath 时返回 miniprogram；再否则返回指向具体地点的可信地图/商家 link，避免只含搜索关键词的通用链接；都没有才返回 text。',
  ].join('\n');
}
