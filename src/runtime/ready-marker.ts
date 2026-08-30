import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivateDirectory } from '../lib/private-directory.ts';

interface ReadyMarker {
  readonly token: string;
  readonly pid: number;
  readonly readyAt: string;
}

const START_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export function readyMarkerPath(instanceRoot: string): string {
  return path.join(path.resolve(instanceRoot), 'data/ready.json');
}

export function writeReadyMarker(
  instanceRoot: string,
  token: string,
  pid = process.pid,
): void {
  if (!START_TOKEN.test(token) || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid Kintio readiness identity');
  }
  const target = readyMarkerPath(instanceRoot);
  ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${pid}.${token.slice(0, 8)}.tmp`;
  const marker: ReadyMarker = {
    token,
    pid,
    readyAt: new Date().toISOString(),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function matchesReadyMarker(
  instanceRoot: string,
  token: string,
  pid: number,
): boolean {
  if (!START_TOKEN.test(token) || !Number.isInteger(pid) || pid <= 0) return false;
  const target = readyMarkerPath(instanceRoot);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
        return false;
      }
    }
    const marker = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ReadyMarker>;
    return (
      marker.token === token &&
      marker.pid === pid &&
      typeof marker.readyAt === 'string' &&
      Number.isFinite(Date.parse(marker.readyAt))
    );
  } catch {
    return false;
  }
}
