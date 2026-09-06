import fs from 'node:fs';
import path from 'node:path';

import { canonicalPath } from '../lib/path-identity.ts';

const KINTIO_PACKAGE_NAME = '@kin-tio/cli';
const KINTIO_BIN_RELATIVE_PATH = 'bin/kintio.js';
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';

const PACKAGE_JSON_LIMIT_BYTES = 64 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface InstalledPackageIdentity {
  readonly packageRoot: string;
  readonly realPackageRoot: string;
  readonly binFile: string;
  readonly realBinFile: string;
  readonly version: string;
}

interface NpmGlobalProbe {
  readonly prefix: string;
}

interface PnpmGlobalProbe {
  /** Exact, trimmed output of `pnpm root --global`. */
  readonly root: string;
  /** Effective pnpm `globalDir`, before pnpm's layout-version directory. */
  readonly globalDir: string;
  /** Effective pnpm `globalBinDir`. */
  readonly globalBinDir: string;
}

interface InstallationBase extends InstalledPackageIdentity {
  /** Stable logical package path, never a pnpm virtual-store path. */
  readonly packageRoot: string;
  /** Stable logical package-bin path used for post-install verification. */
  readonly binFile: string;
}

interface NpmGlobalInstallation extends InstallationBase {
  readonly manager: 'npm';
  readonly prefix: string;
}

interface PnpmGlobalInstallation extends InstallationBase {
  readonly manager: 'pnpm';
  readonly globalDir: string;
  readonly globalBinDir: string;
}

export type GlobalInstallation = NpmGlobalInstallation | PnpmGlobalInstallation;

export interface GlobalInstallCommand {
  readonly file: 'npm' | 'pnpm';
  readonly args: readonly string[];
}

interface DetectionPolicy {
  readonly npm?: NpmGlobalProbe;
  readonly pnpm?: PnpmGlobalProbe;
  readonly platform?: NodeJS.Platform;
  readonly canonicalize?: (filePath: string) => string;
  readonly pathIsDirectory?: (filePath: string) => boolean;
  readonly pathIsFile?: (filePath: string) => boolean;
  readonly pathIsSymbolicLink?: (filePath: string) => boolean;
}

export interface DetectGlobalInstallationOptions extends DetectionPolicy {
  readonly packageRoot: string;
}

export interface DetectGlobalInstallationFromIdentityOptions extends DetectionPolicy {
  readonly identity: InstalledPackageIdentity;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function regularFile(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return stat;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function assertExactStableVersion(version: string): string {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`Kintio update requires an exact stable X.Y.Z version: ${version}`);
  }
  return version;
}

export function readInstalledPackageIdentity(
  packageRoot: string,
): InstalledPackageIdentity {
  if (!packageRoot || !path.isAbsolute(packageRoot) || packageRoot.includes('\0')) {
    throw new Error('Kintio package root must be an absolute path');
  }
  const logicalRoot = path.normalize(packageRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(logicalRoot);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error(`Kintio package root is missing: ${logicalRoot}`);
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Kintio package root must be a directory: ${logicalRoot}`);
  }

  const manifestFile = path.join(logicalRoot, 'package.json');
  const manifestStat = regularFile(manifestFile, 'Kintio package manifest');
  if (manifestStat.size > PACKAGE_JSON_LIMIT_BYTES) {
    throw new Error(`Kintio package manifest exceeds ${PACKAGE_JSON_LIMIT_BYTES} bytes`);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = record(JSON.parse(fs.readFileSync(manifestFile, 'utf8'))) || {};
  } catch (error: unknown) {
    throw new Error(
      `Kintio package manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (manifest.name !== KINTIO_PACKAGE_NAME) {
    throw new Error(`Kintio package identity is invalid: ${String(manifest.name || '')}`);
  }
  if (typeof manifest.version !== 'string') {
    throw new Error('Kintio package version is missing');
  }
  const version = assertExactStableVersion(manifest.version);
  const bins = record(manifest.bin);
  if (bins?.kintio !== KINTIO_BIN_RELATIVE_PATH) {
    throw new Error(`Kintio package bin must be ${KINTIO_BIN_RELATIVE_PATH}`);
  }

  const binFile = path.join(logicalRoot, ...KINTIO_BIN_RELATIVE_PATH.split('/'));
  regularFile(binFile, 'Kintio package bin');
  return Object.freeze({
    packageRoot: logicalRoot,
    realPackageRoot: fs.realpathSync.native(logicalRoot),
    binFile,
    realBinFile: fs.realpathSync.native(binFile),
    version,
  });
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function absolutePath(
  value: string,
  label: string,
  platform: NodeJS.Platform,
): string {
  const api = pathApi(platform);
  if (!value || value.includes('\0') || !api.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return api.normalize(value);
}

function normalizedIdentity(
  value: string,
  platform: NodeJS.Platform,
  canonicalize: (filePath: string) => string,
): string {
  const normalized = pathApi(platform).normalize(canonicalize(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameIdentity(
  left: string,
  right: string,
  platform: NodeJS.Platform,
  canonicalize: (filePath: string) => string,
): boolean {
  return normalizedIdentity(left, platform, canonicalize) ===
    normalizedIdentity(right, platform, canonicalize);
}

function insideOrEqual(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
  canonicalize: (filePath: string) => string,
): boolean {
  const api = pathApi(platform);
  const relative = api.relative(
    normalizedIdentity(root, platform, canonicalize),
    normalizedIdentity(candidate, platform, canonicalize),
  );
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

function defaultIsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function defaultIsSymbolicLink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function stableIdentity(
  identity: InstalledPackageIdentity,
  packageRoot: string,
  platform: NodeJS.Platform,
  canonicalize: (filePath: string) => string,
  pathIsDirectory: (filePath: string) => boolean,
  pathIsFile: (filePath: string) => boolean,
): Pick<InstallationBase, 'packageRoot' | 'binFile'> | undefined {
  const api = pathApi(platform);
  const binFile = api.join(packageRoot, ...KINTIO_BIN_RELATIVE_PATH.split('/'));
  if (!pathIsDirectory(packageRoot) || !pathIsFile(binFile)) return undefined;
  if (
    !sameIdentity(packageRoot, identity.realPackageRoot, platform, canonicalize) ||
    !sameIdentity(binFile, identity.realBinFile, platform, canonicalize)
  ) return undefined;
  return { packageRoot, binFile };
}

function installationBase(
  identity: InstalledPackageIdentity,
  stable: Pick<InstallationBase, 'packageRoot' | 'binFile'>,
): InstallationBase {
  return {
    ...identity,
    packageRoot: stable.packageRoot,
    binFile: stable.binFile,
  };
}

export function detectGlobalInstallationFromIdentity({
  identity,
  npm,
  pnpm,
  platform = process.platform,
  canonicalize = canonicalPath,
  pathIsDirectory = defaultIsDirectory,
  pathIsFile = defaultIsFile,
  pathIsSymbolicLink = defaultIsSymbolicLink,
}: DetectGlobalInstallationFromIdentityOptions): GlobalInstallation {
  const api = pathApi(platform);
  const matches: GlobalInstallation[] = [];

  if (npm) {
    const prefix = absolutePath(npm.prefix, 'npm global prefix', platform);
    const packageRoot = platform === 'win32'
      ? api.join(prefix, 'node_modules', '@kin-tio', 'cli')
      : api.join(prefix, 'lib', 'node_modules', '@kin-tio', 'cli');
    const stable = stableIdentity(
      identity,
      packageRoot,
      platform,
      canonicalize,
      pathIsDirectory,
      pathIsFile,
    );
    // A global npm link has the same real path but is not an owned package copy.
    if (stable && !pathIsSymbolicLink(packageRoot)) {
      matches.push(Object.freeze({
        ...installationBase(identity, stable),
        manager: 'npm',
        prefix,
      }));
    }
  }

  if (pnpm) {
    const root = absolutePath(pnpm.root, 'pnpm global package root', platform);
    const globalDir = absolutePath(pnpm.globalDir, 'pnpm global directory', platform);
    const globalBinDir = absolutePath(
      pnpm.globalBinDir,
      'pnpm global bin directory',
      platform,
    );
    if (
      pathIsDirectory(root) &&
      pathIsDirectory(globalDir) &&
      pathIsDirectory(globalBinDir) &&
      insideOrEqual(globalDir, root, platform, canonicalize)
    ) {
      const candidates = [
        api.join(root, '@kin-tio', 'cli'),
        api.join(root, 'node_modules', '@kin-tio', 'cli'),
      ];
      const logical = new Set<string>();
      const stableMatches = candidates.flatMap((candidate) => {
        const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (logical.has(key)) return [];
        logical.add(key);
        const stable = stableIdentity(
          identity,
          candidate,
          platform,
          canonicalize,
          pathIsDirectory,
          pathIsFile,
        );
        return stable ? [stable] : [];
      });
      if (stableMatches.length > 1) {
        throw new Error('pnpm global installation has more than one matching package root');
      }
      const stable = stableMatches[0];
      if (stable) {
        matches.push(Object.freeze({
          ...installationBase(identity, stable),
          manager: 'pnpm',
          globalDir,
          globalBinDir,
        }));
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(
      'Kintio update requires an unambiguous global npm or pnpm installation',
    );
  }
  if (matches.length > 1) {
    throw new Error('Kintio global installation ownership is ambiguous');
  }
  return matches[0]!;
}

export function detectGlobalInstallation({
  packageRoot,
  ...policy
}: DetectGlobalInstallationOptions): GlobalInstallation {
  return detectGlobalInstallationFromIdentity({
    identity: readInstalledPackageIdentity(packageRoot),
    ...policy,
  });
}

export function planGlobalInstall(
  installation: GlobalInstallation,
  exactVersion: string,
): GlobalInstallCommand {
  const version = assertExactStableVersion(exactVersion);
  const packageSpec = `${KINTIO_PACKAGE_NAME}@${version}`;
  const args = installation.manager === 'npm'
    ? [
        'install',
        '--global',
        '--prefix', installation.prefix,
        '--registry', OFFICIAL_NPM_REGISTRY,
        '--ignore-scripts',
        packageSpec,
      ]
    : [
        'add',
        '--global',
        '--global-dir', installation.globalDir,
        '--global-bin-dir', installation.globalBinDir,
        '--registry', OFFICIAL_NPM_REGISTRY,
        '--ignore-scripts',
        packageSpec,
      ];
  return Object.freeze({
    file: installation.manager,
    args: Object.freeze(args),
  });
}
