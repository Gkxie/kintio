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

test('global CLI exposes stable help, version, and argument failures', async (t) => {
  const runtime = cliRuntime(await temporaryRoot(t));
  assert.equal(await runCli([], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /Commands:\n  setup/u);
  assert.match(runtime.stdout.join(''), /ilink login/u);
  assert.match(runtime.stdout.join(''), /ilink start/u);
  assert.match(runtime.stdout.join(''), /ilink delete/u);
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
  const workerFile = path.join(packageRoot, 'dist/ilink.js');
  await fs.mkdir(path.dirname(workerFile), { recursive: true });
  await fs.cp('codex-workspace', path.join(packageRoot, 'codex-workspace'), {
    recursive: true,
  });
  await fs.writeFile(workerFile, [
    "process.send?.({ type: 'ready', pid: process.pid });",
    "process.on('message', (message) => { if (message === 'shutdown') process.exit(0); });",
    "process.on('disconnect', () => process.exit(0));",
  ].join('\n'));
  const daemonRuns: Promise<void>[] = [];
  const accountKey = `ia_${'b'.repeat(40)}` as const;
  const accountCalls: Array<{ command: string; defer?: boolean; selector?: string }> = [];
  const runtime = cliRuntime(root, {
    packageRoot,
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
  assert.match(runtime.stdout.join(''), /running in background/u);
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
  const runtime = cliRuntime(root, {
    launchDaemon: () => {
      launched = true;
      return exitedDaemon();
    },
  });
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.equal(launched, false);
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
