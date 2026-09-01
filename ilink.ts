import {
  KINTIO_PACKAGE_ROOT,
  loadIlinkRuntimeConfig,
} from './src/config.ts';
import { startIlinkCliRuntime } from './src/ilink/cli-start.ts';
import { installManagedSkill } from './src/runtime/managed-skill.ts';

const config = loadIlinkRuntimeConfig();
installManagedSkill({
  packageRoot: KINTIO_PACKAGE_ROOT,
  workingDirectory: config.codex.workingDirectory,
});

const controller = new AbortController();
let resolveParentShutdown!: () => void;
const parentShutdown = new Promise<void>((resolve) => { resolveParentShutdown = resolve; });
const shutdown = (): void => {
  controller.abort();
  resolveParentShutdown();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const handleMessage = (message: unknown): void => {
  if (message === 'shutdown') shutdown();
};
process.on('message', handleMessage);
process.once('disconnect', shutdown);
if (process.env.KINTIO_MANAGED_WORKER === '1' && !process.connected) shutdown();

try {
  const result = await startIlinkCliRuntime({
    background: true,
    config,
    signal: controller.signal,
    stdout: (text) => process.stdout.write(text),
    onStarted() {
      process.send?.({ type: 'ready', pid: process.pid });
    },
  });
  if (result === 0 && process.connected) {
    process.send?.({ type: 'shutdown-request', pid: process.pid });
    await parentShutdown;
  }
  process.exitCode = result === 130 ? 0 : result;
} catch (error: unknown) {
  console.error('[ilink] process failed', error);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  process.off('disconnect', shutdown);
  process.off('message', handleMessage);
  if (process.connected) process.disconnect();
}
