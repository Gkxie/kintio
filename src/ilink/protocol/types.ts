/**
 * Minimal iLink JSON protocol types mirrored from
 * @tencent-weixin/openclaw-weixin 2.4.6. Byte fields are Base64 strings.
 * See THIRD_PARTY_NOTICES for the upstream MIT attribution.
 */

export interface IlinkBaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export const IlinkMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const IlinkMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const IlinkMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

interface IlinkTextItem {
  text?: string;
}

interface IlinkCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

interface IlinkImageItem {
  media?: IlinkCdnMedia;
  thumb_media?: IlinkCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

interface IlinkVoiceItem {
  media?: IlinkCdnMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

interface IlinkFileItem {
  media?: IlinkCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

interface IlinkVideoItem {
  media?: IlinkCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: IlinkCdnMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

interface IlinkToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

interface IlinkToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}

interface IlinkRefMessage {
  message_item?: IlinkMessageItem;
  title?: string;
}

interface IlinkMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: IlinkRefMessage;
  text_item?: IlinkTextItem;
  image_item?: IlinkImageItem;
  voice_item?: IlinkVoiceItem;
  file_item?: IlinkFileItem;
  video_item?: IlinkVideoItem;
  tool_call_start_item?: IlinkToolCallStartItem;
  tool_call_result_item?: IlinkToolCallResultItem;
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface IlinkGetUpdatesRequest {
  get_updates_buf?: string;
}

export interface IlinkGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/** Server acknowledgement for an account-client startup notification. */
export interface IlinkNotifyStartResponse {
  ret?: number;
  errmsg?: string;
}

/** Server acknowledgement for an account-client shutdown notification. */
export interface IlinkNotifyStopResponse {
  ret?: number;
  errmsg?: string;
}

export interface IlinkSendMessageRequest {
  msg: IlinkMessage;
}

export interface IlinkSendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface IlinkQrCreateRequest {
  bot_type?: string;
  local_token_list?: readonly string[];
}

export interface IlinkQrCreateResponse {
  qrcode: string;
  qrcode_img_content: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export const ILINK_QR_STATUSES = [
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
] as const;

type IlinkQrStatus = (typeof ILINK_QR_STATUSES)[number];

export interface IlinkQrStatusRequest {
  qrcode: string;
  verify_code?: string;
}

export interface IlinkQrStatusResponse {
  status: IlinkQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}
