import fs from 'node:fs/promises';
import {
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ResolvedImage } from '../types.ts';
import {
  MAX_WECHAT_IMAGE_BYTES,
  detectImageFormat,
} from '../lib/image-format.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';

const STAGED_IMAGE_PREFIX = 'kintio-image-';

export function cleanupStagedImageOrphans(temporaryRoot: string): void {
  ensurePrivateDirectory(temporaryRoot);
  for (const entry of readdirSync(temporaryRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(STAGED_IMAGE_PREFIX)) continue;
    rmSync(path.join(temporaryRoot, entry.name), { recursive: true, force: true });
  }
}

export async function withStagedImages<T>(
  images: readonly Pick<ResolvedImage, 'bytes'>[],
  { temporaryRoot = os.tmpdir() }: { temporaryRoot?: string } = {},
  operation: (paths: string[]) => T | Promise<T>,
): Promise<T> {
  if (images.length === 0) {
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
