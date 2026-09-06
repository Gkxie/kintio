import {
  loadSharedRuntimeConfig,
} from './src/config.ts';
import { runWorker } from './src/runtime/run-worker.ts';
import {
  CONTROL_TIMEOUT_MS,
  parseWorkerStopIfIdleRequest,
  type WorkerStopIfIdleResponse,
} from './src/runtime/daemon-protocol.ts';

const config = loadSharedRuntimeConfig();

const controller = new AbortController();
let resolveParentShutdown!: () => void;
const parentShutdown = new Promise<void>((resolve) => { resolveParentShutdown = resolve; });
let updateGateRecoveryTimer: NodeJS.Timeout | undefined;
const shutdown = (): void => {
  if (controller.signal.aborted) return;
  console.log('Stopping Kintio runtime.');
  clearTimeout(updateGateRecoveryTimer);
  controller.abort();
  resolveParentShutdown();
};
let stopIfIdleForUpdate: (() => boolean) | undefined;
let stopIfUnused: (() => boolean) | undefined;

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const handleMessage = (message: unknown): void => {
  if (message === 'shutdown') {
    shutdown();
    return;
  }
  if (
    !message || typeof message !== 'object' || !('type' in message) ||
    (message.type !== 'stop-if-idle' && message.type !== 'stop-if-unused')
  ) return;
  let request;
  try {
    request = parseWorkerStopIfIdleRequest(message);
  } catch {
    return;
  }
  let response: WorkerStopIfIdleResponse;
  try {
    const stop = request.type === 'stop-if-unused' ? stopIfUnused : stopIfIdleForUpdate;
    if (!stop) throw new Error('Kintio runtime is not ready');
    response = {
      type: `${request.type}-result`,
      requestId: request.requestId,
      pid: process.pid,
      ok: true,
      idle: stop(),
    };
  } catch (error: unknown) {
    response = {
      type: `${request.type}-result`,
      requestId: request.requestId,
      pid: process.pid,
      ok: false,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048) ||
        'Kintio worker stop-if-idle check failed',
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
  const result = await runWorker({
    background: true,
    config,
    ...(process.env.KINTIO_START_WECOM ? { startWecom: process.env.KINTIO_START_WECOM } : {}),
    signal: controller.signal,
    stdout: (text) => process.stdout.write(text),
    onStarted(control) {
      stopIfIdleForUpdate = control.stopIfIdleForUpdate;
      stopIfUnused = control.stopIfUnused;
      if (!controller.signal.aborted && process.connected) {
        process.send?.({ type: 'ready', pid: process.pid }, (error) => { if (error) shutdown(); });
      }
    },
    onStopRequested() {
      if (process.connected) {
        process.send?.({ type: 'shutdown-request', pid: process.pid }, (error) => { if (error) shutdown(); });
      }
    },
  });
  if (result === 0 && process.connected) {
    await parentShutdown;
  }
  process.exitCode = result === 130 ? 0 : result;
} catch (error: unknown) {
  console.error('[runtime] worker failed', error);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  process.off('disconnect', shutdown);
  process.off('message', handleMessage);
  if (process.connected) process.disconnect();
}
