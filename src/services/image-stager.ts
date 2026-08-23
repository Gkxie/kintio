import fs from 'node:fs/promises';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

import type { ResolvedImage } from '../types.ts';

export const MAX_WECHAT_IMAGE_BYTES = 2 * 1024 * 1024;
const STAGED_IMAGE_PREFIX = 'wechat-codex-image-';

export function cleanupStagedImageOrphans(temporaryRoot: string): void {
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  chmodSync(temporaryRoot, 0o700);
  for (const entry of readdirSync(temporaryRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(STAGED_IMAGE_PREFIX)) continue;
    rmSync(path.join(temporaryRoot, entry.name), { recursive: true, force: true });
  }
}

export interface ImageFormat {
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

export async function withStagedImages<T>(
  images: readonly Pick<ResolvedImage, 'bytes'>[],
  { temporaryRoot = '/dev/shm' }: { temporaryRoot?: string } = {},
  operation: (paths: string[]) => T | Promise<T>,
): Promise<T> {
  if (!Array.isArray(images) || images.length === 0) {
    return operation([]);
  }

  const temporaryDirectory = await fs.mkdtemp(
    path.join(temporaryRoot, STAGED_IMAGE_PREFIX),
  );
  await fs.chmod(temporaryDirectory, 0o700);

  try {
    const paths: string[] = [];

    for (const [index, image] of images.entries()) {
      if (!Buffer.isBuffer(image.bytes) || image.bytes.length === 0) {
        throw new Error('Downloaded image is empty');
      }

      if (image.bytes.length > MAX_WECHAT_IMAGE_BYTES) {
        throw new Error('Downloaded image exceeds the 2 MiB WeChat limit');
      }

      const format = detectImageFormat(image.bytes);

      if (!format) {
        throw new Error('Downloaded media is not a supported image format');
      }

      const imagePath = path.join(temporaryDirectory, `image-${index}${format.extension}`);
      await fs.writeFile(imagePath, image.bytes, { mode: 0o600 });
      paths.push(imagePath);
    }

    return await operation(paths);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
