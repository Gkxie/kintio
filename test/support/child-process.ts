import {
  fork,
  type ChildProcess,
  type Serializable,
} from 'node:child_process';
import path from 'node:path';
import type { TestContext } from 'vitest';

const MAX_CAPTURED_OUTPUT = 64 * 1024;

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function isForcedExit(
  exit: ChildExit,
  signal: NodeJS.Signals,
): boolean {
  if (exit.signal === signal && exit.code === null) return true;
  return process.platform === 'win32' && exit.signal === null &&
    exit.code !== null && exit.code !== 0;
}

export interface StartTestChildOptions {
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface WaitForMessageOptions {
  label?: string;
  timeout?: number;
}

interface CapturedChildOutput {
  stdout: string;
  stderr: string;
}

type MessagePredicate<T extends Serializable = Serializable> = (
  message: Serializable,
) => message is T;

export interface TestChild {
  child: ChildProcess;
  waitForMessage<T extends Serializable>(
    predicate: MessagePredicate<T>,
    options?: WaitForMessageOptions,
  ): Promise<T>;
  waitForMessage(
    predicate: string,
    options?: WaitForMessageOptions,
  ): Promise<Serializable>;
  waitForExit(): Promise<ChildExit>;
  stop(signal?: NodeJS.Signals): Promise<ChildExit>;
  output(): CapturedChildOutput;
}

interface MessageWaiter {
  predicate(message: Serializable): boolean;
  label: string;
  resolve(message: Serializable): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | undefined;
}

function appendOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-MAX_CAPTURED_OUTPUT);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasMessageType(message: Serializable, expected: string): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === expected
  );
}

export function startTestChild(
  testContext: TestContext,
  modulePath: string,
  {
    args = [],
    cwd = process.cwd(),
    env = {},
    timeoutMs = 5_000,
  }: StartTestChildOptions = {},
): TestChild {
  const child = fork(path.resolve(modulePath), [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (!child.stdout || !child.stderr) {
    child.kill('SIGKILL');
    throw new Error('Test child was started without captured output streams');
  }

  const queuedMessages: Serializable[] = [];
  const waiters = new Set<MessageWaiter>();
  let stdout = '';
  let stderr = '';
  let exitResult: ChildExit | undefined;

  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendOutput(stderr, chunk);
  });

  child.on('message', (message: Serializable) => {
    for (const waiter of waiters) {
      let matches = false;
      try {
        matches = waiter.predicate(message);
      } catch (error) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(
          new Error(`IPC message predicate failed: ${errorMessage(error)}`),
        );
        return;
      }

      if (!matches) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queuedMessages.push(message);
  });

  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `Child exited before ${waiter.label}: code=${code} signal=${signal}` +
              `${stderr ? `\nstderr:\n${stderr}` : ''}`,
          ),
        );
      }
      waiters.clear();
      resolve(exitResult);
    });
  });

  function waitForMessage<T extends Serializable>(
    predicate: MessagePredicate<T>,
    options?: WaitForMessageOptions,
  ): Promise<T>;
  function waitForMessage(
    predicate: string,
    options?: WaitForMessageOptions,
  ): Promise<Serializable>;
  function waitForMessage<T extends Serializable>(
    predicate: string | MessagePredicate<T>,
    { label = 'expected IPC message', timeout = timeoutMs }: WaitForMessageOptions = {},
  ): Promise<T | Serializable> {
    const matcher: (message: Serializable) => boolean =
      typeof predicate === 'function'
        ? predicate
        : (message) => message === predicate || hasMessageType(message, predicate);
    const queuedIndex = queuedMessages.findIndex(matcher);
    if (queuedIndex >= 0) {
      const queued = queuedMessages.splice(queuedIndex, 1)[0];
      if (queued !== undefined) return Promise.resolve(queued);
    }
    if (exitResult) {
      return Promise.reject(
        new Error(`Child already exited before ${label}: ${JSON.stringify(exitResult)}`),
      );
    }

    return new Promise<Serializable>((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate: matcher,
        label,
        resolve,
        reject,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(
            `Timed out waiting for ${label}` +
              `${stdout ? `\nstdout:\n${stdout}` : ''}` +
              `${stderr ? `\nstderr:\n${stderr}` : ''}`,
          ),
        );
      }, timeout);
      waiter.timer.unref();
      waiters.add(waiter);
    });
  }

  async function stop(signal: NodeJS.Signals = 'SIGKILL'): Promise<ChildExit> {
    if (!exitResult && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
    return exited;
  }

  testContext.onTestFinished(async () => {
    await stop();
  });
  return {
    child,
    waitForMessage,
    waitForExit: () => exited,
    stop,
    output: () => ({ stdout, stderr }),
  };
}
