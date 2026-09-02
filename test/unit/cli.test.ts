import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'vitest';
import { test } from 'vitest';
import crossSpawn from 'cross-spawn';

import { runCli } from '../../src/cli.ts';
import { runNativeDaemon } from '../../src/runtime/native-daemon.ts';
import {
  readDaemonRecord,
  requestControl,
  writeDaemonRecord,
} from '../../src/runtime/daemon-protocol.ts';
import { acquireSingleInstanceLock } from '../../src/runtime/single-instance-lock.ts';
import { readInstalledPackageIdentity } from '../../src/update/global-install.ts';
import {
  ProcessTreeTerminationError,
  verifyPreparedKintioUpdate,
} from '../../src/update/self-update.ts';
import { KINTIO_VERSION } from '../../src/version.ts';

type CliOverrides = NonNullable<Parameters<typeof runCli>[1]>;

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-cli-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function cliRuntime(root: string, extra: Partial<CliOverrides> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    overrides: {
      env: {} as NodeJS.ProcessEnv,
      cwd: root,
      homeDirectory: root,
      packageRoot: path.resolve('.'),
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      ...extra,
    } satisfies Partial<CliOverrides>,
  };
}

function exitedDaemon(pid = 2_147_483_647) {
  return { pid, exited: Promise.resolve(), kill: () => false };
}

async function updatePackage(
  root: string,
  version = KINTIO_VERSION,
): Promise<{
  readonly packageRoot: string;
  readonly prefix: string;
}> {
  const prefix = path.join(root, 'npm prefix');
  const packageRoot = path.join(prefix, 'lib/node_modules/@kin-tio/cli');
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@kin-tio/cli',
      version,
      bin: { kintio: 'bin/kintio.js' },
    })}\n`),
    fs.writeFile(path.join(packageRoot, 'bin/kintio.js'), '#!/usr/bin/env node\n'),
  ]);
  return { packageRoot, prefix };
}

test('global CLI exposes stable help, version, and argument failures', async (t) => {
  const runtime = cliRuntime(await temporaryRoot(t));
  assert.equal(await runCli([], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Commands:\n  setup/u);
  assert.match(runtime.stdout.join(''), /ilink login/u);
  assert.match(runtime.stdout.join(''), /ilink start/u);
  assert.match(runtime.stdout.join(''), /ilink delete/u);
  assert.match(runtime.stdout.join(''), /update\s+Update Kintio/u);
  assert.match(runtime.stdout.join(''), /upgrade\s+Alias for update/u);
  runtime.stdout.length = 0;
  assert.equal(await runCli(['help'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Usage: kintio <command>/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['help', 'extra'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /Unexpected argument: extra/u);
  runtime.stdout.length = 0;
  assert.equal(await runCli(['--version'], runtime.overrides), 0);
  assert.equal(runtime.stdout.join(''), `${KINTIO_VERSION}\n`);
  assert.equal(await runCli(['unknown'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /Unknown command: unknown/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['start', '--lines', '5'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /valid only for "kintio logs"/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['start', '--qr-output', 'qr.png'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /valid only for "kintio ilink login"/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['--qr-output', 'qr.png'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /valid only for "kintio ilink login"/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'logout', '--help'], runtime.overrides), 1);
  assert.match(
    runtime.stderr.join(''),
    /Usage: kintio ilink <login\|list\|start\|stop\|delete>/u,
  );
  runtime.stderr.length = 0;
  assert.equal(await runCli([
    'ilink', 'login', 'extra', '--help',
  ], runtime.overrides), 1);
  assert.match(
    runtime.stderr.join(''),
    /Usage: kintio ilink <login\|list\|start\|stop\|delete>/u,
  );
  runtime.stderr.length = 0;
  assert.equal(await runCli([
    'ilink', 'login', '--qr-output', '',
  ], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /requires a non-empty file path/u);
});

test('update and upgrade are exact aliases and need no configured instance', async (t) => {
  const root = await temporaryRoot(t);
  const { packageRoot, prefix } = await updatePackage(root);
  const identity = readInstalledPackageIdentity(packageRoot);
  const prepared = {
    kind: 'update' as const,
    currentVersion: KINTIO_VERSION,
    targetVersion: '9.8.7',
    installation: {
      ...identity,
      manager: 'npm' as const,
      prefix,
    },
    command: {
      file: 'npm' as const,
      args: ['install', '--global', '@kin-tio/cli@9.8.7'],
    },
    cwd: root,
    environment: { PATH: process.env.PATH },
  };
  const calls: string[] = [];
  const runtime = cliRuntime(root, {
    packageRoot,
    updater: {
      prepare: async () => {
        calls.push('prepare');
        return prepared;
      },
      install: async () => { calls.push('install'); },
      verify: async () => { calls.push('verify'); },
    },
  });

  assert.equal(await runCli(['update', '--help'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Usage: kintio <update\|upgrade>/u);
  assert.doesNotMatch(runtime.stdout.join(''), /--lines/u);
  assert.deepEqual(calls, []);
  runtime.stdout.length = 0;
  assert.equal(await runCli(['update'], runtime.overrides), 0);
  assert.deepEqual(calls, ['prepare', 'install', 'verify']);
  const updateOutput = runtime.stdout.join('');
  assert.equal(runtime.stderr.join(''), '');
  calls.length = 0;
  runtime.stdout.length = 0;
  assert.equal(await runCli(['upgrade'], runtime.overrides), 0);
  assert.deepEqual(calls, ['prepare', 'install', 'verify']);
  assert.equal(runtime.stdout.join(''), updateOutput);
  assert.equal(runtime.stderr.join(''), '');
  assert.match(runtime.stdout.join(''), /9\.8\.7 was installed successfully/u);
  await assert.rejects(() => fs.stat(path.join(root, '.kintio/.env')), /ENOENT/u);
});

test('update-only arguments fail before Registry or package-manager work', async (t) => {
  const root = await temporaryRoot(t);
  let prepared = 0;
  const runtime = cliRuntime(root, {
    updater: {
      prepare: async () => {
        prepared += 1;
        throw new Error('must not prepare');
      },
      install: async () => undefined,
      verify: async () => undefined,
    },
  });
  for (const args of [
    ['update', '--force'],
    ['update', '--check'],
    ['update', 'extra'],
    ['update', '--account', 'ia_test'],
    ['update', '--foreground'],
  ]) {
    runtime.stderr.length = 0;
    assert.equal(await runCli(args, runtime.overrides), 1);
    assert.ok(runtime.stderr.length > 0);
  }
  assert.equal(prepared, 0);
});

test('an already-current update performs no lifecycle or install mutation', async (t) => {
  const root = await temporaryRoot(t);
  const { packageRoot, prefix } = await updatePackage(root);
  const identity = readInstalledPackageIdentity(packageRoot);
  let installed = false;
  let launched = false;
  const runtime = cliRuntime(root, {
    packageRoot,
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
    updater: {
      prepare: async () => ({
        kind: 'current',
        currentVersion: KINTIO_VERSION,
        targetVersion: KINTIO_VERSION,
        installation: {
          ...identity,
          manager: 'npm',
          prefix,
        },
      }),
      install: async () => { installed = true; },
      verify: async () => { throw new Error('verify must not run'); },
    },
  });

  assert.equal(await runCli(['update'], runtime.overrides), 0);
  assert.equal(installed, false);
  assert.equal(launched, false);
  assert.equal(runtime.stdout.join(''),
    `Checking for Kintio updates...\n` +
    `No newer Kintio version is available (installed ${KINTIO_VERSION}, ` +
    `Registry ${KINTIO_VERSION}).\n`);
});

test('update refuses a foreground instance before invoking its package manager', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const { packageRoot, prefix } = await updatePackage(root);
  const identity = readInstalledPackageIdentity(packageRoot);
  const foregroundLock = acquireSingleInstanceLock({
    filePath: path.join(home, 'data/kintio.lock'),
  });
  t.onTestFinished(() => { foregroundLock.release(); });
  let installed = false;
  const runtime = cliRuntime(root, {
    packageRoot,
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion: '9.8.7',
        installation: {
          ...identity,
          manager: 'npm',
          prefix,
        },
        command: { file: 'npm', args: ['install'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => { installed = true; },
      verify: async () => undefined,
    },
  });

  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installed, false);
  assert.match(runtime.stderr.join(''), /foreground Kintio Runtime or iLink login/u);
});

test('one update excludes concurrent updates and lifecycle commands, then cleans every lock', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const { packageRoot, prefix } = await updatePackage(root);
  const identity = readInstalledPackageIdentity(packageRoot);
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  let releaseInstall!: () => void;
  const installing = new Promise<void>((resolve) => { releaseInstall = resolve; });
  let notifyInstall!: () => void;
  const installStarted = new Promise<void>((resolve) => { notifyInstall = resolve; });
  const runtime = cliRuntime(root, {
    packageRoot,
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion: '9.8.7',
        installation: { ...identity, manager: 'npm', prefix },
        command: { file: 'npm', args: ['install'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => {
        notifyInstall();
        await installing;
      },
      verify: async () => undefined,
    },
    launchDaemon: () => exitedDaemon(),
  });

  const first = runCli(['update', '--home', home], runtime.overrides);
  await installStarted;
  const second = cliRuntime(root, {
    updater: runtime.overrides.updater!,
    launchDaemon: () => exitedDaemon(),
  });
  assert.equal(await runCli(['update', '--home', home], second.overrides), 1);
  assert.match(second.stderr.join(''), /Another Kintio update is already running/u);
  second.stderr.length = 0;
  assert.equal(await runCli(['start', '--home', home], second.overrides), 1);
  assert.match(second.stderr.join(''), /lifecycle command is already running/u);
  releaseInstall();
  assert.equal(await first, 0);

  for (const lock of [
    path.join(root, '.kintio/data/installation-update.lock'),
    path.join(home, 'data/lifecycle.lock'),
    path.join(home, 'data/kintio.lock'),
  ]) {
    await assert.rejects(fs.access(lock), /ENOENT/u);
  }
});

test('CLI routes only the exact ilink login subcommand to an interactive adapter', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.appendFile(path.join(home, '.env'), '\nILINK_ENABLED=true\n');
  const signals: AbortSignal[] = [];
  const qrOutputPaths: Array<string | undefined> = [];
  const loginSignals: NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const previousListeners = new Map(loginSignals.map((signal) => [
    signal,
    [...process.listeners(signal)],
  ]));
  const runtime = cliRuntime(root, {
    stdoutIsTTY: true,
    stdoutColumns: 120,
    ilinkLogin: async (options) => {
      signals.push(options.signal);
      qrOutputPaths.push(options.qrOutputPath);
      assert.equal(options.config.ilink.baseUrl, 'https://ilinkai.weixin.qq.com/');
      assert.equal(options.stdoutColumns, 120);
      return 0;
    },
  });
  assert.equal(await runCli(['ilink', 'login', '--home', home], runtime.overrides), 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
  assert.deepEqual(qrOutputPaths, [undefined]);
  for (const signal of loginSignals) {
    assert.deepEqual(process.listeners(signal), previousListeners.get(signal));
  }

  runtime.stdout.length = 0;
  assert.equal(await runCli(['ilink', '--help'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Usage: kintio ilink <command>/u);
  assert.match(runtime.stdout.join(''), /login \[options\]/u);
  assert.equal(signals.length, 1);

  runtime.stdout.length = 0;
  assert.equal(await runCli(['ilink', 'login', '--help'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Usage: kintio ilink login \[options\]/u);
  assert.match(runtime.stdout.join(''), /--qr-output <file>/u);
  assert.match(runtime.stdout.join(''), /directly inside the instance directory/u);
  assert.match(runtime.stdout.join(''), /removed when the login attempt ends/u);
  assert.match(runtime.stdout.join(''), /authorized operator/u);
  assert.equal(signals.length, 1);

  const outputPath = path.join(home, 'login-qr.png');
  assert.equal(await runCli([
    'ilink', 'login', '--home', home, '--qr-output', outputPath,
  ], runtime.overrides), 0);
  assert.deepEqual(qrOutputPaths, [undefined, outputPath]);
  assert.equal(signals.length, 2);

  runtime.stderr.length = 0;
  assert.equal(await runCli([
    'ilink', 'login', '--home', home,
    '--qr-output', path.join(root, 'outside.png'),
  ], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /directly inside the instance directory/u);
  assert.equal(signals.length, 2);

  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', '--home', home], runtime.overrides), 1);
  assert.match(
    runtime.stderr.join(''),
    /Usage: kintio ilink <login\|list\|start\|stop\|delete>/u,
  );
  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'logout', '--home', home], runtime.overrides), 1);
  assert.match(
    runtime.stderr.join(''),
    /Usage: kintio ilink <login\|list\|start\|stop\|delete>/u,
  );
});

test('iLink login and start need no setup, config file, or Hono lifecycle', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'fresh-instance');
  let loginCalls = 0;
  let accountCalls = 0;
  let startCalls = 0;
  const runtime = cliRuntime(root, {
    stdoutIsTTY: true,
    ilinkLogin: async ({ config }) => {
      loginCalls += 1;
      assert.equal(config.state.databaseFile, path.join(home, 'data/kintio.sqlite'));
      return 0;
    },
    ilinkAccount: async ({ command, config }) => {
      accountCalls += 1;
      assert.equal(command, 'start');
      assert.equal(config.state.databaseFile, path.join(home, 'data/kintio.sqlite'));
      return {
        runtimeRequired: true,
        runningCount: 0,
        selectedAccountKey: `ia_${'a'.repeat(40)}`,
      };
    },
    ilinkStart: async ({ config }) => {
      startCalls += 1;
      assert.equal('wecom' in config, false);
      assert.equal(config.ilink.enabled, true);
      assert.equal(config.state.databaseFile, path.join(home, 'data/kintio.sqlite'));
      return 0;
    },
  });

  assert.equal(await runCli(['ilink', 'login', '--home', home], runtime.overrides), 0);
  assert.equal(await runCli([
    'ilink', 'start', '--foreground', '--home', home,
  ], runtime.overrides), 0);
  assert.deepEqual(
    { loginCalls, accountCalls, startCalls },
    { loginCalls: 1, accountCalls: 1, startCalls: 1 },
  );
  await assert.rejects(() => fs.stat(path.join(home, '.env')), /ENOENT/u);

  runtime.stdout.length = 0;
  assert.equal(await runCli(['ilink', 'start', '--help'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /background without starting\nHono/u);
  assert.equal(startCalls, 1);

  runtime.stderr.length = 0;
  assert.equal(await runCli([
    'ilink', 'start', '--home', home, '--qr-output', path.join(home, 'qr.png'),
  ], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /valid only for "kintio ilink login"/u);
});

test('CLI routes iLink account lifecycle selectors and destructive confirmation', async (t) => {
  const root = await temporaryRoot(t);
  const calls: Array<Record<string, unknown>> = [];
  let foregroundStarts = 0;
  const runtime = cliRuntime(root, {
    ilinkAccount: async (options) => {
      calls.push({
        command: options.command,
        selector: options.selector,
        confirmed: options.confirmed,
      });
      return {
        runtimeRequired: options.command === 'start',
        runningCount: options.command === 'stop' || options.command === 'delete' ? 0 : 1,
        ...(options.command === 'start'
          ? { selectedAccountKey: `ia_${'a'.repeat(40)}` as const }
          : {}),
      };
    },
    ilinkStart: async () => {
      foregroundStarts += 1;
      return 0;
    },
  });
  const home = path.join(root, 'account-lifecycle');

  assert.equal(await runCli(['ilink', 'list', '--home', home], runtime.overrides), 0);
  assert.equal(await runCli([
    'ilink', 'start', '--foreground', '--home', home, '--account', 'bot-a@im.bot',
  ], runtime.overrides), 0);
  assert.equal(await runCli([
    'ilink', 'stop', '--home', home, '--account', `ia_${'a'.repeat(40)}`,
  ], runtime.overrides), 0);
  assert.equal(await runCli([
    'ilink', 'delete', '--home', home, '--account', 'bot-a@im.bot', '--yes',
  ], runtime.overrides), 0);
  assert.deepEqual(calls, [
    { command: 'list', selector: undefined, confirmed: false },
    { command: 'start', selector: 'bot-a@im.bot', confirmed: false },
    { command: 'stop', selector: `ia_${'a'.repeat(40)}`, confirmed: false },
    { command: 'delete', selector: 'bot-a@im.bot', confirmed: true },
  ]);
  assert.equal(foregroundStarts, 1);

  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'list', '--account', 'bad'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /--account is valid only/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'start', '--yes'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /--yes is valid only/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'list', '--foreground'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /--foreground is valid only/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['ilink', 'delete', '--account', ''], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /requires a non-empty account ID or key/u);

  runtime.stdout.length = 0;
  for (const command of ['list', 'start', 'stop', 'delete']) {
    assert.equal(await runCli(['ilink', command, '--help'], runtime.overrides), 0);
  }
  assert.match(runtime.stdout.join(''), /cannot be undone/u);
});

test('standalone iLink start launches one managed background daemon before activation', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'background-ilink');
  const packageRoot = path.join(root, 'package');
  const workerVersionFile = path.join(root, 'worker-version');
  const workerFile = path.join(packageRoot, 'dist/ilink.js');
  await Promise.all([
    fs.mkdir(path.dirname(workerFile), { recursive: true }),
    fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true }),
  ]);
  await fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
    recursive: true,
  });
  await Promise.all([
    fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@kin-tio/cli',
      version: KINTIO_VERSION,
      bin: { kintio: 'bin/kintio.js' },
    })}\n`),
    fs.writeFile(path.join(packageRoot, 'bin/kintio.js'), '#!/usr/bin/env node\n'),
    fs.writeFile(workerFile, [
      "import fs from 'node:fs';",
      "const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));",
      'fs.writeFileSync(process.env.KINTIO_TEST_WORKER_VERSION, manifest.version);',
      "process.send?.({ type: 'ready', pid: process.pid });",
      "process.on('message', (message) => {",
      "  if (message === 'shutdown') process.exit(0);",
      "  if (message?.type === 'stop-if-idle') process.send?.({",
      "    type: 'stop-if-idle-result', requestId: message.requestId,",
      "    pid: process.pid, ok: true, idle: true,",
      "  });",
      "});",
      "process.on('disconnect', () => process.exit(0));",
    ].join('\n')),
  ]);
  const identity = readInstalledPackageIdentity(packageRoot);
  const targetVersion = '9.8.7';
  const daemonRuns: Promise<void>[] = [];
  const accountKey = `ia_${'b'.repeat(40)}` as const;
  const accountCalls: Array<{ command: string; defer?: boolean; selector?: string }> = [];
  const runtime = cliRuntime(root, {
    env: { ...process.env, KINTIO_TEST_WORKER_VERSION: workerVersionFile },
    packageRoot,
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion,
        installation: {
          ...identity,
          manager: 'npm',
          prefix: root,
        },
        command: { file: 'npm', args: ['install'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => {
        await Promise.all([
          fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
            name: '@kin-tio/cli',
            version: targetVersion,
            bin: { kintio: 'bin/kintio.js' },
          })}\n`),
          fs.writeFile(
            path.join(packageRoot, 'bin/kintio.js'),
            `process.stdout.write(${JSON.stringify(`${targetVersion}\n`)});\n`,
          ),
        ]);
      },
      verify: verifyPreparedKintioUpdate,
    },
    ilinkAccount: async (options) => {
      accountCalls.push({
        command: options.command,
        ...(options.deferStandaloneStart === undefined
          ? {}
          : { defer: options.deferStandaloneStart }),
        ...(options.selector ? { selector: options.selector } : {}),
      });
      if (options.command === 'stop') {
        return { runtimeRequired: false, runningCount: 0 };
      }
      return accountCalls.length === 1
        ? { runtimeRequired: true, runningCount: 0, selectedAccountKey: accountKey }
        : { runtimeRequired: false, runningCount: 1, selectedAccountKey: accountKey };
    },
    launchDaemon: (request) => {
      assert.equal(request.env.KINTIO_DAEMON_MODE, 'ilink');
      const running = runNativeDaemon({
        home,
        configFile: path.join(home, '.env'),
        packageRoot,
        mode: 'ilink',
        environment: request.env,
      });
      daemonRuns.push(running);
      return {
        pid: process.pid,
        exited: running,
        kill: () => false,
      };
    },
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await Promise.allSettled(daemonRuns);
  });

  assert.equal(await runCli(['ilink', 'start', '--home', home], runtime.overrides), 0);
  assert.deepEqual(accountCalls, [
    { command: 'start', defer: true },
    { command: 'start', selector: accountKey },
  ]);
  assert.equal(readDaemonRecord(home)?.mode, 'ilink');
  const firstRunId = readDaemonRecord(home)?.runId;
  assert.ok(firstRunId);
  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 0);
  assert.equal(readDaemonRecord(home)?.mode, 'ilink');
  assert.notEqual(readDaemonRecord(home)?.runId, firstRunId);
  const restartedRunId = readDaemonRecord(home)?.runId;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 0);
  assert.equal(readDaemonRecord(home)?.mode, 'ilink');
  assert.notEqual(readDaemonRecord(home)?.runId, restartedRunId);
  assert.equal(await fs.readFile(workerVersionFile, 'utf8'), targetVersion);
  assert.match(runtime.stdout.join(''), new RegExp(`Kintio ${targetVersion} was installed`));
  assert.match(runtime.stdout.join(''), /iLink Runtime was restored/u);
  await fs.access(path.join(
    home,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  ));
  await fs.copyFile('.env.example', path.join(home, '.env'));
  if (process.platform !== 'win32') await fs.chmod(path.join(home, '.env'), 0o600);
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /already running in ilink mode/u);
  assert.equal(await runCli(['ilink', 'stop', '--home', home], runtime.overrides), 0);
  await Promise.all(daemonRuns);
  assert.equal(readDaemonRecord(home), null);
  assert.deepEqual(accountCalls.at(-1), { command: 'stop' });
});

test('background iLink start refuses an unresolved account before daemon launch', async (t) => {
  const root = await temporaryRoot(t);
  let launched = false;
  const runtime = cliRuntime(root, {
    ilinkAccount: async () => ({ runtimeRequired: true, runningCount: 0 }),
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
  });
  assert.equal(await runCli([
    'ilink', 'start', '--home', path.join(root, 'instance'),
  ], runtime.overrides), 1);
  assert.equal(launched, false);
  assert.match(runtime.stderr.join(''), /did not resolve an account identity/u);
});

test('CLI drains an iLink login before honoring terminal signals', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.appendFile(path.join(home, '.env'), '\nILINK_ENABLED=true\n');
  const runtime = cliRuntime(root, {
    stdoutIsTTY: true,
    ilinkLogin: ({ signal }) => new Promise<number>((resolve) => {
      signal.addEventListener('abort', () => resolve(130), { once: true });
    }),
  });
  const cases: Array<[NodeJS.Signals, number]> = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ...(process.platform === 'win32'
      ? []
      : [['SIGHUP', 129] as [NodeJS.Signals, number]]),
  ];
  for (const [signal, exitCode] of cases) {
    const previousListeners = [...process.listeners(signal)];
    const running = runCli(['ilink', 'login', '--home', home], runtime.overrides);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const handler = process.listeners(signal).find(
      (listener) => !previousListeners.includes(listener),
    );
    assert.ok(handler);
    (handler as () => void)();
    assert.equal(await running, exitCode);
    assert.deepEqual(process.listeners(signal), previousListeners);
  }
});

test('setup creates one private config and refreshes the managed Agent skill', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const runtime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  const configFile = path.join(home, '.env');
  const skillFile = path.join(
    home,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const firstConfig = await fs.readFile(configFile, 'utf8');
  const configTemplate = await fs.readFile('.env.example', 'utf8');
  const bundledSkill = await fs.readFile(
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
    'utf8',
  );
  assert.equal(firstConfig, configTemplate);
  assert.doesNotMatch(
    firstConfig,
    /^(?:KINTIO|TALKFERRY|HARNESS|WECOM)_MCP_(?:URL|BEARER_TOKEN)=/mu,
  );
  assert.equal(await fs.readFile(skillFile, 'utf8'), bundledSkill);
  await fs.writeFile(skillFile, 'stale local skill\n');
  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(configFile, 'utf8'), firstConfig);
  assert.equal(await fs.readFile(skillFile, 'utf8'), bundledSkill);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  }
});

test('managed Skill follows and refreshes the configured Agent workspace', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const workingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kintio-external-agent-workspace-'),
  );
  t.onTestFinished(() => fs.rm(workingDirectory, { recursive: true, force: true }));
  const configFile = path.join(home, '.env');
  const runtime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  await fs.appendFile(
    configFile,
    `\nCODEX_WORKING_DIRECTORY=${workingDirectory}\n`,
  );
  runtime.stdout.length = 0;

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  const customSkill = path.join(
    workingDirectory,
    '.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const bundledSkill = await fs.readFile(
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
    'utf8',
  );
  assert.equal(await fs.readFile(customSkill, 'utf8'), bundledSkill);
  assert.equal(runtime.stdout.join('').includes(customSkill), true);

  await fs.writeFile(customSkill, 'stale managed Skill\n');
  const executed: string[] = [];
  const runRuntime = cliRuntime(root, {
    execute: async ({ file }) => {
      executed.push(file);
      return 0;
    },
  });
  assert.equal(await runCli(['run', '--home', home], runRuntime.overrides), 0);
  assert.equal(executed.length, 1);
  assert.equal(await fs.readFile(customSkill, 'utf8'), bundledSkill);
});

test('run keeps the worker in the foreground with explicit instance selectors', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const configFile = path.join(home, 'custom.env');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli([
    'setup', '--home', home, '--config', configFile,
  ], setupRuntime.overrides), 0);
  const requests: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const runtime = cliRuntime(root, {
    env: {
      KINTIO_HOME: path.join(root, 'stale-home'),
      KINTIO_CONFIG_FILE: path.join(root, 'stale.env'),
      AGENT_HOST_CANARY: 'preserved',
    },
    execute: async (request) => {
      requests.push({ args: request.args, env: request.env });
      return 0;
    },
  });
  assert.equal(await runCli([
    'run', '--home', home, '--config', configFile,
  ], runtime.overrides), 0);
  assert.deepEqual(requests[0]?.args, [path.join(path.resolve('.'), 'dist/index.js')]);
  assert.equal(requests[0]?.env.KINTIO_HOME, home);
  assert.equal(requests[0]?.env.KINTIO_CONFIG_FILE, configFile);
  assert.equal(requests[0]?.env.AGENT_HOST_CANARY, 'preserved');
});

test('foreground executor turns a CLI signal into Worker IPC shutdown', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'package');
  const workerFile = path.join(packageRoot, 'dist/index.js');
  const readyFile = path.join(home, 'worker-ready');
  const stoppedFile = path.join(home, 'worker-stopped');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
    recursive: true,
  });
  await fs.writeFile(workerFile, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
    "process.on('message', (message) => {",
    "  if (message !== 'shutdown') return;",
    `  fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'shutdown');`,
    '  process.exit(0);',
    '});',
    "process.on('disconnect', () => process.exit(0));",
    'setInterval(() => undefined, 1000);',
  ].join('\n'));
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);

  const previousListeners = new Set(process.listeners('SIGTERM'));
  const runtime = cliRuntime(root, { packageRoot });
  let workerPid = 0;
  const running = runCli(['run', '--home', home], runtime.overrides);
  t.onTestFinished(async () => {
    if (workerPid) {
      try { process.kill(workerPid, 'SIGKILL'); } catch {}
    }
    await running.catch(() => undefined);
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      workerPid = Number(await fs.readFile(readyFile, 'utf8'));
      break;
    } catch {
      await delay(10);
    }
  }
  assert.ok(workerPid);
  const handler = process.listeners('SIGTERM').find(
    (listener) => !previousListeners.has(listener),
  );
  assert.ok(handler);
  handler('SIGTERM');
  assert.equal(await running, 0);
  assert.equal(await fs.readFile(stoppedFile, 'utf8'), 'shutdown');
  assert.deepEqual(process.listeners('SIGTERM'), [...previousListeners]);
  workerPid = 0;
});

test('logs validate line counts and read native daemon output without a process manager', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const runtime = cliRuntime(root);
  const logFile = path.join(home, 'data/logs/kintio.log');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, 'one\ntwo\nthree\n');
  assert.equal(await runCli([
    'logs', '--home', home, '--lines', '2', '--no-follow',
  ], runtime.overrides), 0);
  assert.equal(runtime.stdout.join(''), 'two\nthree\n');
  runtime.stderr.length = 0;
  assert.equal(await runCli([
    'logs', '--home', home, '--lines', '0', '--no-follow',
  ], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /--lines must be an integer/u);
});

test('status and stop are idempotent when no daemon exists', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const runtime = cliRuntime(root);
  assert.equal(await runCli(['status', '--home', home], runtime.overrides), 0);
  assert.equal(await runCli(['stop', '--home', home], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Kintio is not running/u);
});

test('source CLI starts, probes, logs, and stops one native daemon', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const packageRoot = path.join(root, 'fake-package');
  const workerFile = path.join(packageRoot, 'dist/index.js');
  const bundledSkillFile = path.join(
    packageRoot,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.mkdir(path.dirname(bundledSkillFile), { recursive: true });
  await fs.writeFile(bundledSkillFile, 'test managed Skill\n');
  await fs.writeFile(workerFile, [
    "process.stdout.write('unit worker ready\\n');",
    "process.send?.({ type: 'ready', pid: process.pid });",
    "process.on('message', (message) => { if (message === 'shutdown') process.exit(0); });",
    "process.on('disconnect', () => process.exit(0));",
    'setInterval(() => undefined, 1000).unref();',
  ].join('\n'));

  const daemons: Promise<void>[] = [];
  const launches: Array<{ file: string; args: readonly string[] }> = [];
  const runtime = cliRuntime(root, {
    packageRoot,
    launchDaemon: (request) => {
      launches.push({ file: request.file, args: request.args });
      daemons.push(runNativeDaemon({
        home: request.env.KINTIO_HOME!,
        configFile: request.env.KINTIO_CONFIG_FILE!,
        packageRoot,
        environment: request.env,
      }));
      return {
        pid: process.pid,
        exited: daemons.at(-1)!,
        kill: () => false,
      };
    },
  });
  t.onTestFinished(async () => {
    await runCli(['stop', '--home', home], runtime.overrides).catch(() => 1);
    await Promise.allSettled(daemons);
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.deepEqual(launches, [{
    file: process.execPath,
    args: [path.join(packageRoot, 'dist/daemon.js')],
  }]);
  assert.equal(await runCli(['status', '--home', home], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Kintio is running in service mode/u);
  const mismatched = cliRuntime(root, {
    packageRoot: path.join(root, 'other-installation'),
  });
  assert.equal(await runCli(['status', '--home', home], mismatched.overrides), 1);
  assert.match(mismatched.stderr.join(''), /another config or installation/u);
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /already running/u);
  assert.equal(await runCli([
    'logs', '--home', home, '--no-follow', '--lines', '10',
  ], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /unit worker ready/u);
  const firstRunId = readDaemonRecord(home)?.runId;
  assert.ok(firstRunId);
  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 0);
  assert.notEqual(readDaemonRecord(home)?.runId, firstRunId);
  assert.equal(launches.length, 2);
  assert.equal(await runCli(['stop', '--home', home], runtime.overrides), 0);
  await Promise.all(daemons);
});

test('update verifies changed package contents before starting the new service Worker', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const workerVersionFile = path.join(root, 'service-worker-version');
  const { packageRoot, prefix } = await updatePackage(root);
  const workerFile = path.join(packageRoot, 'dist/index.js');
  await Promise.all([
    fs.mkdir(path.dirname(workerFile), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
      recursive: true,
    }),
    fs.copyFile('.env.example', path.join(packageRoot, '.env.example')),
  ]);
  await fs.writeFile(workerFile, [
    "import fs from 'node:fs';",
    "const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));",
    'fs.writeFileSync(process.env.KINTIO_TEST_WORKER_VERSION, manifest.version);',
    "process.send?.({ type: 'ready', pid: process.pid });",
    "process.on('message', (message) => {",
    "  if (message === 'shutdown') process.exit(0);",
    "  if (message?.type === 'stop-if-idle') process.send?.({",
    "    type: 'stop-if-idle-result', requestId: message.requestId,",
    "    pid: process.pid, ok: true, idle: true,",
    "  });",
    "});",
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  const setupRuntime = cliRuntime(root, { packageRoot });
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const identity = readInstalledPackageIdentity(packageRoot);
  const targetVersion = '9.8.7';
  const daemons: Promise<void>[] = [];
  const runtime = cliRuntime(root, {
    env: { ...process.env, KINTIO_TEST_WORKER_VERSION: workerVersionFile },
    packageRoot,
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion,
        installation: { ...identity, manager: 'npm', prefix },
        command: { file: 'npm', args: ['install'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => {
        await Promise.all([
          fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
            name: '@kin-tio/cli',
            version: targetVersion,
            bin: { kintio: 'bin/kintio.js' },
          })}\n`),
          fs.writeFile(
            path.join(packageRoot, 'bin/kintio.js'),
            `process.stdout.write(${JSON.stringify(`${targetVersion}\n`)});\n`,
          ),
        ]);
      },
      verify: verifyPreparedKintioUpdate,
    },
    launchDaemon: (request) => {
      const running = runNativeDaemon({
        home,
        configFile: path.join(home, '.env'),
        packageRoot,
        environment: request.env,
      });
      daemons.push(running);
      return { pid: process.pid, exited: running, kill: () => false };
    },
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await Promise.allSettled(daemons);
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(workerVersionFile, 'utf8'), KINTIO_VERSION);
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(workerVersionFile, 'utf8'), targetVersion);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  assert.match(runtime.stdout.join(''), /service Runtime was restored/u);
  assert.match(runtime.stdout.join(''), new RegExp(`${targetVersion} was installed successfully`));
});

test('pnpm update restores from the stable link after it moves to a new store', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const markerFile = path.join(root, 'pnpm-worker-version');
  const oldStore = path.join(root, 'pnpm/store/old/@kin-tio/cli');
  const newStore = path.join(root, 'pnpm/store/new/@kin-tio/cli');
  const stableRoot = path.join(root, 'pnpm/global/v10/node_modules/@kin-tio/cli');
  const globalDir = path.join(root, 'pnpm/global');
  const globalBinDir = path.join(root, 'pnpm/bin');
  const targetVersion = '9.8.7';
  const writeStore = async (store: string, version: string): Promise<void> => {
    await Promise.all([
      fs.mkdir(path.join(store, 'bin'), { recursive: true }),
      fs.mkdir(path.join(store, 'dist'), { recursive: true }),
      fs.cp('codex-workspace', path.join(store, 'codex-workspace'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(store, 'package.json'), `${JSON.stringify({
        name: '@kin-tio/cli',
        version,
        bin: { kintio: 'bin/kintio.js' },
      })}\n`),
      fs.writeFile(
        path.join(store, 'bin/kintio.js'),
        `process.stdout.write(${JSON.stringify(`${version}\n`)});\n`,
      ),
      fs.writeFile(path.join(store, '.env.example'), ''),
      fs.writeFile(path.join(store, 'dist/index.js'), [
        "import fs from 'node:fs';",
        `fs.writeFileSync(process.env.KINTIO_TEST_WORKER_VERSION, ${JSON.stringify(version)});`,
        "process.send?.({ type: 'ready', pid: process.pid });",
        "process.on('message', (message) => {",
        "  if (message === 'shutdown') process.exit(0);",
        "  if (message?.type === 'stop-if-idle') process.send?.({",
        "    type: 'stop-if-idle-result', requestId: message.requestId,",
        "    pid: process.pid, ok: true, idle: true,",
        "  });",
        "});",
        "process.on('disconnect', () => process.exit(0));",
      ].join('\n')),
    ]);
  };
  await Promise.all([
    writeStore(oldStore, KINTIO_VERSION),
    writeStore(newStore, targetVersion),
    fs.mkdir(path.dirname(stableRoot), { recursive: true }),
    fs.mkdir(globalBinDir, { recursive: true }),
  ]);
  await fs.symlink(oldStore, stableRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const setupRuntime = cliRuntime(root, { packageRoot: oldStore });
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const identity = readInstalledPackageIdentity(stableRoot);
  const daemons: Promise<void>[] = [];
  const runtime = cliRuntime(root, {
    env: { ...process.env, KINTIO_TEST_WORKER_VERSION: markerFile },
    packageRoot: oldStore,
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion,
        installation: {
          ...identity,
          packageRoot: stableRoot,
          binFile: path.join(stableRoot, 'bin/kintio.js'),
          manager: 'pnpm',
          globalDir,
          globalBinDir,
        },
        command: { file: 'pnpm', args: ['add'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => {
        await fs.rm(stableRoot);
        await fs.symlink(
          newStore,
          stableRoot,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
      verify: verifyPreparedKintioUpdate,
    },
    launchDaemon: (request) => {
      const requestedPackageRoot = path.dirname(path.dirname(request.args[0]!));
      const running = runNativeDaemon({
        home,
        configFile: path.join(home, '.env'),
        packageRoot: requestedPackageRoot,
        environment: request.env,
      });
      daemons.push(running);
      return { pid: process.pid, exited: running, kill: () => false };
    },
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await Promise.allSettled(daemons);
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(markerFile, 'utf8'), KINTIO_VERSION);
  assert.equal(readDaemonRecord(home)?.packageRoot, oldStore);
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(markerFile, 'utf8'), targetVersion);
  assert.equal(readDaemonRecord(home)?.packageRoot, stableRoot);
  assert.equal(await fs.realpath(stableRoot), await fs.realpath(newStore));
});

test('update refuses active work and restores an idle service daemon', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const idleFile = path.join(root, 'worker-idle');
  const mutateConfigFile = path.join(root, 'worker-mutate-config');
  const stateFile = path.join(root, 'state', 'custom.sqlite');
  const { packageRoot, prefix } = await updatePackage(root);
  await Promise.all([
    fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
    fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
      recursive: true,
    }),
    fs.copyFile('.env.example', path.join(packageRoot, '.env.example')),
    fs.writeFile(idleFile, '0'),
    fs.writeFile(mutateConfigFile, '0'),
  ]);
  await fs.writeFile(path.join(packageRoot, 'dist/index.js'), [
    "import fs from 'node:fs';",
    "if (fs.readFileSync(process.env.KINTIO_TEST_MUTATE_CONFIG, 'utf8').trim() === '1') fs.appendFileSync(process.env.KINTIO_CONFIG_FILE, '\\nCODEX_WORKING_DIRECTORY=changed-during-restore\\n');",
    "process.send?.({ type: 'ready', pid: process.pid });",
    "process.on('message', (message) => {",
    "  if (message === 'shutdown') process.exit(0);",
    "  if (message?.type === 'stop-if-idle') process.send?.({",
    "    type: 'stop-if-idle-result', requestId: message.requestId,",
    "    pid: process.pid, ok: true,",
    "    idle: fs.readFileSync(process.env.KINTIO_TEST_IDLE_FILE, 'utf8').trim() === '1',",
    "  });",
    "});",
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  const setupRuntime = cliRuntime(root, { packageRoot });
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const identity = readInstalledPackageIdentity(packageRoot);
  let installs = 0;
  let failInstall = false;
  let failProcessTreeTermination = false;
  let failVerify = false;
  let failRestore = false;
  let changeConfigDuringInstall = false;
  let interruptInstall = false;
  let interruptedHandler: NodeJS.SignalsListener | undefined;
  let loseIdleAck = false;
  let originalSignalListeners: NodeJS.SignalsListener[] = [];
  const daemons: Promise<void>[] = [];
  const shellEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    KINTIO_DB_FILE: stateFile,
    KINTIO_TEST_IDLE_FILE: idleFile,
    KINTIO_TEST_MUTATE_CONFIG: mutateConfigFile,
    PORT: '19999',
    CODEX_HOME: path.join(root, 'agent-a'),
  };
  const runtime = cliRuntime(root, {
    env: shellEnvironment,
    packageRoot,
    stopIfIdle: async (instanceHome, identity) => {
      const response = await requestControl(
        instanceHome,
        'stop-if-idle',
        undefined,
        identity,
      );
      if (!loseIdleAck) return response;
      const deadline = Date.now() + 5_000;
      while (readDaemonRecord(instanceHome) && Date.now() < deadline) await delay(10);
      throw new Error('simulated lost idle ACK');
    },
    updater: {
      prepare: async () => ({
        kind: 'update',
        currentVersion: KINTIO_VERSION,
        targetVersion: '9.8.7',
        installation: {
          ...identity,
          manager: 'npm',
          prefix,
        },
        command: { file: 'npm', args: ['install'] },
        cwd: root,
        environment: { PATH: process.env.PATH },
      }),
      install: async () => {
        installs += 1;
        if (failProcessTreeTermination) {
          throw new ProcessTreeTerminationError('simulated process tree termination failure');
        }
        if (failInstall) throw new Error('simulated package-manager failure');
        if (changeConfigDuringInstall) {
          await fs.appendFile(
            path.join(home, '.env'),
            '\nCODEX_WORKING_DIRECTORY=changed-during-update\n',
          );
        }
        if (interruptInstall) {
          const handler = process.listeners('SIGTERM').find(
            (listener) => !originalSignalListeners.includes(listener),
          );
          assert.ok(handler);
          interruptedHandler = handler;
          (handler as () => void)();
        }
      },
      verify: async () => {
        if (failVerify) throw new Error('simulated version verification failure');
      },
    },
    launchDaemon: (request) => {
      if (failRestore) throw new Error('simulated Runtime restore failure');
      const running = runNativeDaemon({
        home,
        configFile: path.join(home, '.env'),
        packageRoot,
        mode: request.env.KINTIO_DAEMON_MODE as 'service',
        environment: request.env,
      });
      daemons.push(running);
      return { pid: process.pid, exited: running, kill: () => false };
    },
  });
  t.onTestFinished(async () => {
    await requestControl(home, 'stop').catch(() => undefined);
    await Promise.allSettled(daemons);
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  const originalRecord = readDaemonRecord(home);
  assert.equal(originalRecord?.version, 2);
  assert.equal(
    originalRecord?.version === 2 ? originalRecord.state.databaseFile : undefined,
    stateFile,
  );
  assert.ok(originalRecord);
  for (const lockFile of [
    path.join(path.dirname(stateFile), 'unsupported.lock'),
    path.join(root, 'other-state', 'kintio.lock'),
  ]) {
    writeDaemonRecord(home, {
      ...originalRecord,
      state: { databaseFile: stateFile, lockFile },
    });
    assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
    assert.equal(installs, 0);
    assert.equal((await requestControl(home, 'ping')).phase, 'running');
  }
  assert.match(runtime.stderr.join(''), /Unsupported Kintio state lock identity/u);
  assert.match(runtime.stderr.join(''), /could not preserve the running Runtime state identity/u);
  writeDaemonRecord(home, originalRecord);
  runtime.stderr.length = 0;
  writeDaemonRecord(home, {
    version: 1,
    runId: originalRecord.runId,
    daemonPid: originalRecord.daemonPid,
    configFile: originalRecord.configFile,
    mode: originalRecord.mode,
    packageRoot: originalRecord.packageRoot,
    token: originalRecord.token,
  });
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal((await requestControl(home, 'ping')).phase, 'running');
  assert.match(runtime.stderr.join(''), /predates safe update metadata/u);
  writeDaemonRecord(home, originalRecord);
  runtime.stderr.length = 0;
  delete shellEnvironment.PORT;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal(readDaemonRecord(home)?.runId, originalRecord.runId);
  assert.equal((await requestControl(home, 'ping')).phase, 'running');
  assert.match(runtime.stderr.join(''), /current environment does not match/u);
  shellEnvironment.PORT = '19999';
  runtime.stderr.length = 0;
  shellEnvironment.CODEX_HOME = path.join(root, 'agent-b');
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal(readDaemonRecord(home)?.runId, originalRecord.runId);
  assert.match(runtime.stderr.join(''), /current environment does not match/u);
  shellEnvironment.CODEX_HOME = path.join(root, 'agent-a');
  runtime.stderr.length = 0;
  delete shellEnvironment.KINTIO_DB_FILE;
  originalSignalListeners = [...process.listeners('SIGTERM')];
  const busyRunId = readDaemonRecord(home)?.runId;
  const configFile = path.join(home, '.env');
  const validConfig = await fs.readFile(configFile, 'utf8');
  await fs.writeFile(
    configFile,
    `${validConfig}\nSHUTDOWN_TIMEOUT_MS=0\n`,
  );
  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home)?.runId, busyRunId);
  assert.equal((await requestControl(home, 'ping')).phase, 'running');
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal(readDaemonRecord(home)?.runId, busyRunId);
  await fs.writeFile(configFile, validConfig);
  runtime.stderr.length = 0;

  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal(readDaemonRecord(home)?.runId, busyRunId);
  assert.equal((await requestControl(home, 'ping')).phase, 'running');
  assert.match(runtime.stderr.join(''), /active conversation work/u);

  await fs.writeFile(idleFile, '1');
  runtime.stderr.length = 0;
  loseIdleAck = true;
  const beforeLostAck = readDaemonRecord(home)?.runId;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 0);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  assert.notEqual(readDaemonRecord(home)?.runId, beforeLostAck);
  assert.match(runtime.stderr.join(''), /simulated lost idle ACK/u);

  loseIdleAck = false;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['upgrade', '--home', home], runtime.overrides), 0);
  assert.equal(installs, 1);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  const upgradedRecord = readDaemonRecord(home);
  assert.equal(
    upgradedRecord?.version === 2 ? upgradedRecord.state.databaseFile : undefined,
    stateFile,
  );
  assert.notEqual(readDaemonRecord(home)?.runId, busyRunId);
  assert.match(runtime.stdout.join(''), /service Runtime was restored/u);

  const beforeFailedUpdate = readDaemonRecord(home)?.runId;
  failInstall = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 2);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  assert.notEqual(readDaemonRecord(home)?.runId, beforeFailedUpdate);
  assert.match(runtime.stderr.join(''), /simulated package-manager failure/u);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);

  failInstall = false;
  failVerify = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  assert.match(runtime.stderr.join(''), /simulated version verification failure/u);
  assert.match(runtime.stdout.join(''), /Runtime was restored after the failed update/u);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);

  const beforeInterruptedUpdate = readDaemonRecord(home)?.runId;
  failVerify = false;
  interruptInstall = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(installs, 4);
  assert.equal(readDaemonRecord(home)?.mode, 'service');
  assert.notEqual(readDaemonRecord(home)?.runId, beforeInterruptedUpdate);
  assert.match(runtime.stderr.join(''), /interrupted by SIGTERM/u);
  assert.equal(process.listeners('SIGTERM').length, originalSignalListeners.length);
  assert.ok(interruptedHandler);
  assert.equal(process.listeners('SIGTERM').includes(interruptedHandler), false);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);

  interruptInstall = false;
  changeConfigDuringInstall = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home), null);
  assert.match(runtime.stderr.join(''), /configuration changed during the package update/u);
  assert.doesNotMatch(runtime.stdout.join(''), /Runtime was restored/u);
  await fs.writeFile(configFile, validConfig);
  shellEnvironment.KINTIO_DB_FILE = stateFile;
  changeConfigDuringInstall = false;
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  delete shellEnvironment.KINTIO_DB_FILE;

  await fs.writeFile(mutateConfigFile, '1');
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home), null);
  assert.match(runtime.stderr.join(''), /configuration changed while restoring/u);
  assert.doesNotMatch(runtime.stdout.join(''), /Runtime was restored/u);
  await Promise.all([
    fs.writeFile(mutateConfigFile, '0'),
    fs.writeFile(configFile, validConfig),
  ]);
  shellEnvironment.KINTIO_DB_FILE = stateFile;
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  delete shellEnvironment.KINTIO_DB_FILE;

  failProcessTreeTermination = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home), null);
  assert.match(runtime.stderr.join(''), /process tree termination failure/u);
  assert.match(runtime.stderr.join(''), /Runtime remains stopped/u);
  assert.doesNotMatch(runtime.stdout.join(''), /Runtime was restored/u);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);

  failProcessTreeTermination = false;
  shellEnvironment.KINTIO_DB_FILE = stateFile;
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  delete shellEnvironment.KINTIO_DB_FILE;
  failRestore = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home), null);
  assert.match(runtime.stderr.join(''), /was installed, but the service Runtime was not restored/u);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);

  failRestore = false;
  shellEnvironment.KINTIO_DB_FILE = stateFile;
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  delete shellEnvironment.KINTIO_DB_FILE;
  failInstall = true;
  failRestore = true;
  runtime.stdout.length = 0;
  runtime.stderr.length = 0;
  assert.equal(await runCli(['update', '--home', home], runtime.overrides), 1);
  assert.equal(readDaemonRecord(home), null);
  assert.match(runtime.stderr.join(''), /simulated package-manager failure/u);
  assert.match(runtime.stderr.join(''), /simulated Runtime restore failure/u);
  assert.doesNotMatch(runtime.stdout.join(''), /installed successfully/u);
});

test('a lifecycle lock rejects concurrent background mutation', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const lock = acquireSingleInstanceLock({
    filePath: path.join(home, 'data/lifecycle.lock'),
  });
  t.onTestFinished(() => { lock.release(); });
  let launched = false;
  let foregroundExecuted = false;
  let loginStarted = false;
  let accountChanged = false;
  const runtime = cliRuntime(root, {
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
    execute: async () => {
      foregroundExecuted = true;
      return 0;
    },
    ilinkLogin: async () => {
      loginStarted = true;
      return 0;
    },
    ilinkAccount: async () => {
      accountChanged = true;
      return { runtimeRequired: false, runningCount: 0 };
    },
  });
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.equal(await runCli(['run', '--home', home], runtime.overrides), 1);
  assert.equal(await runCli(['ilink', 'login', '--home', home], runtime.overrides), 1);
  assert.equal(await runCli([
    'ilink', 'start', '--foreground', '--home', home,
  ], runtime.overrides), 1);
  assert.equal(launched, false);
  assert.equal(foregroundExecuted, false);
  assert.equal(loginStarted, false);
  assert.equal(accountChanged, false);
  assert.match(runtime.stderr.join(''), /lifecycle command is already running/u);
});

test('background startup policy and stale metadata fail safely', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  let launched = false;
  const invalid = cliRuntime(root, {
    env: { KINTIO_START_TIMEOUT_MS: 'invalid' },
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
  });
  assert.equal(await runCli(['start', '--home', home], invalid.overrides), 1);
  assert.equal(launched, false);
  assert.match(invalid.stderr.join(''), /KINTIO_START_TIMEOUT_MS/u);

  writeDaemonRecord(home, {
    version: 1,
    runId: 'stale-daemon',
    daemonPid: 2_147_483_647,
    configFile: path.join(home, '.env'),
    mode: 'service',
    packageRoot: path.resolve('.'),
    token: 's'.repeat(43),
  });
  const status = cliRuntime(root);
  assert.equal(await runCli(['status', '--home', home], status.overrides), 0);
  assert.match(status.stdout.join(''), /not running/u);
  await assert.rejects(
    fs.access(path.join(home, 'data/daemon.json')),
    { code: 'ENOENT' },
  );

  writeDaemonRecord(home, {
    version: 1,
    runId: 'unreachable-daemon',
    daemonPid: process.pid,
    configFile: path.join(home, '.env'),
    mode: 'service',
    packageRoot: path.resolve('.'),
    token: 'u'.repeat(43),
  });
  const unreachable = cliRuntime(root);
  assert.equal(await runCli(['status', '--home', home], unreachable.overrides), 1);
  assert.match(unreachable.stderr.join(''), /running but unreachable/u);
  await fs.rm(path.join(home, 'data/daemon.json'), { force: true });

  const logs = cliRuntime(root);
  assert.equal(await runCli([
    'logs', '--home', home, '--no-follow',
  ], logs.overrides), 1);
  assert.match(logs.stderr.join(''), /no background logs/u);
});

test('background start reports a daemon that never publishes readiness', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  let launched = false;
  const runtime = cliRuntime(root, {
    env: { KINTIO_START_TIMEOUT_MS: '1000' },
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
  });
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.equal(launched, true);
  assert.match(runtime.stderr.join(''), /failed to become ready/u);
});

test('failed background start rolls back the exact detached process', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  let daemonPid = 0;
  const runtime = cliRuntime(root, {
    env: { ...process.env, KINTIO_START_TIMEOUT_MS: '1000' },
    launchDaemon: () => {
      const child = crossSpawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1000)'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      assert.ok(child.pid);
      daemonPid = child.pid;
      child.unref();
      return {
        pid: daemonPid,
        exited: new Promise<void>((resolve) => {
          child.once('close', () => resolve());
        }),
        kill: (signal: NodeJS.Signals) => child.kill(signal),
      };
    },
  });
  t.onTestFinished(() => {
    try {
      if (daemonPid) process.kill(daemonPid, 'SIGKILL');
    } catch {
      // The rollback is expected to have removed it already.
    }
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /failed to become ready/u);
  assert.throws(() => process.kill(daemonPid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(path.join(home, 'data/daemon.json')), { code: 'ENOENT' });
});

test('setup refuses linked config and workspace paths that escape the instance', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const outsideConfig = path.join(outside, '.env');
  await fs.writeFile(outsideConfig, 'PORT=9999\n');
  await fs.mkdir(home, { recursive: true });
  await fs.symlink(outsideConfig, path.join(home, '.env'), 'file');
  const configRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], configRuntime.overrides), 1);
  assert.match(configRuntime.stderr.join(''), /not a regular file/u);

  await fs.rm(path.join(home, '.env'), { force: true });
  await fs.mkdir(path.join(home, 'codex-workspace'), { recursive: true });
  await fs.symlink(
    outside,
    path.join(home, 'codex-workspace/.agents'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const skillRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], skillRuntime.overrides), 1);
  assert.match(skillRuntime.stderr.join(''), /symbolic link|not a directory/u);
});

test('setup enforces POSIX modes without treating chmod as Windows ACL evidence', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.chmod(path.join(home, '.env'), 0o644);
  const runtime = cliRuntime(root);
  const result = await runCli(['setup', '--home', home], runtime.overrides);
  assert.equal(result, process.platform === 'win32' ? 0 : 1);
  if (process.platform !== 'win32') {
    assert.match(runtime.stderr.join(''), /must not be accessible by group or other users/u);
  }
});

test('managed Skill rejects a pre-existing non-private leaf directory on POSIX', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const initial = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], initial.overrides), 0);
  await fs.appendFile(
    path.join(home, '.env'),
    '\nCODEX_WORKING_DIRECTORY=./custom-workspace\n',
  );
  const leaf = path.join(
    home,
    'custom-workspace/.agents/skills/wechat-kf-reply-sop',
  );
  await fs.mkdir(leaf, { recursive: true });
  await fs.chmod(leaf, 0o755);

  const runtime = cliRuntime(root);
  const result = await runCli(['setup', '--home', home], runtime.overrides);
  assert.equal(result, process.platform === 'win32' ? 0 : 1);
  if (process.platform !== 'win32') {
    assert.match(runtime.stderr.join(''), /unsafe permissions/u);
  }
});

test('Windows instance metadata stays inside the current user profile', async (t) => {
  const root = await temporaryRoot(t);
  const profile = path.join(root, 'profile');
  const outside = path.join(root, 'shared', 'instance');
  await fs.mkdir(profile, { recursive: true });
  const runtime = cliRuntime(root, { homeDirectory: profile });
  const result = await runCli(['setup', '--home', outside], runtime.overrides);
  if (process.platform === 'win32') {
    assert.equal(result, 1);
    assert.match(runtime.stderr.join(''), /inside the current user profile/u);
  } else {
    assert.equal(result, 0);
  }
});
