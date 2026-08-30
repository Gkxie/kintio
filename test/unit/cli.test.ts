import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { writeReadyMarker } from '../../src/runtime/ready-marker.ts';
import { acquireSingleInstanceLock } from '../../src/runtime/single-instance-lock.ts';
import { KINTIO_VERSION } from '../../src/version.ts';

type CliExecute = NonNullable<
  NonNullable<Parameters<typeof runCli>[1]>['execute']
>;

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-cli-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function cliRuntime(root: string, execute?: CliExecute) {
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
      ...(execute ? { execute } : {}),
    },
  };
}

test('global CLI exposes stable help, version, and argument failures', async (t) => {
  const root = await temporaryRoot(t);
  const runtime = cliRuntime(root);

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

test('setup creates one private config and installs the Agent skill idempotently', async (t) => {
  const root = await temporaryRoot(t);
  const runtime = cliRuntime(root);
  const home = path.join(root, 'instance');

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  const configFile = path.join(home, '.env');
  const skillFile = path.join(
    home,
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  );
  const firstConfig = await fs.readFile(configFile, 'utf8');
  const bundledSkill = await fs.readFile(
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
    'utf8',
  );
  assert.match(firstConfig, /^KINTIO_MCP_BEARER_TOKEN=[A-Za-z0-9_-]{43}$/mu);
  assert.equal(await fs.readFile(skillFile, 'utf8'), bundledSkill);

  await fs.writeFile(skillFile, 'stale local skill\n');
  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 0);
  assert.equal(await fs.readFile(configFile, 'utf8'), firstConfig);
  assert.equal(await fs.readFile(skillFile, 'utf8'), bundledSkill);
  assert.match(runtime.stdout.join(''), /Config: .+ \(kept\)/u);
  assert.match(runtime.stdout.join(''), /Agent skill: .+ \(updated\)/u);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(skillFile)).mode & 0o777, 0o600);
  }
});

test('start validates the instance and delegates one background process to PM2', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);

  const requests: Array<{
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly capture?: boolean;
    readonly timeoutMs?: number;
  }> = [];
  let started = false;
  let activeToken = '';
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request);
    if (request.args.includes('jlist')) {
      return {
        code: 0,
        stdout: started
          ? JSON.stringify([{
              name: 'kintio',
              pid: 2468,
              pm2_env: {
                status: 'online',
                pm_exec_path: path.join(path.resolve('.'), 'dist/index.js'),
                KINTIO_HOME: home,
                KINTIO_CONFIG_FILE: path.join(home, '.env'),
                KINTIO_START_TOKEN: activeToken,
              },
            }])
          : '[]',
        stderr: '',
      };
    }
    if (request.args.includes('start')) {
      started = true;
      activeToken = String(request.env.KINTIO_START_TOKEN);
      writeReadyMarker(home, activeToken, 2468);
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  runtime.overrides.env = {
    HOME: root,
    PATH: process.env.PATH,
    HTTPS_PROXY: 'http://proxy.example:8080',
    SENSITIVE_UNRELATED_SECRET: 'must-not-reach-pm2',
  };

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1]?.args.slice(1), [
    'start',
    path.join(path.resolve('.'), 'ecosystem.config.cjs'),
    '--only',
    'kintio',
  ]);
  assert.equal(requests[1]?.env.KINTIO_HOME, home);
  assert.equal(requests[1]?.env.KINTIO_CONFIG_FILE, path.join(home, '.env'));
  assert.equal(requests[1]?.env.PM2_HOME, path.join(home, 'data/pm2'));
  assert.equal(requests[1]?.env.NODE_ENV, 'production');
  assert.equal(requests[1]?.env.KINTIO_KILL_TIMEOUT_MS, '17000');
  assert.equal(requests[1]?.env.HOME, root);
  assert.equal(requests[1]?.env.HTTPS_PROXY, 'http://proxy.example:8080');
  assert.equal(requests[1]?.env.SENSITIVE_UNRELATED_SECRET, undefined);
  assert.match(requests[1]?.env.KINTIO_START_TOKEN || '', /^[A-Za-z0-9_-]{43}$/u);
  assert.ok((requests[0]?.timeoutMs || 0) > 0);
  assert.ok((requests[1]?.timeoutMs || 0) > 0);
  assert.ok((requests[1]?.timeoutMs || 0) <= (requests[0]?.timeoutMs || 0));
});

test('start is idempotent while restart deliberately refreshes the PM2 process', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);

  const requests: Array<readonly string[]> = [];
  const existingToken = 'e'.repeat(43);
  let activeToken = existingToken;
  writeReadyMarker(home, existingToken, 4321);
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request.args);
    if (!request.capture && request.args.includes('start')) {
      activeToken = String(request.env.KINTIO_START_TOKEN);
      writeReadyMarker(home, activeToken, 4321);
    }
    return request.capture
      ? {
          code: 0,
          stdout: JSON.stringify([{
            name: 'kintio',
            pid: 4321,
            pm2_env: {
              status: 'online',
              pm_exec_path: path.join(path.resolve('.'), 'dist/index.js'),
              KINTIO_HOME: home,
              KINTIO_CONFIG_FILE: path.join(home, '.env'),
              KINTIO_START_TOKEN: activeToken,
            },
          }]),
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' };
  });
  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 0);
  assert.equal(requests.length, 2);
  assert.match(runtime.stdout.join(''), /already running \(PID 4321\)/u);

  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 0);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests[3]?.slice(1), ['delete', 'kintio']);
  assert.equal(requests[4]?.includes('start'), true);
  assert.equal(requests[5]?.includes('jlist'), true);
});

test('restart gives shutdown and fresh readiness independent time budgets', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.appendFile(path.join(home, '.env'), '\nSHUTDOWN_TIMEOUT_MS=60000\n');

  let now = 1_000_000;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
  t.onTestFinished(() => dateNow.mockRestore());
  const requests: Array<{
    readonly args: readonly string[];
    readonly timeoutMs?: number;
  }> = [];
  let started = false;
  let activeToken = 'e'.repeat(43);
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request);
    if (request.args.includes('delete')) {
      now += 60_000;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (request.args.includes('start')) {
      started = true;
      activeToken = String(request.env.KINTIO_START_TOKEN);
      writeReadyMarker(home, activeToken, 2468);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      stdout: JSON.stringify([{
        name: 'kintio',
        pid: 2468,
        pm2_env: {
          status: 'online',
          kill_timeout: 67_000,
          pm_exec_path: path.join(path.resolve('.'), 'dist/index.js'),
          KINTIO_HOME: home,
          KINTIO_CONFIG_FILE: path.join(home, '.env'),
          KINTIO_START_TOKEN: activeToken,
        },
      }]),
      stderr: '',
    };
  });

  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 0);
  assert.equal(started, true);
  const deleted = requests.find((request) => request.args.includes('delete'));
  const startedRequest = requests.find((request) => request.args.includes('start'));
  assert.equal(deleted?.timeoutMs, 72_000);
  assert.ok((startedRequest?.timeoutMs || 0) > 0);
  assert.ok((startedRequest?.timeoutMs || 0) <= 30_000);
});

test('start refuses to silently reuse a different online installation or instance', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const runtime = cliRuntime(root, async () => ({
    code: 0,
    stdout: JSON.stringify([{
      name: 'kintio',
      pid: 5566,
      pm2_env: {
        status: 'online',
        pm_exec_path: '/another/kintio/dist/index.js',
        KINTIO_HOME: '/another/instance',
        KINTIO_CONFIG_FILE: '/another/instance/.env',
      },
    }]),
    stderr: '',
  }));

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /another installation or instance/u);
  assert.match(runtime.stderr.join(''), /use "kintio restart"/u);
});

test('start refuses an online process without matching readiness evidence', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const runtime = cliRuntime(root, async () => ({
    code: 0,
    stdout: JSON.stringify([{
      name: 'kintio',
      pid: 5577,
      pm2_env: {
        status: 'online',
        pm_exec_path: path.join(path.resolve('.'), 'dist/index.js'),
        KINTIO_HOME: home,
        KINTIO_CONFIG_FILE: path.join(home, '.env'),
      },
    }]),
    stderr: '',
  }));

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /no readiness identity/u);
});

test('an idempotent readiness probe failure never stops the existing process', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const token = 'q'.repeat(43);
  const requests: Array<readonly string[]> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request.args.slice(1));
    if (requests.length === 1) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: 'kintio',
          pid: 5588,
          pm2_env: {
            status: 'online',
            pm_exec_path: path.join(path.resolve('.'), 'dist/index.js'),
            KINTIO_HOME: home,
            KINTIO_CONFIG_FILE: path.join(home, '.env'),
            KINTIO_START_TOKEN: token,
          },
        }]),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: 'probe failed' };
  });

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.deepEqual(requests, [['jlist'], ['jlist']]);
});

test('restart validates startup policy before mutating an existing PM2 entry', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  let executions = 0;
  const runtime = cliRuntime(root, async () => {
    executions += 1;
    return { code: 0, stdout: '[]', stderr: '' };
  });
  runtime.overrides.env = { KINTIO_START_TIMEOUT_MS: 'invalid' };

  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 1);
  assert.equal(executions, 0);
  assert.match(runtime.stderr.join(''), /KINTIO_START_TIMEOUT_MS/u);
});

test('run stays in the foreground and explicit config selects its instance root', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'existing');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);

  const requests: Array<{
    readonly file: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request);
    return { code: 0, stdout: '', stderr: '' };
  });
  const configFile = path.join(home, '.env');
  assert.equal(await runCli(['run', '--config', configFile], runtime.overrides), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.file, process.execPath);
  assert.deepEqual(requests[0]?.args, [path.join(path.resolve('.'), 'dist/index.js')]);
  assert.equal(requests[0]?.env.KINTIO_HOME, home);
  assert.equal(requests[0]?.env.KINTIO_CONFIG_FILE, configFile);
  await assert.rejects(fs.access(path.join(home, 'data/pm2')), { code: 'ENOENT' });
});

test('an explicit home or config selects one coherent instance over stale environment selectors', async (t) => {
  const root = await temporaryRoot(t);
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', homeA], setupRuntime.overrides), 0);
  assert.equal(await runCli(['setup', '--home', homeB], setupRuntime.overrides), 0);
  const requests: Array<NodeJS.ProcessEnv> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request.env);
    return { code: 0, stdout: '', stderr: '' };
  });
  runtime.overrides.env = {
    KINTIO_HOME: homeA,
    KINTIO_CONFIG_FILE: path.join(homeA, '.env'),
  };

  assert.equal(
    await runCli(['run', '--config', path.join(homeB, '.env')], runtime.overrides),
    0,
  );
  assert.equal(requests.at(-1)?.KINTIO_HOME, homeB);
  assert.equal(requests.at(-1)?.KINTIO_CONFIG_FILE, path.join(homeB, '.env'));

  assert.equal(await runCli(['run', '--home', homeB], runtime.overrides), 0);
  assert.equal(requests.at(-1)?.KINTIO_HOME, homeB);
  assert.equal(requests.at(-1)?.KINTIO_CONFIG_FILE, path.join(homeB, '.env'));
});

test('stop, status, and bounded log options delegate directly to PM2', async (t) => {
  const root = await temporaryRoot(t);
  const defaultHome = path.join(root, '.kintio');
  const requests: Array<readonly string[]> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request.args.slice(1));
    if (request.args.includes('jlist')) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: 'kintio',
          pid: 7788,
          pm2_env: {
            status: 'online',
            KINTIO_HOME: defaultHome,
            KINTIO_CONFIG_FILE: path.join(defaultHome, '.env'),
          },
        }]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  assert.equal(await runCli(['stop'], runtime.overrides), 0);
  assert.deepEqual(requests.splice(0), [['jlist'], ['stop', 'kintio']]);

  assert.equal(await runCli(['status'], runtime.overrides), 0);
  assert.deepEqual(requests.splice(0), [['jlist'], ['status', 'kintio']]);

  assert.equal(
    await runCli(['logs', '--lines', '250', '--no-follow'], runtime.overrides),
    0,
  );
  assert.deepEqual(requests.splice(0), [
    ['jlist'],
    ['logs', 'kintio', '--lines', '250', '--nostream'],
  ]);

  assert.equal(await runCli(['logs', '--lines', '0'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /integer between 1 and 10000/u);
});

test('stop honors the registered PM2 graceful-shutdown budget', async (t) => {
  const root = await temporaryRoot(t);
  const defaultHome = path.join(root, '.kintio');
  const requests: Array<Parameters<CliExecute>[0]> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request);
    if (request.args.includes('jlist')) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: 'kintio',
          pid: 7788,
          pm2_env: {
            status: 'online',
            kill_timeout: 67_000,
            KINTIO_HOME: defaultHome,
            KINTIO_CONFIG_FILE: path.join(defaultHome, '.env'),
          },
        }]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  assert.equal(await runCli(['stop'], runtime.overrides), 0);
  assert.equal(requests.find((request) => request.args.includes('stop'))?.timeoutMs, 72_000);
});

test('missing config and a stopped PM2 instance produce explicit non-destructive outcomes', async (t) => {
  const root = await temporaryRoot(t);
  const runtime = cliRuntime(root, async () => ({
    code: 0,
    stdout: '[]\n',
    stderr: '',
  }));

  assert.equal(await runCli(['start'], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /config is missing; run "kintio setup"/u);
  assert.equal(await runCli(['stop'], runtime.overrides), 0);
  assert.match(runtime.stdout.join(''), /not running/u);
});

test('stop terminates a registered crash loop even when no worker PID is online', async (t) => {
  const root = await temporaryRoot(t);
  const defaultHome = path.join(root, '.kintio');
  const requests: Array<readonly string[]> = [];
  const runtime = cliRuntime(root, async (request) => {
    requests.push(request.args.slice(1));
    return request.capture
      ? {
          code: 0,
          stdout: JSON.stringify([{
            name: 'kintio',
            pid: 0,
            pm2_env: {
              status: 'waiting restart',
              KINTIO_HOME: defaultHome,
              KINTIO_CONFIG_FILE: path.join(defaultHome, '.env'),
            },
          }]),
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' };
  });

  assert.equal(await runCli(['stop'], runtime.overrides), 0);
  assert.deepEqual(requests, [['jlist'], ['stop', 'kintio']]);
});

test('a lifecycle lock prevents concurrent mutation in one PM2 namespace', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  const pm2Home = path.join(home, 'data/pm2');
  await fs.mkdir(pm2Home, { recursive: true, mode: 0o700 });
  const lock = acquireSingleInstanceLock({
    filePath: path.join(pm2Home, 'kintio-cli.lock'),
  });
  t.onTestFinished(() => { lock.release(); });
  let executions = 0;
  const runtime = cliRuntime(root, async () => {
    executions += 1;
    return { code: 0, stdout: '[]', stderr: '' };
  });

  assert.equal(await runCli(['restart', '--home', home], runtime.overrides), 1);
  assert.equal(executions, 0);
  assert.match(runtime.stderr.join(''), /lifecycle command is already running/u);
});

test('setup refuses a symlink in place of the private environment file', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  await fs.mkdir(home, { recursive: true });
  const outside = path.join(root, 'outside.env');
  await fs.writeFile(outside, 'PORT=9999\n');
  await fs.symlink(outside, path.join(home, '.env'));
  const runtime = cliRuntime(root);

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /not a regular file/u);
  assert.equal(await fs.readFile(outside, 'utf8'), 'PORT=9999\n');
});

test('setup rejects an existing config reached through an escaping parent symlink', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const outside = path.join(root, 'outside');
  await fs.mkdir(home);
  await fs.mkdir(outside);
  const outsideConfig = path.join(outside, '.env');
  await fs.writeFile(outsideConfig, 'PORT=9999\n', { mode: 0o600 });
  await fs.symlink(outside, path.join(home, 'linked'));
  const runtime = cliRuntime(root);

  assert.equal(await runCli([
    'setup',
    '--home', home,
    '--config', path.join(home, 'linked/.env'),
  ], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /escapes through a symbolic link/u);
  assert.equal(await fs.readFile(outsideConfig, 'utf8'), 'PORT=9999\n');
});

test('setup refuses a nested symbolic link that would escape the instance root', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(home, 'codex-workspace'), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, 'codex-workspace/.agents'));
  const runtime = cliRuntime(root);

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /escapes through a symbolic link/u);
  await assert.rejects(fs.access(path.join(
    outside,
    'skills/wechat-kf-reply-sop/SKILL.md',
  )));
});

test('setup rejects an identical managed skill reached through an ancestor symlink', async (t) => {
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const outside = path.join(root, 'outside');
  const outsideSkill = path.join(
    outside,
    'skills/wechat-kf-reply-sop/SKILL.md',
  );
  await fs.mkdir(path.dirname(outsideSkill), { recursive: true });
  await fs.copyFile(
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
    outsideSkill,
  );
  await fs.mkdir(path.join(home, 'codex-workspace'), { recursive: true });
  await fs.symlink(outside, path.join(home, 'codex-workspace/.agents'));
  const runtime = cliRuntime(root);

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /escapes through a symbolic link/u);
});

test('start fails closed when an existing config is readable by other users', async (t) => {
  if (process.platform === 'win32') return;
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  const setupRuntime = cliRuntime(root);
  assert.equal(await runCli(['setup', '--home', home], setupRuntime.overrides), 0);
  await fs.chmod(path.join(home, '.env'), 0o644);
  const runtime = cliRuntime(root, async () => ({ code: 0, stdout: '[]', stderr: '' }));

  assert.equal(await runCli(['start', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /must not be accessible by group or other users/u);
});

test('setup refuses an instance directory writable by other users', async (t) => {
  if (process.platform === 'win32') return;
  const root = await temporaryRoot(t);
  const home = path.join(root, 'instance');
  await fs.mkdir(home, { mode: 0o777 });
  await fs.chmod(home, 0o777);
  const runtime = cliRuntime(root);

  assert.equal(await runCli(['setup', '--home', home], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /instance directory has unsafe permissions/u);
});

test('lifecycle selectors cannot target a different registered instance', async (t) => {
  const root = await temporaryRoot(t);
  const runtime = cliRuntime(root, async (request) => {
    if (request.args.includes('jlist')) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: 'kintio',
          pid: 9911,
          pm2_env: {
            status: 'online',
            KINTIO_HOME: '/registered/home',
            KINTIO_CONFIG_FILE: '/registered/home/.env',
          },
        }]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  assert.equal(await runCli(['status', '--home', path.join(root, 'other')], runtime.overrides), 1);
  assert.match(runtime.stderr.join(''), /belongs to another Kintio instance/u);
});
