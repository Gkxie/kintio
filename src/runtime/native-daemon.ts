import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  parseStartTimeout,
  WORKER_GRACEFUL_TIMEOUT_MS,
} from '../config.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';
import { acquireSingleInstanceLock } from './single-instance-lock.ts';
import {
  controlAddress,
  CONTROL_MAX_BYTES,
  CONTROL_TIMEOUT_MS,
  daemonRecordPath,
  parseControlRequest,
  type ControlResponse,
  type DaemonPhase,
  writeDaemonRecord,
} from './daemon-protocol.ts';

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const LOG_GENERATIONS = 5;

function sleep(milliseconds: number): Promise<void> {
  return delay(milliseconds, undefined, { ref: false });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RotatingLog {
  readonly #filePath: string;
  #size: number;

  constructor(home: string) {
    const directory = ensurePrivateDirectory(path.join(home, 'data/logs'));
    this.#filePath = path.join(directory, 'kintio.log');
    this.#size = fs.existsSync(this.#filePath) ? fs.statSync(this.#filePath).size : 0;
  }

  write(value: Buffer | string): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (this.#size + bytes.length > LOG_LIMIT_BYTES) this.#rotate();
    fs.appendFileSync(this.#filePath, bytes, { mode: 0o600 });
    this.#size += bytes.length;
  }

  line(value: string): void {
    this.write(`[daemon] ${new Date().toISOString()} ${value}\n`);
  }

  #rotate(): void {
    for (let generation = LOG_GENERATIONS; generation >= 1; generation -= 1) {
      const target = `${this.#filePath}.${generation}`;
      const source = generation === 1
        ? this.#filePath
        : `${this.#filePath}.${generation - 1}`;
      fs.rmSync(target, { force: true });
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    this.#size = 0;
  }
}

function forceKill(worker: ChildProcess): void {
  // Tree-killing by a reusable numeric PID can terminate unrelated host processes.
  // Current Agent children use stdio/IPC and receive EOF when this exact handle exits.
  if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
}

export async function runNativeDaemon({
  home,
  configFile,
  packageRoot,
  environment = process.env,
}: {
  home: string;
  configFile: string;
  packageRoot: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  const instanceHome = path.resolve(home);
  const instanceConfig = path.resolve(configFile);
  const dataDirectory = ensurePrivateDirectory(path.join(instanceHome, 'data'));
  const log = new RotatingLog(instanceHome);
  const daemonLock = acquireSingleInstanceLock({
    filePath: path.join(dataDirectory, 'daemon.lock'),
  });
  const runId = randomBytes(24).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const address = controlAddress(instanceHome, process.platform, runId);
  const instancePackageRoot = path.resolve(packageRoot);
  let phase: DaemonPhase = 'starting';
  let lastError: string | undefined;
  let worker: ChildProcess | undefined;
  let workerExit: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  const restartTimes: number[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const startupTimeoutMs = parseStartTimeout(environment.KINTIO_START_TIMEOUT_MS);
  const handleSignal = (): void => { void shutdown(); };

  const response = (ok: boolean, message?: string): ControlResponse => ({
    ok,
    runId,
    daemonPid: process.pid,
    ...(worker?.pid ? { workerPid: worker.pid } : {}),
    phase,
    ...((message || (ok ? lastError : undefined))
      ? { message: (message || lastError)!.slice(0, 2_048) }
      : {}),
  });

  async function stopWorker(): Promise<void> {
    const active = worker;
    if (!active || active.exitCode !== null || active.signalCode !== null) return;
    try {
      if (active.connected) active.send('shutdown');
    } catch {
      // The exit listener below remains authoritative.
    }
    const graceful = await Promise.race([
      workerExit.then(() => true),
      sleep(WORKER_GRACEFUL_TIMEOUT_MS).then(() => false),
    ]);
    if (!graceful) {
      log.line(`worker ${active.pid || 'unknown'} exceeded shutdown timeout; forcing exit`);
      forceKill(active);
      const forced = await Promise.race([
        workerExit.then(() => true),
        sleep(5_000).then(() => false),
      ]);
      if (!forced) throw new Error('worker did not exit after forced termination');
    }
  }

  async function shutdown(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      phase = 'stopping';
      try {
        await stopWorker();
      } catch (error: unknown) {
        lastError = `worker shutdown failed: ${errorMessage(error)}`;
        phase = 'failed';
        log.line(lastError);
        stopping = undefined;
        return;
      }
      await cleanupControl();
      resolveFinished();
    })();
    return stopping;
  }

  function startWorker(): void {
    if (phase === 'stopping' || phase === 'failed') return;
    phase = 'starting';
    const child = spawn(
      process.execPath,
      [path.join(instancePackageRoot, 'dist/index.js')],
      {
        cwd: instanceHome,
        env: {
          ...environment,
          KINTIO_HOME: instanceHome,
          KINTIO_CONFIG_FILE: instanceConfig,
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
        windowsHide: true,
      },
    );
    worker = child;
    lastError = undefined;
    let readinessExpired = false;
    const readyTimer = setTimeout(() => {
      if (worker !== child || phase === 'running' || phase === 'stopping') return;
      readinessExpired = true;
      log.line(`worker ${child.pid || 'unknown'} did not publish readiness in time`);
      void (async () => {
        forceKill(child);
        const exited = await Promise.race([
          workerExit.then(() => true),
          sleep(5_000).then(() => false),
        ]);
        if (!exited && worker === child) {
          phase = 'failed';
          lastError = 'worker did not exit after readiness timeout';
        }
      })().catch((error: unknown) => {
        if (worker !== child) return;
        phase = 'failed';
        lastError = errorMessage(error);
      });
    }, startupTimeoutMs);
    readyTimer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => log.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
    child.once('message', (message) => {
      if (
        worker === child &&
        !readinessExpired &&
        phase !== 'stopping' &&
        phase !== 'failed' &&
        child.exitCode === null &&
        child.signalCode === null &&
        message && typeof message === 'object' &&
        'type' in message && message.type === 'ready' &&
        'pid' in message && message.pid === child.pid
      ) {
        clearTimeout(readyTimer);
        phase = 'running';
        lastError = undefined;
      }
    });
    child.once('error', (error) => log.line(`worker spawn error: ${error.message}`));
    workerExit = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        clearTimeout(readyTimer);
        resolve();
        if (worker !== child) return;
        worker = undefined;
        if (phase === 'stopping' || phase === 'failed') return;
        const now = Date.now();
        restartTimes.push(now);
        while (restartTimes[0] !== undefined && now - restartTimes[0] > RESTART_WINDOW_MS) {
          restartTimes.shift();
        }
        const detail = `worker exited code=${code} signal=${signal}`;
        log.line(detail);
        if (restartTimes.length > MAX_RESTARTS) {
          phase = 'failed';
          lastError = 'worker restart limit exceeded';
          return;
        }
        phase = 'backoff';
        lastError = detail;
        const restartDelay = RESTART_DELAYS_MS[
          Math.min(restartTimes.length - 1, RESTART_DELAYS_MS.length - 1)
        ] || RESTART_DELAYS_MS.at(-1)!;
        setTimeout(startWorker, restartDelay).unref?.();
      });
    });
  }

  if (process.platform !== 'win32') fs.rmSync(address, { force: true });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(CONTROL_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    const reject = (message: string): void => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify(response(false, message))}\n`);
    };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      size += chunk.length;
      if (size > CONTROL_MAX_BYTES) {
        reject('control request exceeds protocol limit');
        return;
      }
      chunks.push(chunk);
      const source = Buffer.concat(chunks, size);
      const newline = source.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const request = parseControlRequest(
          JSON.parse(source.subarray(0, newline).toString('utf8')) as unknown,
        );
        if (request.token !== token) {
          reject('control authentication failed');
          return;
        }
        handled = true;
        const output = `${JSON.stringify(response(true))}\n`;
        if (request.command === 'stop') {
          socket.end(output, () => { void shutdown(); });
        } else {
          socket.end(output);
        }
      } catch (error: unknown) {
        reject(errorMessage(error));
      }
    });
    socket.once('timeout', () => reject('control request timed out'));
    socket.once('error', () => undefined);
  });

  function cleanupControl(): Promise<void> {
    cleanup ??= (async () => {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          for (const socket of sockets) socket.destroy();
        });
      } else {
        for (const socket of sockets) socket.destroy();
      }
      fs.rmSync(daemonRecordPath(instanceHome), { force: true });
      if (process.platform !== 'win32') fs.rmSync(address, { force: true });
      daemonLock.release();
    })();
    return cleanup;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => resolve());
    });
    if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
    writeDaemonRecord(instanceHome, {
      version: 1,
      runId,
      daemonPid: process.pid,
      configFile: instanceConfig,
      packageRoot: instancePackageRoot,
      token,
    });
    log.line(`daemon started pid=${process.pid}`);
    startWorker();
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    await finished;
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await cleanupControl();
    log.line('daemon stopped');
  }
}
