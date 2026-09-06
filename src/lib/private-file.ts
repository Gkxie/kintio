import fs from 'node:fs';

export function regularFile(filePath: string, label: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    return stat;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function privateFile(filePath: string, label: string): fs.Stats | undefined {
  const stat = regularFile(filePath, label);
  if (!stat || process.platform === 'win32') return stat;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
  return stat;
}
