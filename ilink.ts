import {
  KINTIO_PACKAGE_ROOT,
  loadIlinkRuntimeConfig,
} from './src/config.ts';
import { startIlinkCliRuntime } from './src/ilink/cli-start.ts';
import { installManagedSkill } from './src/runtime/managed-skill.ts';
import {
  CONTROL_TIMEOUT_MS,
  parseWorkerStopIfIdleRequest,
  type WorkerStopIfIdleResponse,
} from './src/runtime/daemon-protocol.ts';

const config = loadIlinkRuntimeConfig();
installManagedSkill({
  packageRoot: KINTIO_PACKAGE_ROOT,
  workingDirectory: config.codex.workingDirectory,
});

const controller = new AbortController();
let resolveParentShutdown!: () => void;
const parentShutdown = new Promise<void>((resolve) => { resolveParentShutdown = resolve; });
let updateGateRecoveryTimer: NodeJS.Timeout | undefined;
const shutdown = (): void => {
  clearTimeout(updateGateRecoveryTimer);
  controller.abort();
  resolveParentShutdown();
};
let stopIfIdleForUpdate: (() => boolean) | undefined;

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const handleMessage = (message: unknown): void => {
  if (message === 'shutdown') {
    shutdown();
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
    if (!stopIfIdleForUpdate) throw new Error('iLink runtime is not ready');
    response = {
      type: 'stop-if-idle-result',
      requestId: request.requestId,
      pid: process.pid,
      ok: true,
      idle: stopIfIdleForUpdate(),
    };
  } catch (error: unknown) {
    response = {
      type: 'stop-if-idle-result',
      requestId: request.requestId,
      pid: process.pid,
      ok: false,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048) ||
        'iLink Worker stop-if-idle check failed',
    };
  }
  const recoverOnSendFailure = (error: Error | null): void => {
    if (error && response.ok && response.idle) shutdown();
  };
  try {
    if (!process.send) {
      if (response.ok && response.idle) shutdown();
      return;
    }
    process.send(response, recoverOnSendFailure);
    if (response.ok && response.idle) {
      updateGateRecoveryTimer = setTimeout(shutdown, CONTROL_TIMEOUT_MS * 2);
      updateGateRecoveryTimer.unref?.();
    }
  } catch {
    if (response.ok && response.idle) shutdown();
  }
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
    onStarted(control) {
      stopIfIdleForUpdate = control.stopIfIdleForUpdate;
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
