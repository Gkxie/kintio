import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveProjectRoot(moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const parentDirectory = path.dirname(moduleDirectory);
  return path.basename(parentDirectory) === 'dist'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}

const projectRoot = resolveProjectRoot(import.meta.url);

export function resolveStateFiles(
  environment: NodeJS.ProcessEnv = process.env,
  root = projectRoot,
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

const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const WEB_SEARCH_MODES = new Set(['disabled', 'cached', 'live']);
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
type WebSearchMode = 'disabled' | 'cached' | 'live';

export interface CodexConfig {
  readonly enabled: boolean;
  readonly pathOverride: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly webSearchMode: WebSearchMode;
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
    readonly mcp: {
      readonly url: string;
      readonly memoryUrl: string;
      readonly bearerToken: string;
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
    readonly mcpUrl: string;
  };
  readonly state: {
    readonly databaseFile: string;
    readonly lockFile: string;
    readonly shutdownTimeoutMs: number;
  };
  readonly codex: CodexConfig;
}

function loadEnvironmentFile(filePath: string): void {
  try {
    process.loadEnvFile(filePath);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
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

function parseOptionalEnum<T extends string>(
  value: string | undefined,
  allowedValues: ReadonlySet<string>,
  name: string,
  fallback?: T,
): T | undefined {
  const parsed = value || fallback;

  if (parsed && !allowedValues.has(parsed)) {
    throw new Error(`${name} has an unsupported value: ${parsed}`);
  }

  return (parsed || undefined) as T | undefined;
}

function parseAllowedUserIds(value: string | undefined): readonly string[] {
  return Object.freeze(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
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

export function createConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
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
  const ilinkEnabled = parseBoolean(environment.ILINK_ENABLED, apiEnabled);
  const codexEnabled = parseBoolean(
    environment.CODEX_ENABLED,
    apiEnabled || ilinkEnabled,
  );
  const ilinkStorageKey = String(environment.ILINK_STORAGE_KEY || '').trim();
  if (ilinkStorageKey && !/^[A-Za-z0-9_-]{43}$/u.test(ilinkStorageKey)) {
    throw new Error('ILINK_STORAGE_KEY must be a canonical 32-byte base64url value');
  }
  const mcpBearerToken = String(
    environment.KINTIO_MCP_BEARER_TOKEN ||
    environment.TALKFERRY_MCP_BEARER_TOKEN ||
    environment.HARNESS_MCP_BEARER_TOKEN ||
    environment.WECOM_MCP_BEARER_TOKEN ||
    '',
  ).trim();
  if (
    (apiEnabled || ilinkEnabled) && codexEnabled &&
    !/^[A-Za-z0-9_-]{32,128}$/u.test(mcpBearerToken)
  ) {
    throw new Error(
      'KINTIO_MCP_BEARER_TOKEN must contain 32 to 128 URL-safe characters',
    );
  }
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(
      environment.KINTIO_MCP_URL ||
      environment.TALKFERRY_MCP_URL ||
      environment.HARNESS_MCP_URL ||
      environment.WECOM_MCP_URL ||
      `http://127.0.0.1:${port}/mcp`,
    );
  } catch {
    throw new Error('KINTIO_MCP_URL must be a valid HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(mcpUrl.protocol) ||
    mcpUrl.username || mcpUrl.password || mcpUrl.hash
  ) {
    throw new Error('KINTIO_MCP_URL must be an HTTP(S) URL without credentials or hash');
  }
  if (
    mcpUrl.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(mcpUrl.hostname.toLowerCase())
  ) {
    throw new Error('KINTIO_MCP_URL requires HTTPS unless it uses a loopback host');
  }
  const memoryMcpUrl = new URL(mcpUrl);
  memoryMcpUrl.pathname = `${mcpUrl.pathname.replace(/\/+$/u, '')}/memory`;
  const ilinkMcpUrl = new URL(mcpUrl);
  ilinkMcpUrl.pathname = `${mcpUrl.pathname.replace(/\/+$/u, '')}/ilink`;
  const webSearchMode = parseOptionalEnum<WebSearchMode>(
    environment.CODEX_WEB_SEARCH_MODE,
    WEB_SEARCH_MODES,
    'CODEX_WEB_SEARCH_MODE',
    'live',
  );
  const { databaseFile, lockFile } = resolveStateFiles(environment);
  const codexWorkingDirectory = path.resolve(
    environment.CODEX_WORKING_DIRECTORY ||
      path.join(projectRoot, 'codex-workspace'),
  );
  const apiTimeoutMs = parsePositiveInteger(
    environment.WECOM_API_TIMEOUT_MS,
    10_000,
    'WECOM_API_TIMEOUT_MS',
    120_000,
  );

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
      mcp: Object.freeze({
        url: mcpUrl.toString(),
        memoryUrl: memoryMcpUrl.toString(),
        bearerToken: mcpBearerToken,
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
      storageKey: ilinkStorageKey,
      storageKeyFile: path.resolve(
        environment.ILINK_STORAGE_KEY_FILE ||
          path.join(path.dirname(databaseFile), 'ilink-storage.key'),
      ),
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
      mcpUrl: ilinkMcpUrl.toString(),
    }),
    state: Object.freeze({
      databaseFile,
      lockFile,
      shutdownTimeoutMs: parsePositiveInteger(
        environment.SHUTDOWN_TIMEOUT_MS,
        10_000,
        'SHUTDOWN_TIMEOUT_MS',
      ),
    }),
    codex: Object.freeze({
      enabled: codexEnabled,
      pathOverride: environment.CODEX_PATH || 'codex',
      model: environment.CODEX_MODEL || '',
      reasoningEffort: parseOptionalEnum<ReasoningEffort>(
        environment.CODEX_REASONING_EFFORT,
        REASONING_EFFORTS,
        'CODEX_REASONING_EFFORT',
        undefined,
      ),
      webSearchMode: webSearchMode ?? 'live',
      imageTempDirectory: path.resolve(
        environment.CODEX_IMAGE_TMP_DIR ||
          path.join(projectRoot, 'data/codex-input'),
      ),
      workingDirectory: codexWorkingDirectory,
      generatedImageDirectory: path.join(codexWorkingDirectory, 'generated_images'),
    }),
  });
}

export function loadConfig(
  { envFile = path.join(projectRoot, '.env') }: { envFile?: string } = {},
): AppConfig {
  loadEnvironmentFile(envFile);
  return createConfig();
}
