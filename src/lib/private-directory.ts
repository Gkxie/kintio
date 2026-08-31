import fs from 'node:fs';
import path from 'node:path';

import { isPathInside } from './path-identity.ts';

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

export function assertTrustedDirectory(
  directory: string,
  label: string,
  privateContents: boolean,
): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${directory}`);
  }
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }
  const forbidden = privateContents ? 0o077 : 0o022;
  if ((stat.mode & forbidden) !== 0) {
    throw new Error(`${label} has unsafe permissions: ${directory}`);
  }
}

export function ensureContainedDirectory(root: string, directory: string): string {
  const target = path.resolve(directory);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!isPathInside(root, ancestor)) {
    throw new Error(`Instance path escapes through a symbolic link: ${ancestor}`);
  }
  const created = ensurePrivateDirectory(target);
  if (!isPathInside(root, created)) {
    throw new Error(`Instance path escapes through a symbolic link: ${created}`);
  }
  return created;
}
