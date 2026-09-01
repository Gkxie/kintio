import {
  FORCE_ABORT_TIMEOUT_MS,
  type IlinkRuntimeConfig,
} from '../config.ts';
import {
  createRuntime,
  type Runtime,
  type RuntimeConfig,
} from '../runtime.ts';
import type { Logger } from '../types.ts';

export interface IlinkCliStartOptions {
  readonly config: IlinkRuntimeConfig;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly logger?: Logger;
  readonly create?: (options: {
    readonly config: RuntimeConfig;
    readonly logger?: Logger;
    readonly onIlinkStopRequested?: () => void;
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
      () => reject(new Error('Graceful iLink shutdown timed out')),
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

export async function startIlinkCliRuntime(options: IlinkCliStartOptions): Promise<number> {
  if (options.signal.aborted) return 130;
  const create = options.create || createRuntime;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
  const runtime = await create({
    config: options.config,
    ...(options.logger ? { logger: options.logger } : {}),
    onIlinkStopRequested: requestStop,
  });
  try {
    await runtime.start();
    options.stdout('Kintio iLink runtime is active. Press Ctrl-C to stop.\n');
    const reason = await Promise.race([
      waitForAbort(options.signal).then(() => 'signal' as const),
      stopRequested.then(() => 'account-stop' as const),
    ]);
    return reason === 'signal' ? 130 : 0;
  } finally {
    await closeRuntime(runtime, options.config.state.shutdownTimeoutMs);
  }
}
