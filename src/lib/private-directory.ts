import fs from 'node:fs';
import path from 'node:path';

/**
 * Create an application-owned directory privately without changing an existing
 * directory's permissions. Configured files may intentionally live below a
 * shared parent such as /tmp; hardening that parent would affect other users.
 */
export function ensurePrivateDirectory(directoryPath: string): string {
  const target = path.resolve(directoryPath);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private directory path is not a directory: ${target}`);
  }
  return target;
}
