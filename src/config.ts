import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { isPathInside } from './lib/path-identity.ts';

export function resolveProjectRoot(moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const parentDirectory = path.dirname(moduleDirectory);
  return path.basename(parentDirectory) === 'dist'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}

export const KINTIO_PACKAGE_ROOT = resolveProjectRoot(import.meta.url);

export const FORCE_ABORT_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;
export const WORKER_GRACEFUL_TIMEOUT_MS =
  MAX_SHUTDOWN_TIMEOUT_MS + FORCE_ABORT_TIMEOUT_MS + 2_000;
export const DAEMON_STOP_TIMEOUT_MS = WORKER_GRACEFUL_TIMEOUT_MS + 5_000 + 3_000;

export function parseStartTimeout(value: string | undefined): number {
  const timeout = Number(value || 30_000);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error(
      'KINTIO_START_TIMEOUT_MS must be an integer between 1000 and 120000',
    );
  }
  return timeout;
}

function resolveInstanceRoot(
  environment: NodeJS.ProcessEnv = process.env,
  fallback = path.join(os.homedir(), '.kintio'),
): string {
  return path.resolve(environment.KINTIO_HOME || fallback);
}

export function resolveStateFiles(
  environment: NodeJS.ProcessEnv = process.env,
  root = resolveInstanceRoot(environment),
  fileExists: (filePath: string) => boolean = fs.existsSync,
): { readonly databaseFile: string; readonly lockFile: string } {
  const configuredDatabaseFile =
    environment.KINTIO_DB_FILE ||
    environment.TALKFERRY_DB_FILE ||
    environment.HARNESS_DB_FILE ||
    environment.WECOM_DB_FILE;
  const defaultDatabaseFile = path.join(root, 'data/kintio.sqlite');
  const talkFerryDatabaseFile = path.join(root, 'data/talkferry.sqlite');
  const legacyDatabaseFile = path.join(root, 'data/wecom.sqlite');
  const existingDefaultFiles = [
    defaultDatabaseFile,
    talkFerryDatabaseFile,
    legacyDatabaseFile,
  ].filter(fileExists);
  if (!configuredDatabaseFile && existingDefaultFiles.length > 1) {
    const names = existingDefaultFiles.map((file) =>
      path.relative(root, file)
    ).join(', ');
    throw new Error(
      `Multiple default state databases exist (${names}); set KINTIO_DB_FILE explicitly`,
    );
  }
  const databaseFile = path.resolve(
    root,
    configuredDatabaseFile || existingDefaultFiles[0] || defaultDatabaseFile,
  );
  const originalDatabaseSelection =
    databaseFile === legacyDatabaseFile ||
    (
      !environment.KINTIO_DB_FILE &&
      !environment.TALKFERRY_DB_FILE &&
      Boolean(environment.HARNESS_DB_FILE || environment.WECOM_DB_FILE)
    );
  const talkFerryDatabaseSelection =
    !originalDatabaseSelection && (
      databaseFile === talkFerryDatabaseFile ||
      (!environment.KINTIO_DB_FILE && Boolean(environment.TALKFERRY_DB_FILE))
    );
  return Object.freeze({
    databaseFile,
    lockFile: path.join(
      path.dirname(databaseFile),
      originalDatabaseSelection
        ? 'wecom.lock'
        : talkFerryDatabaseSelection
          ? 'talkferry.lock'
          : 'kintio.lock',
    ),
  });
}

export interface CodexConfig {
  readonly enabled: boolean;
  readonly imageTempDirectory: string;
  readonly workingDirectory: string;
  readonly generatedImageDirectory: string;
}

export interface AppConfig {
  readonly port: number;
  readonly wecom: {
    readonly callbackToken: string;
    readonly encodingAesKey: string;
    readonly expectedReceiveId: string;
    readonly api: {
      readonly enabled: boolean;
      readonly corpId: string;
      readonly kfSecret: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly observeMs: number;
    };
    readonly allowedUserIds: readonly string[];
    readonly authorization: {
      readonly trigger: string;
      readonly requiredConsecutive: number;
      readonly confirmationText: string;
    };
  };
  readonly ilink: {
    readonly enabled: boolean;
    readonly storageKey: string;
    readonly storageKeyFile: string;
    readonly baseUrl: string;
    readonly apiTimeoutMs: number;
    readonly longPollTimeoutMs: number;
    readonly maxAccounts: number;
  };
  readonly state: {
    readonly databaseFile: string;
    readonly lockFile: string;
    readonly shutdownTimeoutMs: number;
  };
  readonly codex: CodexConfig;
}

export interface IlinkEnrollmentConfig {
  readonly home: string;
  readonly state: {
    readonly databaseFile: string;
    readonly lockFile: string;
  };
  readonly ilink: Omit<AppConfig['ilink'], 'enabled'>;
}

export type IlinkRuntimeConfig = Pick<AppConfig, 'state' | 'ilink' | 'codex'>;

interface ConfigLoadOptions {
  readonly envFile?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly root?: string;
}

function loadEnvironmentFile(
  filePath: string,
  environment: NodeJS.ProcessEnv,
): void {
  try {
    const parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
    for (const [name, value] of Object.entries(parsed)) {
      const key = process.platform === 'win32' ? name.toUpperCase() : name;
      if (environment[key] === undefined) environment[key] = value;
    }
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function copyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...environment };
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name.toUpperCase(), value]),
  );
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8888);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }

  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);

  return parsed;
}

function parseAllowedUserIds(value: string | undefined): readonly string[] {
  const parsed =
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  if (parsed.includes('*')) {
    throw new Error('WECOM_ALLOWED_USER_IDS does not support wildcard entries');
  }
  return Object.freeze(parsed);
}

function parseBoundedText(
  value: string | undefined,
  fallback: string,
  name: string,
  maxBytes: number,
): string {
  const parsed = value === undefined ? fallback : String(value);

  if (Buffer.byteLength(parsed, 'utf8') > maxBytes) {
    throw new Error(`${name} must not exceed ${maxBytes} UTF-8 bytes`);
  }

  return parsed;
}

function createIlinkEnrollmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
  root?: string,
  platform: NodeJS.Platform = process.platform,
): IlinkEnrollmentConfig {
  environment = copyEnvironment(environment);
  const home = path.resolve(root || resolveInstanceRoot(environment));
  const storageKey = String(environment.ILINK_STORAGE_KEY || '').trim();
  if (storageKey && !/^[A-Za-z0-9_-]{43}$/u.test(storageKey)) {
    throw new Error('ILINK_STORAGE_KEY must be a canonical 32-byte base64url value');
  }
  const state = resolveStateFiles(environment, home);
  const storageKeyFile = path.resolve(
    home,
    environment.ILINK_STORAGE_KEY_FILE ||
      path.join(path.dirname(state.databaseFile), 'ilink-storage.key'),
  );
  if (platform === 'win32') {
    for (const [name, filePath] of [
      ['KINTIO_DB_FILE', state.databaseFile],
      ['Kintio state lock', state.lockFile],
      ['ILINK_STORAGE_KEY_FILE', storageKeyFile],
    ] as const) {
      if (!isPathInside(home, filePath)) {
        throw new Error(`${name} must stay inside KINTIO_HOME on Windows`);
      }
    }
  }
  return Object.freeze({
    home,
    state,
    ilink: Object.freeze({
      storageKey,
      storageKeyFile,
      baseUrl: environment.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com/',
      apiTimeoutMs: parsePositiveInteger(
        environment.ILINK_API_TIMEOUT_MS,
        15_000,
        'ILINK_API_TIMEOUT_MS',
        120_000,
      ),
      longPollTimeoutMs: parsePositiveInteger(
        environment.ILINK_LONG_POLL_TIMEOUT_MS,
        35_000,
        'ILINK_LONG_POLL_TIMEOUT_MS',
        120_000,
      ),
      maxAccounts: parsePositiveInteger(
        environment.ILINK_MAX_ACCOUNTS,
        20,
        'ILINK_MAX_ACCOUNTS',
        1_000,
      ),
    }),
  });
}

export function createConfig(
  environment: NodeJS.ProcessEnv = process.env,
  root?: string,
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  environment = copyEnvironment(environment);
  const instanceRoot = path.resolve(root || resolveInstanceRoot(environment));
  const port = parsePort(environment.PORT);
  const callbackToken = environment.WECOM_CALLBACK_TOKEN || '';
  const encodingAesKey = environment.WECOM_ENCODING_AES_KEY || '';
  const corpId = (environment.WECOM_CORP_ID || '').trim();
  const kfSecret = (environment.WECOM_KF_SECRET || '').trim();

  if (Boolean(callbackToken) !== Boolean(encodingAesKey)) {
    throw new Error(
      'WECOM_CALLBACK_TOKEN and WECOM_ENCODING_AES_KEY must be configured together',
    );
  }
  if (callbackToken && !/^[A-Za-z0-9]{1,32}$/.test(callbackToken)) {
    throw new Error('WECOM_CALLBACK_TOKEN must contain 1 to 32 letters or digits');
  }

  if (encodingAesKey && !/^[A-Za-z0-9]{43}$/.test(encodingAesKey)) {
    throw new Error('WECOM_ENCODING_AES_KEY must contain 43 letters or digits');
  }

  if (Boolean(corpId) !== Boolean(kfSecret)) {
    throw new Error('WECOM_CORP_ID and WECOM_KF_SECRET must be configured together');
  }

  const apiEnabled = Boolean(corpId && kfSecret);
  if (apiEnabled && !String(environment.ILINK_ENABLED ?? '').trim()) {
    throw new Error(
      'ILINK_ENABLED must be explicitly true or false when WeChat KF API is enabled',
    );
  }
  const ilinkEnabled = parseBoolean(environment.ILINK_ENABLED, false);
  const codexEnabled = parseBoolean(
    environment.CODEX_ENABLED,
    apiEnabled || ilinkEnabled,
  );
  const enrollment = createIlinkEnrollmentConfig(environment, instanceRoot, platform);
  const { databaseFile, lockFile } = enrollment.state;
  const codexWorkingDirectory = path.resolve(
    instanceRoot,
    environment.CODEX_WORKING_DIRECTORY ||
      'codex-workspace',
  );
  const codexImageTempDirectory = path.resolve(
    instanceRoot,
    environment.CODEX_IMAGE_TMP_DIR ||
      'data/codex-input',
  );
  if (platform === 'win32') {
    for (const [name, filePath] of [
      ['CODEX_IMAGE_TMP_DIR', codexImageTempDirectory],
    ] as const) {
      if (!isPathInside(instanceRoot, filePath)) {
        throw new Error(`${name} must stay inside KINTIO_HOME on Windows`);
      }
    }
  }
  const apiTimeoutMs = parsePositiveInteger(
    environment.WECOM_API_TIMEOUT_MS,
    10_000,
    'WECOM_API_TIMEOUT_MS',
    120_000,
  );
  const shutdownTimeoutMs = parsePositiveInteger(
    environment.SHUTDOWN_TIMEOUT_MS,
    10_000,
    'SHUTDOWN_TIMEOUT_MS',
    MAX_SHUTDOWN_TIMEOUT_MS,
  );
  if (shutdownTimeoutMs < 1_000) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be at least 1000');
  }

  return Object.freeze({
    port,
    wecom: Object.freeze({
      callbackToken,
      encodingAesKey,
      expectedReceiveId: environment.WECOM_RECEIVE_ID || corpId,
      api: Object.freeze({
        enabled: apiEnabled,
        corpId,
        kfSecret,
        baseUrl: environment.WECOM_API_BASE_URL || 'https://qyapi.weixin.qq.com',
        timeoutMs: apiTimeoutMs,
        observeMs: parsePositiveInteger(
          environment.WECOM_MCP_OBSERVE_MS,
          5_000,
          'WECOM_MCP_OBSERVE_MS',
          20_000,
        ),
      }),
      allowedUserIds: parseAllowedUserIds(environment.WECOM_ALLOWED_USER_IDS),
      authorization: Object.freeze({
        trigger: parseBoundedText(
          environment.WECOM_AUTH_TRIGGER,
          '',
          'WECOM_AUTH_TRIGGER',
          128,
        ),
        requiredConsecutive: parsePositiveInteger(
          environment.WECOM_AUTH_TRIGGER_COUNT,
          3,
          'WECOM_AUTH_TRIGGER_COUNT',
        ),
        confirmationText: parseBoundedText(
          environment.WECOM_AUTH_CONFIRMATION,
          'Code accepted. You can continue the conversation.',
          'WECOM_AUTH_CONFIRMATION',
          2048,
        ),
      }),
    }),
    ilink: Object.freeze({
      enabled: ilinkEnabled,
      ...enrollment.ilink,
    }),
    state: Object.freeze({
      databaseFile,
      lockFile,
      shutdownTimeoutMs,
    }),
    codex: Object.freeze({
      enabled: codexEnabled,
      imageTempDirectory: codexImageTempDirectory,
      workingDirectory: codexWorkingDirectory,
      generatedImageDirectory: path.join(codexWorkingDirectory, 'generated_images'),
    }),
  });
}

export function loadConfig(
  options: ConfigLoadOptions = {},
): AppConfig {
  const loaded = loadConfigurationEnvironment(options);
  return createConfig(loaded.environment, loaded.root);
}

function loadConfigurationEnvironment(options: ConfigLoadOptions) {
  const environment = copyEnvironment(options.environment || process.env);
  const configuredEnvFile = options.envFile || environment.KINTIO_CONFIG_FILE;
  const defaultRoot = path.join(
    path.resolve(options.homeDirectory || os.homedir()),
    '.kintio',
  );
  const initialRoot = path.resolve(
    options.root ||
      environment.KINTIO_HOME ||
      (configuredEnvFile
        ? path.dirname(path.resolve(configuredEnvFile))
        : defaultRoot),
  );
  const envFile = path.resolve(
    configuredEnvFile || path.join(initialRoot, '.env'),
  );
  loadEnvironmentFile(envFile, environment);
  const root = path.resolve(options.root || environment.KINTIO_HOME || initialRoot);
  return { environment, root };
}

export function loadIlinkEnrollmentConfig(
  options: ConfigLoadOptions = {},
): IlinkEnrollmentConfig {
  const loaded = loadConfigurationEnvironment(options);
  return createIlinkEnrollmentConfig(loaded.environment, loaded.root);
}

export function loadIlinkRuntimeConfig(
  options: ConfigLoadOptions = {},
): IlinkRuntimeConfig {
  const { environment, root } = loadConfigurationEnvironment(options);
  const enrollment = createIlinkEnrollmentConfig(environment, root);
  const workingDirectory = path.resolve(
    root,
    environment.CODEX_WORKING_DIRECTORY || 'codex-workspace',
  );
  const imageTempDirectory = path.resolve(
    root,
    environment.CODEX_IMAGE_TMP_DIR || 'data/codex-input',
  );
  if (process.platform === 'win32' && !isPathInside(root, imageTempDirectory)) {
    throw new Error('CODEX_IMAGE_TMP_DIR must stay inside KINTIO_HOME on Windows');
  }
  const shutdownTimeoutMs = parsePositiveInteger(
    environment.SHUTDOWN_TIMEOUT_MS,
    10_000,
    'SHUTDOWN_TIMEOUT_MS',
    MAX_SHUTDOWN_TIMEOUT_MS,
  );
  if (shutdownTimeoutMs < 1_000) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be at least 1000');
  }
  return Object.freeze({
    state: Object.freeze({
      ...enrollment.state,
      shutdownTimeoutMs,
    }),
    ilink: Object.freeze({ enabled: true, ...enrollment.ilink }),
    codex: Object.freeze({
      enabled: true,
      imageTempDirectory,
      workingDirectory,
      generatedImageDirectory: path.join(workingDirectory, 'generated_images'),
    }),
  });
}
