import { loadConfig } from './src/config.ts';
import { writeReadyMarker } from './src/runtime/ready-marker.ts';
import { KintioSupervisor } from './src/supervisor.ts';

const config = loadConfig();
let rejectFatal!: (error: Error) => void;
const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
const supervisor = new KintioSupervisor({ config, onFatal: rejectFatal });
let shuttingDown = false;

async function forceAbort(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    supervisor.abortForExit().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 5_000);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
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

try {
  await supervisor.start();
  if (supervisor.state !== 'running' || shuttingDown) {
    throw new Error('Kintio supervisor stopped before readiness publication');
  }
  const startToken = process.env.KINTIO_START_TOKEN;
  if (startToken) {
    const instanceRoot = process.env.KINTIO_HOME;
    if (!instanceRoot) throw new Error('KINTIO_HOME is required for PM2 readiness');
    writeReadyMarker(instanceRoot, startToken);
  }
  await fatal;
} catch (error: unknown) {
  if (!shuttingDown) {
    console.error('[supervisor] process failed', error);
    await forceAbort();
    process.exit(1);
  }
}
