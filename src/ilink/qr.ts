import { toBuffer } from 'qrcode';

const MAX_QR_CONTENT_BYTES = 2_048;
const MAX_QR_PNG_BYTES = 512 * 1_024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function renderOptions() {
  // qrcode/pngjs adds dimensions to rendererOpts, so each call receives a
  // fresh object while every caller-visible rendering choice remains fixed.
  return {
    type: 'png' as const,
    errorCorrectionLevel: 'M' as const,
    margin: 4,
    scale: 8,
    color: {
      dark: '#000000ff',
      light: '#ffffffff',
    },
    rendererOpts: {
      deflateLevel: 9,
      deflateStrategy: 3,
    },
  };
}

export type IlinkQrRenderErrorCode =
  | 'invalid_qr_content'
  | 'qr_render_failed'
  | 'invalid_qr_png'
  | 'qr_png_too_large';

export class IlinkQrRenderError extends Error {
  readonly code: IlinkQrRenderErrorCode;

  constructor(code: IlinkQrRenderErrorCode, message: string) {
    super(message);
    this.name = 'IlinkQrRenderError';
    this.code = code;
  }
}

function validateContent(content: string): void {
  if (
    typeof content !== 'string' ||
    content.trim().length === 0 ||
    Buffer.byteLength(content, 'utf8') > MAX_QR_CONTENT_BYTES
  ) {
    throw new IlinkQrRenderError(
      'invalid_qr_content',
      'Invalid iLink QR content',
    );
  }
}

export async function renderIlinkQrPng(content: string): Promise<Buffer> {
  validateContent(content);
  let png: Buffer;
  try {
    png = await toBuffer(content, renderOptions());
  } catch {
    throw new IlinkQrRenderError(
      'qr_render_failed',
      'Unable to render iLink QR image',
    );
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new IlinkQrRenderError('invalid_qr_png', 'Rendered iLink QR image is invalid');
  }
  if (png.length > MAX_QR_PNG_BYTES) {
    throw new IlinkQrRenderError('qr_png_too_large', 'Rendered iLink QR image is too large');
  }
  return png;
}
