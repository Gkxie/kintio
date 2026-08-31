import {
  FORCE_ABORT_TIMEOUT_MS,
  KINTIO_PACKAGE_ROOT,
  loadConfig,
} from './src/config.ts';
import { installManagedSkill } from './src/runtime/managed-skill.ts';
import { KintioSupervisor } from './src/supervisor.ts';

const config = loadConfig();
installManagedSkill({
  packageRoot: KINTIO_PACKAGE_ROOT,
  workingDirectory: config.codex.workingDirectory,
});
let rejectFatal!: (error: Error) => void;
const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
const supervisor = new KintioSupervisor({ config, onFatal: rejectFatal });
let shuttingDown = false;

async function forceAbort(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    supervisor.abortForExit().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, FORCE_ABORT_TIMEOUT_MS);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
}

async function shutdown(
  reason: NodeJS.Signals | 'parent shutdown' | 'parent disconnect',
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${reason}; shutting down`);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Graceful shutdown timed out')),
      config.state.shutdownTimeoutMs,
    );
    timeout.unref?.();
  });

  try {
    await Promise.race([supervisor.close(), timedOut]);
    clearTimeout(timeout);
    process.exit(0);
  } catch (error: unknown) {
    clearTimeout(timeout);
    console.error(error);
    await forceAbort();
    process.exit(1);
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown('parent shutdown');
});
process.once('disconnect', () => shutdown('parent disconnect'));
if (process.env.KINTIO_MANAGED_WORKER === '1' && !process.connected) {
  void shutdown('parent disconnect');
}

try {
  await supervisor.start();
  if (supervisor.state !== 'running' || shuttingDown) {
    throw new Error('Kintio supervisor stopped before readiness publication');
  }
  process.send?.({ type: 'ready', pid: process.pid });
  await fatal;
} catch (error: unknown) {
  if (!shuttingDown) {
    console.error('[supervisor] process failed', error);
    await forceAbort();
    process.exit(1);
  }
}
