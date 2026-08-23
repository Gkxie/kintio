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

const SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
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
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type WebSearchMode = 'disabled' | 'cached' | 'live';

export interface CodexConfig {
  readonly enabled: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly pathOverride: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly sandboxMode: SandboxMode;
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
      readonly timeoutMs: number;
    };
    readonly allowedUserIds: readonly string[];
    readonly authorization: {
      readonly trigger: string;
      readonly requiredConsecutive: number;
      readonly confirmationText: string;
    };
  };
  readonly state: {
    readonly databaseFile: string;
    readonly legacyStateFile: string;
    readonly legacyJournalFile: string;
    readonly legacyPauseFile: string;
    readonly lockFile: string;
    readonly spoolDirectory: string;
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
): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

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
  const callbackToken = environment.WECOM_CALLBACK_TOKEN || '';
  const encodingAesKey = environment.WECOM_ENCODING_AES_KEY || '';
  const corpId = (environment.WECOM_CORP_ID || '').trim();
  const kfSecret = (environment.WECOM_KF_SECRET || '').trim();

  if (!/^[A-Za-z0-9]{1,32}$/.test(callbackToken)) {
    throw new Error('WECOM_CALLBACK_TOKEN must contain 1 to 32 letters or digits');
  }

  if (!/^[A-Za-z0-9]{43}$/.test(encodingAesKey)) {
    throw new Error('WECOM_ENCODING_AES_KEY must contain 43 letters or digits');
  }

  if (Boolean(corpId) !== Boolean(kfSecret)) {
    throw new Error('WECOM_CORP_ID and WECOM_KF_SECRET must be configured together');
  }

  const apiEnabled = Boolean(corpId && kfSecret);
  const codexEnabled = parseBoolean(environment.CODEX_ENABLED, apiEnabled);
  const webSearchMode = parseOptionalEnum<WebSearchMode>(
    environment.CODEX_WEB_SEARCH_MODE,
    WEB_SEARCH_MODES,
    'CODEX_WEB_SEARCH_MODE',
    'live',
  );
  const stateFile = path.resolve(
    environment.WECOM_STATE_FILE || path.join(projectRoot, 'data/wecom-state.json'),
  );
  const databaseFile = path.resolve(
    environment.WECOM_DB_FILE || path.join(projectRoot, 'data/wecom.sqlite'),
  );
  const legacyJournalFile = path.resolve(
    environment.WECOM_LEGACY_JOURNAL_FILE ||
      path.join(path.dirname(stateFile), 'wecom-tool-journal.sqlite'),
  );
  const pauseFile = path.resolve(
    environment.WECOM_BOT_PAUSE_FILE || path.join(projectRoot, 'data/bot-paused'),
  );

  return Object.freeze({
    port: parsePort(environment.PORT),
    wecom: Object.freeze({
      callbackToken,
      encodingAesKey,
      expectedReceiveId: environment.WECOM_RECEIVE_ID || corpId,
      api: Object.freeze({
        enabled: apiEnabled,
        corpId,
        kfSecret,
        timeoutMs: parsePositiveInteger(
          environment.WECOM_API_TIMEOUT_MS,
          10_000,
          'WECOM_API_TIMEOUT_MS',
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
          '暗号确认，请继续对话',
          'WECOM_AUTH_CONFIRMATION',
          2048,
        ),
      }),
    }),
    state: Object.freeze({
      databaseFile,
      legacyStateFile: stateFile,
      legacyJournalFile,
      legacyPauseFile: pauseFile,
      lockFile: path.join(path.dirname(databaseFile), 'wecom.lock'),
      spoolDirectory: path.join(path.dirname(databaseFile), 'spool'),
      shutdownTimeoutMs: parsePositiveInteger(
        environment.SHUTDOWN_TIMEOUT_MS,
        10_000,
        'SHUTDOWN_TIMEOUT_MS',
      ),
    }),
    codex: Object.freeze({
      enabled: codexEnabled,
      apiKey: environment.CODEX_API_KEY || '',
      baseUrl: environment.CODEX_BASE_URL || '',
      pathOverride: environment.CODEX_PATH || 'codex',
      model: environment.CODEX_MODEL || '',
      reasoningEffort: parseOptionalEnum<ReasoningEffort>(
        environment.CODEX_REASONING_EFFORT,
        REASONING_EFFORTS,
        'CODEX_REASONING_EFFORT',
        undefined,
      ),
      sandboxMode: parseOptionalEnum<SandboxMode>(
        environment.CODEX_SANDBOX_MODE,
        SANDBOX_MODES,
        'CODEX_SANDBOX_MODE',
        'read-only',
      ) ?? 'read-only',
      webSearchMode: webSearchMode ?? 'live',
      imageTempDirectory: path.resolve(
        environment.CODEX_IMAGE_TMP_DIR ||
          path.join(projectRoot, 'data/codex-input'),
      ),
      workingDirectory: path.resolve(
        environment.CODEX_WORKING_DIRECTORY ||
          path.join(projectRoot, 'codex-workspace'),
      ),
      generatedImageDirectory: path.resolve(
        environment.CODEX_GENERATED_IMAGE_DIR ||
          path.join(projectRoot, 'codex-workspace/generated_images'),
      ),
    }),
  });
}

export function loadConfig(
  { envFile = path.join(projectRoot, '.env') }: { envFile?: string } = {},
): AppConfig {
  loadEnvironmentFile(envFile);
  return createConfig();
}
