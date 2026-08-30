import fs from 'node:fs';
import path from 'node:path';

export function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const suffix: string[] = [];
  let ancestor = resolved;
  let canonical: string;
  while (true) {
    try {
      canonical = path.join(fs.realpathSync.native(ancestor), ...suffix);
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        canonical = resolved;
        break;
      }
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function samePath(left: string, right: string): boolean {
  return Boolean(left && right) && canonicalPath(left) === canonicalPath(right);
}

export function isPathInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
