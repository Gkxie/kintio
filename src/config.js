import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

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

function loadEnvironmentFile(filePath) {
  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function parsePort(value) {
  const port = Number(value ?? 8888);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseBoolean(value, fallback) {
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

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptionalEnum(value, allowedValues, name, fallback) {
  const parsed = value || fallback;

  if (parsed && !allowedValues.has(parsed)) {
    throw new Error(`${name} has an unsupported value: ${parsed}`);
  }

  return parsed || undefined;
}

function parseAllowedUserIds(value) {
  return Object.freeze(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseBoundedText(value, fallback, name, maxBytes) {
  const parsed = value === undefined ? fallback : String(value);

  if (Buffer.byteLength(parsed, 'utf8') > maxBytes) {
    throw new Error(`${name} must not exceed ${maxBytes} UTF-8 bytes`);
  }

  return parsed;
}

export function createConfig(environment = process.env) {
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
  const localAccessEnabled = parseBoolean(
    environment.CODEX_LOCAL_ACCESS,
    false,
  );
  const networkAccessEnabled = parseBoolean(
    environment.CODEX_NETWORK_ACCESS,
    false,
  );
  const webSearchMode = parseOptionalEnum(
    environment.CODEX_WEB_SEARCH_MODE,
    WEB_SEARCH_MODES,
    'CODEX_WEB_SEARCH_MODE',
    networkAccessEnabled ? 'live' : 'disabled',
  );
  const stateFile = path.resolve(
    environment.WECOM_STATE_FILE || path.join(projectRoot, 'data/wecom-state.json'),
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
    state: Object.freeze({ filePath: stateFile, pauseFile }),
    codex: Object.freeze({
      enabled: codexEnabled,
      localAccessEnabled,
      apiKey: environment.CODEX_API_KEY || '',
      baseUrl: environment.CODEX_BASE_URL || '',
      pathOverride: environment.CODEX_PATH || '',
      model: environment.CODEX_MODEL || '',
      reasoningEffort: parseOptionalEnum(
        environment.CODEX_REASONING_EFFORT,
        REASONING_EFFORTS,
        'CODEX_REASONING_EFFORT',
        undefined,
      ),
      sandboxMode: parseOptionalEnum(
        environment.CODEX_SANDBOX_MODE,
        SANDBOX_MODES,
        'CODEX_SANDBOX_MODE',
        'read-only',
      ),
      networkAccessEnabled,
      webSearchMode,
      imageTempDirectory: path.resolve(
        environment.CODEX_IMAGE_TMP_DIR || '/dev/shm',
      ),
      workingDirectory: path.resolve(
        environment.CODEX_WORKING_DIRECTORY ||
          path.join(projectRoot, 'codex-workspace'),
      ),
    }),
  });
}

export function loadConfig({ envFile = path.join(projectRoot, '.env') } = {}) {
  loadEnvironmentFile(envFile);
  return createConfig();
}
