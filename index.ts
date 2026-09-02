import {
  FORCE_ABORT_TIMEOUT_MS,
  KINTIO_PACKAGE_ROOT,
  loadConfig,
} from './src/config.ts';
import { installManagedSkill } from './src/runtime/managed-skill.ts';
import {
  CONTROL_TIMEOUT_MS,
  parseWorkerStopIfIdleRequest,
  type WorkerStopIfIdleResponse,
} from './src/runtime/daemon-protocol.ts';
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
let updateGateRecoveryTimer: NodeJS.Timeout | undefined;

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
  reason:
    | NodeJS.Signals
    | 'parent shutdown'
    | 'parent disconnect'
    | 'update control failure',
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(updateGateRecoveryTimer);
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
  if (message === 'shutdown') {
    void shutdown('parent shutdown');
    return;
  }
  if (
    !message || typeof message !== 'object' || !('type' in message) ||
    message.type !== 'stop-if-idle'
  ) return;
  let request;
  try {
    request = parseWorkerStopIfIdleRequest(message);
  } catch {
    return;
  }
  let response: WorkerStopIfIdleResponse;
  try {
    response = {
      type: 'stop-if-idle-result',
      requestId: request.requestId,
      pid: process.pid,
      ok: true,
      idle: supervisor.stopIfIdleForUpdate(),
    };
  } catch (error: unknown) {
    response = {
      type: 'stop-if-idle-result',
      requestId: request.requestId,
      pid: process.pid,
      ok: false,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048) ||
        'Worker stop-if-idle check failed',
    };
  }
  const recoverOnSendFailure = (error: Error | null): void => {
    if (error && response.ok && response.idle) void shutdown('update control failure');
  };
  try {
    if (!process.send) {
      if (response.ok && response.idle) void shutdown('update control failure');
      return;
    }
    process.send(response, recoverOnSendFailure);
    if (response.ok && response.idle) {
      updateGateRecoveryTimer = setTimeout(
        () => { void shutdown('update control failure'); },
        CONTROL_TIMEOUT_MS * 2,
      );
      updateGateRecoveryTimer.unref?.();
    }
  } catch {
    if (response.ok && response.idle) void shutdown('update control failure');
  }
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
