import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  invalid?: true;
}

export interface InstanceLock {
  readonly filePath: string;
  readonly owner: Readonly<LockOwner>;
  release(): boolean;
}

interface AcquireLockOptions {
  filePath: string;
  pid?: number;
  clock?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  hasActiveDatabaseOwner?: (owner: LockOwner | null) => boolean;
  recoveryStaleMs?: number;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function readOwner(filePath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { pid: 0, token: '', createdAt: 0, invalid: true };
    }
    const candidate = parsed as Partial<LockOwner>;
    if (
      !Number.isInteger(candidate.pid) ||
      typeof candidate.token !== 'string' ||
      !candidate.token ||
      !Number.isFinite(candidate.createdAt)
    ) {
      return { pid: 0, token: '', createdAt: 0, invalid: true };
    }
    return {
      pid: Number(candidate.pid),
      token: candidate.token,
      createdAt: Number(candidate.createdAt),
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    return { pid: 0, token: '', createdAt: 0, invalid: true };
  }
}

function writeExclusive(filePath: string, owner: LockOwner): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function unlinkIfOwned(filePath: string, token: string): boolean {
  const owner = readOwner(filePath);
  if (!owner || owner.token !== token) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export class SingleInstanceLockError extends Error {
  readonly code: string;
  readonly owner: LockOwner | null;

  constructor(
    message: string,
    {
      code = 'instance_locked',
      owner = null,
    }: { code?: string; owner?: LockOwner | null } = {},
  ) {
    super(message);
    this.name = 'SingleInstanceLockError';
    this.code = code;
    this.owner = owner;
  }
}

export function acquireSingleInstanceLock({
  filePath,
  pid = process.pid,
  clock = Date.now,
  isProcessAlive = processIsAlive,
  hasActiveDatabaseOwner = () => false,
  recoveryStaleMs = 30_000,
}: AcquireLockOptions): InstanceLock {
  if (!filePath) throw new Error('Single-instance lock filePath is required');
  const lockPath = path.resolve(filePath);
  const recoveryPath = `${lockPath}.recovery`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const owner = {
    pid: Number(pid),
    token,
    createdAt: Number(clock()),
  };

  const recoveryOwner = readOwner(recoveryPath);
  if (recoveryOwner) {
    if (recoveryOwner.invalid) {
      const age = Number(clock()) - fs.statSync(recoveryPath).mtimeMs;
      if (age < Number(recoveryStaleMs)) {
        throw new SingleInstanceLockError(
          `Single-instance lock recovery is already active: ${recoveryPath}`,
          { code: 'lock_recovery_in_progress', owner: recoveryOwner },
        );
      }
      fs.unlinkSync(recoveryPath);
    } else if (
      isProcessAlive(Number(recoveryOwner.pid)) ||
      hasActiveDatabaseOwner(recoveryOwner)
    ) {
      throw new SingleInstanceLockError(
        `Single-instance lock recovery is already active: ${recoveryPath}`,
        { code: 'lock_recovery_in_progress', owner: recoveryOwner },
      );
    } else {
      unlinkIfOwned(recoveryPath, recoveryOwner.token);
    }
  }

  try {
    writeExclusive(lockPath, owner);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const current = readOwner(lockPath);
    if (
      current &&
      !current.invalid &&
      isProcessAlive(current.pid)
    ) {
      throw new SingleInstanceLockError(
        `Another Kintio instance is running with PID ${current.pid}`,
        { owner: current },
      );
    }
    if (hasActiveDatabaseOwner(current)) {
      throw new SingleInstanceLockError(
        'The stale PID check failed but SQLite still reports an active owner',
        { code: 'database_owner_active', owner: current },
      );
    }

    const recoveryToken = randomUUID();
    const recovery = {
      pid: Number(pid),
      token: recoveryToken,
      createdAt: Number(clock()),
    };
    try {
      writeExclusive(recoveryPath, recovery);
    } catch (guardError) {
      if (errorCode(guardError) === 'EEXIST') {
        throw new SingleInstanceLockError(
          'Another process is recovering the stale instance lock',
          { code: 'lock_recovery_in_progress', owner: readOwner(recoveryPath) },
        );
      }
      throw guardError;
    }

    try {
      const checked = readOwner(lockPath);
      if (
        checked &&
        !checked.invalid &&
        isProcessAlive(Number(checked.pid))
      ) {
        throw new SingleInstanceLockError(
          `Another Kintio instance acquired the lock with PID ${checked.pid}`,
          { owner: checked },
        );
      }
      if (checked && hasActiveDatabaseOwner(checked)) {
        throw new SingleInstanceLockError(
          'SQLite reports an active owner for the existing lock',
          { code: 'database_owner_active', owner: checked },
        );
      }
      if (checked) fs.unlinkSync(lockPath);
      writeExclusive(lockPath, owner);
    } finally {
      unlinkIfOwned(recoveryPath, recoveryToken);
    }
  }

  let released = false;
  return Object.freeze({
    filePath: lockPath,
    owner: Object.freeze({ ...owner }),
    release() {
      if (released) return false;
      released = true;
      return unlinkIfOwned(lockPath, token);
    },
  });
}
