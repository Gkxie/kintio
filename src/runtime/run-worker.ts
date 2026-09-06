import {
  FORCE_ABORT_TIMEOUT_MS,
  type SharedRuntimeConfig,
} from '../config.ts';
import {
  createRuntime,
  type Runtime,
} from '../runtime.ts';
import type { Logger } from '../types.ts';

export interface WorkerOptions {
  readonly background?: boolean;
  readonly config: SharedRuntimeConfig;
  readonly startWecom?: string;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly logger?: Logger;
  readonly onStopRequested?: () => void;
  readonly onStarted?: (control: {
    readonly stopIfIdleForUpdate: () => boolean;
  }) => void | Promise<void>;
  readonly create?: (options: {
    readonly config: SharedRuntimeConfig;
    readonly logger?: Logger;
    readonly onStopRequested?: () => void;
  }) => Promise<Runtime>;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function closeRuntime(runtime: Runtime, timeoutMs: number): Promise<void> {
  runtime.stopAccepting();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Graceful Kintio shutdown timed out')),
      timeoutMs,
    );
  });
  try {
    await Promise.race([runtime.close(), timedOut]);
  } catch (error: unknown) {
    let forceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      runtime.abort().catch(() => undefined),
      new Promise<void>((resolve) => {
        forceTimer = setTimeout(resolve, FORCE_ABORT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(forceTimer);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorker(options: WorkerOptions): Promise<number> {
  if (options.signal.aborted) return 130;
  const create = options.create || createRuntime;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
  const runtime = await create({
    config: options.config,
    ...(options.logger ? { logger: options.logger } : {}),
    onStopRequested: requestStop,
  });
  const failed = runtime.failure.then((error) => { throw error; });
  // Keep the failure observed even if a lifecycle hook throws synchronously.
  void failed.catch(() => undefined);
  try {
    await Promise.race([runtime.start(), failed]);
    if (options.startWecom) {
      await Promise.race([runtime.wecomControl('start', options.startWecom), failed]);
    }
    await Promise.race([
      options.onStarted?.({ stopIfIdleForUpdate: () => runtime.stopAcceptingIfIdle() }),
      failed,
    ]);
    options.stdout(
      options.background
        ? 'Kintio shared runtime is active.\n'
        : 'Kintio shared runtime is active. Press Ctrl-C to stop.\n',
    );
    const reason = await Promise.race([
      waitForAbort(options.signal).then(() => 'signal' as const),
      stopRequested.then(() => 'channel-stop' as const),
      failed,
    ]);
    // Tell the daemon this is an intentional stop before cleanup can fail.
    if (reason === 'channel-stop') options.onStopRequested?.();
    return reason === 'signal' ? 130 : 0;
  } finally {
    await closeRuntime(runtime, options.config.state.shutdownTimeoutMs);
  }
}
