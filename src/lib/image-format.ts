export const MAX_WECHAT_IMAGE_BYTES = 2 * 1024 * 1024;

interface ImageFormat {
  readonly extension: '.png' | '.jpg' | '.gif' | '.webp' | '.bmp';
  readonly mimeType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/webp'
    | 'image/bmp';
}

export function detectImageFormat(bytes: unknown): ImageFormat | null {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.length >= 12 &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { extension: '.bmp', mimeType: 'image/bmp' };
  }
  return null;
}
