import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { test } from 'vitest';
import crossSpawn from 'cross-spawn';

import { runCli } from '../../src/cli.ts';
import { runNativeDaemon } from '../../src/runtime/native-daemon.ts';
import {
  readDaemonRecord,
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
  runtime.stdout.length = 0;
  assert.equal(await runCli(['--version'], runtime.overrides), 0);
  assert.equal(runtime.stdout.join(''), `${KINTIO_VERSION}\n`);
  assert.equal(await runCli(['unknown'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /Unknown command: unknown/u);
  runtime.stderr.length = 0;
  assert.equal(await runCli(['start', '--lines', '5'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /valid only for "kintio logs"/u);
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
  const configFile = path.join(home, '.env');
  const runtime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  await fs.appendFile(
    configFile,
    '\nCODEX_WORKING_DIRECTORY=./custom-agent-workspace\n',
  );
  runtime.stdout.length = 0;

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  const customSkill = path.join(
    home,
    'custom-agent-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
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
  assert.match(runtime.stdout.join(''), /Kintio is running/u);
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

test('configuration privacy follows POSIX modes and Windows profile ACLs', async (t) => {
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
