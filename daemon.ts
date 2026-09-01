import fs from 'node:fs';
import path from 'node:path';

import { resolveProjectRoot } from './src/config.ts';
import { runNativeDaemon } from './src/runtime/native-daemon.ts';

const home = process.env.KINTIO_HOME;
const configFile = process.env.KINTIO_CONFIG_FILE;
const mode = process.env.KINTIO_DAEMON_MODE || 'service';
if (!home || !configFile) {
  throw new Error('KINTIO_HOME and KINTIO_CONFIG_FILE are required for daemon mode');
}
if (mode !== 'service' && mode !== 'ilink') {
  throw new Error(`Unsupported Kintio daemon mode: ${mode}`);
}

try {
  await runNativeDaemon({
    home: path.resolve(home),
    configFile: path.resolve(configFile),
    mode,
    packageRoot: resolveProjectRoot(import.meta.url),
  });
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    const directory = path.join(path.resolve(home), 'data/logs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(directory, 'kintio.log'),
      `[daemon] ${new Date().toISOString()} startup failed: ${message}\n`,
      { mode: 0o600 },
    );
  } catch {
    // There is no secondary output channel in detached mode.
  }
  process.exitCode = 1;
}
