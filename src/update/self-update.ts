import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  detectGlobalInstallation,
  planGlobalInstall,
  type GlobalInstallation,
  type GlobalInstallCommand,
} from './global-install.ts';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REGISTRY_LATEST = 'https://registry.npmjs.org/@kin-tio%2Fcli/latest';
const MAX_REGISTRY_BYTES = 64 * 1024;
const CAPTURE_LIMIT_BYTES = 256 * 1024;

export interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export class ProcessTreeTerminationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProcessTreeTerminationError';
  }
}

interface PreparedUpdateBase {
  readonly currentVersion: string;
  readonly installation: GlobalInstallation;
  readonly targetVersion: string;
}

export type PreparedKintioUpdate =
  | (PreparedUpdateBase & { readonly kind: 'current' })
  | (PreparedUpdateBase & {
      readonly kind: 'update';
      readonly command: GlobalInstallCommand;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    });

export function parseStableVersion(value: string): readonly [number, number, number] {
  const match = VERSION.exec(String(value || ''));
  if (!match) throw new Error(`Invalid stable Kintio version: ${JSON.stringify(value)}`);
  const parts = match.slice(1).map(Number) as [number, number, number];
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`Invalid stable Kintio version: ${JSON.stringify(value)}`);
  }
  return parts;
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_BYTES) {
    throw new Error('npm Registry response exceeds the update metadata limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REGISTRY_BYTES) {
        throw new Error('npm Registry response exceeds the update metadata limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString('utf8');
}

export async function fetchLatestKintioVersion({
  fetchImpl = fetch,
  timeoutMs = 8_000,
}: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
} = {}): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Update metadata timeout must be between 1 and 60000 milliseconds');
  }
  const response = await fetchImpl(REGISTRY_LATEST, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'kintio-update',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`npm Registry update metadata failed with HTTP ${response.status}`);
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await boundedText(response));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('npm Registry returned invalid update metadata');
    throw error;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('npm Registry returned invalid update metadata');
  }
  const record = metadata as Record<string, unknown>;
  if (record.name !== '@kin-tio/cli' || typeof record.version !== 'string') {
    throw new Error('npm Registry returned another package identity');
  }
  parseStableVersion(record.version);
  return record.version;
}

const CHILD_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'ComSpec',
  'COREPACK_HOME',
  'HOMEDRIVE',
  'HOME',
  'HOMEPATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'NPM_CONFIG_GLOBALCONFIG',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_USERCONFIG',
  'PATH',
  'Path',
  'PATHEXT',
  'PNPM_HOME',
  'PNPM_CONFIG_GLOBAL_BIN_DIR',
  'PNPM_CONFIG_GLOBAL_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'npm_config_global_bin_dir',
  'npm_config_global_dir',
  'npm_config_globalconfig',
  'npm_config_prefix',
  'npm_config_userconfig',
]);

export function updateChildEnvironment(
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && CHILD_ENVIRONMENT_KEYS.has(key)) output[key] = value;
  }
  return output;
}

function outputValue(result: ProcessResult): string | undefined {
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value && value !== 'undefined' && value !== 'null' ? value : undefined;
}

function inferredPnpmGlobalDir(root: string): string | undefined {
  const normalized = path.resolve(root);
  if (/^v\d+$/u.test(path.basename(normalized))) return path.dirname(normalized);
  if (path.basename(normalized).toLowerCase() === 'node_modules') {
    const layout = path.basename(path.dirname(normalized));
    if (/^(?:v)?\d+$/u.test(layout)) return path.dirname(path.dirname(normalized));
  }
  return undefined;
}

function discoverPnpmLinkedRoot(
  packageRoot: string,
  listing: ProcessResult | undefined,
): { readonly root: string; readonly globalDir: string } | undefined {
  const source = listing ? outputValue(listing) : undefined;
  if (!source) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
  const project = parsed[0];
  if (!project || typeof project !== 'object' || Array.isArray(project)) return undefined;
  const layoutRootValue = (project as Record<string, unknown>).path;
  if (typeof layoutRootValue !== 'string' || !path.isAbsolute(layoutRootValue)) return undefined;
  const layoutRoot = path.resolve(layoutRootValue);
  if (!/^v\d+$/u.test(path.basename(layoutRoot))) return undefined;
  let expected: string;
  try { expected = fs.realpathSync.native(packageRoot); } catch { return undefined; }
  const matches: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(layoutRoot, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const nodeModules = path.join(layoutRoot, entry.name, 'node_modules');
    const candidate = path.join(nodeModules, '@kin-tio', 'cli');
    try {
      if (fs.realpathSync.native(candidate) === expected) matches.push(nodeModules);
    } catch {}
  }
  if (matches.length > 1) {
    throw new Error('pnpm global installation has more than one stable package link');
  }
  return matches[0]
    ? { root: matches[0], globalDir: path.dirname(layoutRoot) }
    : undefined;
}

export async function probeGlobalInstallation({
  packageRoot,
  cwd,
  environment,
  run = runCaptured,
}: {
  readonly packageRoot: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly run?: typeof runCaptured;
}): Promise<GlobalInstallation> {
  const request = (file: string, args: readonly string[]) => run({
    file,
    args,
    cwd,
    env: environment,
  }).catch(() => undefined);
  const [npmPrefix, pnpmRoot, configuredPnpmGlobalDir, pnpmBin, configuredPnpmBin,
    pnpmListing] =
    await Promise.all([
      request('npm', ['prefix', '--global']),
      request('pnpm', ['root', '--global']),
      request('pnpm', ['config', 'get', 'global-dir']),
      request('pnpm', ['bin', '--global']),
      request('pnpm', ['config', 'get', 'global-bin-dir']),
      request('pnpm', ['list', '--global', '--depth', '0', '--json']),
    ]);
  const root = pnpmRoot ? outputValue(pnpmRoot) : undefined;
  const globalDir = configuredPnpmGlobalDir
    ? outputValue(configuredPnpmGlobalDir)
    : undefined;
  const globalBinDir = (pnpmBin ? outputValue(pnpmBin) : undefined) ||
    (configuredPnpmBin ? outputValue(configuredPnpmBin) : undefined);
  const linked = discoverPnpmLinkedRoot(packageRoot, pnpmListing);
  const effectivePnpmRoot = linked?.root || root;
  const effectivePnpmGlobalDir = globalDir || linked?.globalDir ||
    (root ? inferredPnpmGlobalDir(root) : undefined);
  return detectGlobalInstallation({
    packageRoot,
    ...(npmPrefix && outputValue(npmPrefix)
      ? { npm: { prefix: outputValue(npmPrefix)! } }
      : {}),
    ...(effectivePnpmRoot && effectivePnpmGlobalDir && globalBinDir
      ? {
          pnpm: {
            root: effectivePnpmRoot,
            globalDir: effectivePnpmGlobalDir,
            globalBinDir,
          },
        }
      : {}),
  });
}

export async function prepareKintioUpdate({
  packageRoot,
  currentVersion,
  cwd,
  inheritedEnvironment,
  fetchLatest = fetchLatestKintioVersion,
  probe = probeGlobalInstallation,
}: {
  readonly packageRoot: string;
  readonly currentVersion: string;
  readonly cwd: string;
  readonly inheritedEnvironment: NodeJS.ProcessEnv;
  readonly fetchLatest?: typeof fetchLatestKintioVersion;
  readonly probe?: typeof probeGlobalInstallation;
}): Promise<PreparedKintioUpdate> {
  parseStableVersion(currentVersion);
  const environment = updateChildEnvironment(inheritedEnvironment);
  const installation = await probe({
    packageRoot,
    cwd,
    environment,
  });
  if (installation.version !== currentVersion) {
    throw new Error(
      `Running Kintio ${currentVersion} differs from installed ${installation.version}`,
    );
  }
  const targetVersion = await fetchLatest();
  if (compareStableVersions(targetVersion, currentVersion) <= 0) {
    return Object.freeze({
      kind: 'current',
      currentVersion,
      targetVersion,
      installation,
    });
  }
  return Object.freeze({
    kind: 'update',
    currentVersion,
    targetVersion,
    installation,
    command: planGlobalInstall(installation, targetVersion),
    cwd,
    environment,
  });
}

export async function installPreparedKintioUpdate(
  update: Extract<PreparedKintioUpdate, { readonly kind: 'update' }>,
  run = runInherited,
): Promise<void> {
  const code = await run({
    file: update.command.file,
    args: update.command.args,
    cwd: update.cwd,
    env: update.environment,
  });
  if (code !== 0) {
    throw new Error(`${update.installation.manager} update exited with code ${code}`);
  }
}

export async function verifyPreparedKintioUpdate(
  update: Extract<PreparedKintioUpdate, { readonly kind: 'update' }>,
  {
    nodeExecutable = process.execPath,
    run = runCaptured,
  }: {
    readonly nodeExecutable?: string;
    readonly run?: typeof runCaptured;
  } = {},
): Promise<void> {
  const result = await run({
    file: nodeExecutable,
    args: [update.installation.binFile, '--version'],
    cwd: update.cwd,
    env: update.environment,
  }, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(`Updated Kintio version probe exited with code ${result.code}`);
  }
  if (result.stdout.trim() !== update.targetVersion) {
    throw new Error(
      `Updated Kintio version is ${JSON.stringify(result.stdout.trim())}, ` +
      `expected ${update.targetVersion}`,
    );
  }
}

export function runCaptured(
  request: ProcessRequest,
  { timeoutMs = 5_000 }: { readonly timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(request.file, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      operation();
    };
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > CAPTURE_LIMIT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('Update helper output exceeded its limit')));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`Update helper timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() => resolve({
      code: code ?? (signal ? 1 : 0),
      stdout,
      stderr,
    })));
  });
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupIsAlive(pid);
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = crossSpawn(
      'taskkill',
      ['/pid', String(pid), '/t', '/f'],
      {
        env: updateChildEnvironment(process.env),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    killer.once('error', reject);
    killer.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new ProcessTreeTerminationError('Package manager process has no PID');
  if (process.platform === 'win32') {
    try {
      await runWindowsTaskkill(pid);
    } catch (error: unknown) {
      child.kill('SIGKILL');
      throw new ProcessTreeTerminationError(
        `Unable to terminate the package manager process tree: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
      child.kill('SIGKILL');
      throw new ProcessTreeTerminationError(
        `Unable to signal the package manager process group: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  if (signal !== 'SIGKILL' && await waitForProcessGroupExit(pid, 5_000)) return;
  if (processGroupIsAlive(pid)) process.kill(-pid, 'SIGKILL');
  if (!(await waitForProcessGroupExit(pid, 5_000))) {
    child.kill('SIGKILL');
    throw new ProcessTreeTerminationError(
      'Package manager process group did not terminate',
    );
  }
}

export async function runInherited(
  request: ProcessRequest,
  { timeoutMs = 5 * 60_000 }: { readonly timeoutMs?: number } = {},
): Promise<number> {
  const child = crossSpawn(request.file, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio: 'inherit',
    detached: true,
    windowsHide: true,
  });
  const outcome = new Promise<{
    readonly code: number | null;
    readonly error?: Error;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const signals: readonly NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let interruptedBy: NodeJS.Signals | undefined;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const beginTermination = (signal: NodeJS.Signals): void => {
    if (termination) return;
    termination = terminateProcessTree(child, signal);
    void termination.catch(() => undefined);
  };
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedBy ||= signal;
    beginTermination(signal);
  };
  const listeners = signals.map((signal) => ({
    signal,
    listener: () => interrupt(signal),
  }));
  for (const { signal, listener } of listeners) process.on(signal, listener);
  const timer = setTimeout(() => {
    timedOut = true;
    beginTermination('SIGKILL');
  }, timeoutMs);
  try {
    const result = await outcome;
    if (termination) await termination;
    if (result.error) throw result.error;
    if (interruptedBy) {
      throw new Error(`Kintio package update was interrupted by ${interruptedBy}`);
    }
    if (timedOut) {
      throw new Error(`Kintio package update timed out after ${timeoutMs}ms`);
    }
    return result.code ?? (result.signal ? 1 : 0);
  } finally {
    clearTimeout(timer);
    for (const { signal, listener } of listeners) process.off(signal, listener);
  }
}
