import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('[DEP02] runtime keeps project Codex configuration isolated from the user configuration', async (t) => {
  const temporary = await createTempSqlite(t, {
    prefix: 'wechat-runtime-',
    filename: 'wecom.sqlite',
  });
  const codexHome = path.join(temporary.directory, 'user-codex-home');
  const userConfigPath = path.join(codexHome, 'config.toml');
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    userConfigPath,
    'model = "gpt-user-cli"\nmodel_reasoning_effort = "max"\n',
    { mode: 0o600 },
  );
  const originalConfig = await fs.readFile(userConfigPath);
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'CallbackToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-runtime-test',
    WECOM_KF_SECRET: 'runtime-secret',
    WECOM_ALLOWED_USER_IDS: 'wm-runtime-test',
    WECOM_DB_FILE: temporary.filePath,
    WECOM_STATE_FILE: path.join(temporary.directory, 'legacy-state.json'),
    WECOM_LEGACY_JOURNAL_FILE: path.join(
      temporary.directory,
      'legacy-journal.sqlite',
    ),
    WECOM_BOT_PAUSE_FILE: path.join(temporary.directory, 'legacy-pause'),
    CODEX_MODEL: 'gpt-project-runtime',
    CODEX_REASONING_EFFORT: 'low',
    CODEX_WORKING_DIRECTORY: path.join(temporary.directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(temporary.directory, 'image-inputs'),
    CODEX_WEB_SEARCH_MODE: 'disabled',
  });
  const runtime = createRuntime({
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  let closed = false;
  t.after(async () => {
    if (!closed) await runtime.close();
  });

  assert.ok(runtime.messageProcessor);
  assert.equal((await fs.stat(temporary.filePath)).mode & 0o777, 0o600);
  await fs.access(config.state.lockFile);

  await runtime.close();
  closed = true;

  await assert.rejects(() => fs.access(config.state.lockFile), { code: 'ENOENT' });
  const finalConfig = await fs.readFile(userConfigPath);
  assert.equal(sha256(finalConfig), sha256(originalConfig));
  assert.deepEqual(finalConfig, originalConfig);
});
