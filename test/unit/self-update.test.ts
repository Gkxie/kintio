import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { test } from 'vitest';

import { readInstalledPackageIdentity } from '../../src/update/global-install.ts';
import {
  compareStableVersions,
  fetchLatestKintioVersion,
  installPreparedKintioUpdate,
  parseStableVersion,
  prepareKintioUpdate,
  probeGlobalInstallation,
  runCaptured,
  runInherited,
  updateChildEnvironment,
  verifyPreparedKintioUpdate,
} from '../../src/update/self-update.ts';

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-self-update-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeInstalledPackage(packageRoot: string, version = '1.2.3'): Promise<void> {
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@kin-tio/cli',
      version,
      bin: { kintio: 'bin/kintio.js' },
    })}\n`),
    fs.writeFile(path.join(packageRoot, 'bin/kintio.js'), '#!/usr/bin/env node\n'),
  ]);
}

test('stable update versions compare without accepting aliases or prereleases', () => {
  assert.deepEqual(parseStableVersion('1.20.3'), [1, 20, 3]);
  assert.equal(compareStableVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareStableVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareStableVersions('0.9.0', '1.0.0'), -1);
  for (const invalid of [
    'v1.2.3',
    '1.2',
    '1.2.3-beta.1',
    '01.2.3',
    'latest',
    '999999999999999999999.1.1',
  ]) {
    assert.throws(() => parseStableVersion(invalid), /Invalid stable Kintio version/u);
  }
});

test('Registry latest metadata is identity-bound, bounded, and timeout-validated', async () => {
  const requested: Array<{ url: string; init?: RequestInit }> = [];
  const version = await fetchLatestKintioVersion({
    fetchImpl: async (url, init) => {
      requested.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ name: '@kin-tio/cli', version: '2.3.4' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(version, '2.3.4');
  assert.equal(requested[0]?.url, 'https://registry.npmjs.org/@kin-tio%2Fcli/latest');
  assert.equal(new Headers(requested[0]?.init?.headers).get('user-agent'), 'kintio-update');

  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response(
      JSON.stringify({ name: 'another-package', version: '2.3.4' }),
    ),
  }), /another package identity/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response('{', { status: 200 }),
  }), /invalid update metadata/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(64 * 1024 + 1) },
    }),
  }), /exceeds the update metadata limit/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response('', { status: 503 }),
  }), /HTTP 503/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response(JSON.stringify([])),
  }), /invalid update metadata/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response(
      JSON.stringify({ name: '@kin-tio/cli', version: 'latest' }),
    ),
  }), /Invalid stable Kintio version/u);
  await assert.rejects(() => fetchLatestKintioVersion({
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    })),
  }), /exceeds the update metadata limit/u);
  await assert.rejects(() => fetchLatestKintioVersion({ timeoutMs: 0 }), /between 1 and 60000/u);
});

test('package-manager children receive host plumbing but no Kintio credentials', () => {
  const environment = updateChildEnvironment({
    PATH: '/tools',
    HOME: '/profile',
    HTTPS_PROXY: 'http://proxy.invalid',
    NODE_EXTRA_CA_CERTS: '/profile/ca.pem',
    PNPM_HOME: '/profile/pnpm',
    XDG_DATA_HOME: '/profile/share',
    npm_config_prefix: '/profile/node',
    WECOM_KF_SECRET: 'secret',
    ILINK_STORAGE_KEY: 'secret',
    KINTIO_MCP_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret',
  });
  assert.deepEqual(environment, {
    PATH: '/tools',
    HOME: '/profile',
    HTTPS_PROXY: 'http://proxy.invalid',
    NODE_EXTRA_CA_CERTS: '/profile/ca.pem',
    PNPM_HOME: '/profile/pnpm',
    XDG_DATA_HOME: '/profile/share',
    npm_config_prefix: '/profile/node',
  });
});

test('captured update probes use argument arrays and report exact output', async () => {
  const result = await runCaptured({
    file: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      "process.stdout.write(process.argv[1]); process.stderr.write('warning')",
      'path with spaces',
    ],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  });
  assert.deepEqual(result, { code: 0, stdout: 'path with spaces', stderr: 'warning' });
});

test('captured update probes bound both execution time and captured output', async () => {
  const request = (script: string) => ({
    file: process.execPath,
    args: ['--input-type=module', '-e', script],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  });
  await assert.rejects(
    () => runCaptured(request('setInterval(() => undefined, 1000)'), { timeoutMs: 10 }),
    /timed out after 10ms/u,
  );
  await assert.rejects(
    () => runCaptured(request("process.stdout.write('x'.repeat(300_000))")),
    /output exceeded its limit/u,
  );
});

test('inherited update commands preserve their exact exit status', async () => {
  const request = (code: number) => ({
    file: process.execPath,
    args: ['--input-type=module', '-e', `process.exit(${code})`],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  });
  assert.equal(await runInherited(request(0)), 0);
  assert.equal(await runInherited(request(7)), 7);
});

test('an interrupted package update waits for child exit and restores signal listeners', async () => {
  const signal: NodeJS.Signals = 'SIGTERM';
  const previous = [...process.listeners(signal)];
  const running = runInherited({
    file: process.execPath,
    args: ['--input-type=module', '-e', 'setInterval(() => undefined, 1000)'],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  }, { timeoutMs: 2_000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const handler = process.listeners(signal).find((listener) => !previous.includes(listener));
  assert.ok(handler);
  (handler as () => void)();
  (handler as () => void)();
  await assert.rejects(running, /interrupted by SIGTERM/u);
  assert.deepEqual(process.listeners(signal), previous);
});

test('an interrupted package manager returns through cleanup instead of exiting the CLI', async () => {
  const signal: NodeJS.Signals = 'SIGTERM';
  const before = [...process.listeners(signal)];
  const running = runInherited({
    file: process.execPath,
    args: ['--input-type=module', '-e', 'setInterval(() => undefined, 1000)'],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  }, { timeoutMs: 2_000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const listener = process.listeners(signal).find((candidate) => !before.includes(candidate));
  assert.ok(listener);
  (listener as () => void)();
  await assert.rejects(running, /interrupted by SIGTERM/u);
  assert.deepEqual(process.listeners(signal), before);
});

test('interrupting an update terminates the package manager and its descendants', async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, 'descendant.pid');
  let descendantPid = 0;
  t.onTestFinished(() => {
    if (!descendantPid) return;
    try { process.kill(descendantPid, 'SIGKILL'); } catch {}
  });
  const childScript = [
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.argv[1], String(process.pid));',
    'setInterval(() => undefined, 1000);',
  ].join('');
  const parentScript = [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}, process.argv[1]], { stdio: 'ignore' });`,
    'setInterval(() => undefined, 1000);',
  ].join('');
  const signal: NodeJS.Signals = 'SIGTERM';
  const before = [...process.listeners(signal)];
  const running = runInherited({
    file: process.execPath,
    args: ['--input-type=module', '-e', parentScript, pidFile],
    cwd: root,
    env: updateChildEnvironment(process.env),
  }, { timeoutMs: 5_000 });
  const deadline = Date.now() + 2_000;
  while (!descendantPid && Date.now() < deadline) {
    try { descendantPid = Number(await fs.readFile(pidFile, 'utf8')); } catch {}
    if (!descendantPid) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(descendantPid > 0);
  const listener = process.listeners(signal).find((candidate) => !before.includes(candidate));
  assert.ok(listener);
  (listener as () => void)();
  await assert.rejects(running, /interrupted by SIGTERM/u);
  assert.throws(() => process.kill(descendantPid, 0));
  assert.deepEqual(process.listeners(signal), before);
});

test('an unresponsive package manager is killed at the update deadline', async () => {
  await assert.rejects(() => runInherited({
    file: process.execPath,
    args: ['--input-type=module', '-e', 'setInterval(() => undefined, 1000)'],
    cwd: os.tmpdir(),
    env: updateChildEnvironment(process.env),
  }, { timeoutMs: 10 }), /timed out after 10ms/u);
});

test('global installation probes bind update planning to the owning npm prefix', async (t) => {
  const root = await temporaryRoot(t);
  const prefix = path.join(root, 'npm prefix with spaces');
  const packageRoot = path.join(prefix, 'lib/node_modules/@kin-tio/cli');
  await writeInstalledPackage(packageRoot);
  const calls: string[] = [];
  const installation = await probeGlobalInstallation({
    packageRoot,
    cwd: root,
    environment: { PATH: process.env.PATH },
    run: async (request) => {
      calls.push(`${request.file} ${request.args.join(' ')}`);
      if (request.file === 'npm') return { code: 0, stdout: `${prefix}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: 'not installed' };
    },
  });
  assert.equal(installation.manager, 'npm');
  assert.equal(installation.packageRoot, packageRoot);
  assert.equal(calls.length, 6);
});

test('pnpm legacy global layouts derive their owner without configured global-dir', async (t) => {
  const root = await temporaryRoot(t);
  const globalDir = path.join(root, 'pnpm/global');
  const globalRoot = path.join(globalDir, 'v10/node_modules');
  const packageRoot = path.join(globalRoot, '@kin-tio/cli');
  const globalBinDir = path.join(root, 'pnpm/bin');
  await Promise.all([
    writeInstalledPackage(packageRoot),
    fs.mkdir(globalBinDir, { recursive: true }),
  ]);
  const installation = await probeGlobalInstallation({
    packageRoot,
    cwd: root,
    environment: { PATH: process.env.PATH },
    run: async ({ file, args }) => {
      if (file === 'npm') return { code: 1, stdout: '', stderr: '' };
      const command = args.join(' ');
      if (command === 'root --global') {
        return { code: 0, stdout: `${globalRoot}\n`, stderr: '' };
      }
      if (command === 'bin --global') {
        return { code: 0, stdout: `${globalBinDir}\n`, stderr: '' };
      }
      return { code: 0, stdout: 'undefined\n', stderr: '' };
    },
  });
  assert.equal(installation.manager, 'pnpm');
  assert.equal(installation.globalDir, globalDir);

  await assert.rejects(() => probeGlobalInstallation({
    packageRoot,
    cwd: root,
    environment: { PATH: process.env.PATH },
    run: async ({ file, args }) => {
      if (file === 'pnpm' && args.join(' ') === 'root --global') {
        return { code: 0, stdout: `${path.join(root, 'unknown-layout')}\n`, stderr: '' };
      }
      throw new Error('probe unavailable');
    },
  }), /unambiguous global npm or pnpm installation/u);
});

test('pnpm v11 global links resolve to a stable package root', async (t) => {
  const root = await temporaryRoot(t);
  const globalDir = path.join(root, 'pnpm/global');
  const layoutRoot = path.join(globalDir, 'v11');
  const linkedNodeModules = path.join(layoutRoot, 'stable-link/node_modules');
  const stored = path.join(
    root,
    'pnpm/store/v11/links/@/kin-tio/hash/content/node_modules/@kin-tio/cli',
  );
  const stable = path.join(linkedNodeModules, '@kin-tio/cli');
  const globalBinDir = path.join(root, 'pnpm/bin');
  await Promise.all([
    writeInstalledPackage(stored),
    fs.mkdir(path.dirname(stable), { recursive: true }),
    fs.mkdir(globalBinDir, { recursive: true }),
  ]);
  await fs.symlink(stored, stable, process.platform === 'win32' ? 'junction' : 'dir');
  const run = async ({ file, args }: {
    readonly file: string;
    readonly args: readonly string[];
  }) => {
    if (file === 'npm') return { code: 1, stdout: '', stderr: '' };
    const command = args.join(' ');
    if (command === 'root --global') {
      return { code: 0, stdout: `${layoutRoot}\n`, stderr: '' };
    }
    if (command === 'bin --global') {
      return { code: 0, stdout: `${globalBinDir}\n`, stderr: '' };
    }
    if (command === 'list --global --depth 0 --json') {
      return { code: 0, stdout: JSON.stringify([{ path: layoutRoot }]), stderr: '' };
    }
    return { code: 0, stdout: 'undefined\n', stderr: '' };
  };
  const installation = await probeGlobalInstallation({
    packageRoot: stored,
    cwd: root,
    environment: { PATH: process.env.PATH },
    run,
  });
  assert.equal(installation.manager, 'pnpm');
  assert.equal(installation.packageRoot, stable);
  assert.equal(installation.globalDir, globalDir);
  assert.equal(installation.globalBinDir, globalBinDir);

  const duplicate = path.join(layoutRoot, 'duplicate-link/node_modules/@kin-tio/cli');
  await fs.mkdir(path.dirname(duplicate), { recursive: true });
  await fs.symlink(stored, duplicate, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => probeGlobalInstallation({
    packageRoot: stored,
    cwd: root,
    environment: { PATH: process.env.PATH },
    run,
  }), /more than one stable package link/u);
});

test('prepared updates install one exact version and verify the stable package bin', async (t) => {
  const root = await temporaryRoot(t);
  const prefix = path.join(root, 'global');
  const packageRoot = path.join(prefix, 'lib/node_modules/@kin-tio/cli');
  await writeInstalledPackage(packageRoot);
  const prepared = await prepareKintioUpdate({
    packageRoot,
    currentVersion: '1.2.3',
    cwd: root,
    inheritedEnvironment: {
      PATH: process.env.PATH,
      HOME: root,
      WECOM_KF_SECRET: 'not-for-package-manager',
    },
    fetchLatest: async () => '1.3.0',
    probe: async () => ({
      manager: 'npm',
      prefix,
      packageRoot,
      realPackageRoot: packageRoot,
      binFile: path.join(packageRoot, 'bin/kintio.js'),
      realBinFile: path.join(packageRoot, 'bin/kintio.js'),
      version: '1.2.3',
    }),
  });
  assert.equal(prepared.kind, 'update');
  if (prepared.kind !== 'update') throw new Error('Expected a prepared update');
  assert.equal(prepared.environment.WECOM_KF_SECRET, undefined);
  assert.equal(prepared.command.args.at(-1), '@kin-tio/cli@1.3.0');

  let installed = false;
  await installPreparedKintioUpdate(prepared, async (request) => {
    installed = true;
    assert.equal(request.file, 'npm');
    assert.equal(request.args.includes('latest'), false);
    return 0;
  });
  assert.equal(installed, true);
  await verifyPreparedKintioUpdate(prepared, {
    run: async (request) => {
      assert.deepEqual(request.args, [path.join(packageRoot, 'bin/kintio.js'), '--version']);
      return { code: 0, stdout: '1.3.0\n', stderr: '' };
    },
  });

  await assert.rejects(() => verifyPreparedKintioUpdate(prepared, {
    run: async () => ({ code: 0, stdout: '1.2.3\n', stderr: '' }),
  }), /expected 1\.3\.0/u);
  await assert.rejects(
    () => installPreparedKintioUpdate(prepared, async () => 17),
    /npm update exited with code 17/u,
  );
  await assert.rejects(() => verifyPreparedKintioUpdate(prepared, {
    run: async () => ({ code: 9, stdout: '', stderr: 'broken' }),
  }), /version probe exited with code 9/u);
});

test('preparation treats an equal or older Registry target as already current', async (t) => {
  const root = await temporaryRoot(t);
  const prefix = path.join(root, 'global');
  const packageRoot = path.join(prefix, 'lib/node_modules/@kin-tio/cli');
  await writeInstalledPackage(packageRoot);
  const identity = {
    ...readInstalledPackageIdentity(packageRoot),
    manager: 'npm' as const,
    prefix,
  };
  for (const targetVersion of ['1.2.3', '1.2.2']) {
    const prepared = await prepareKintioUpdate({
      packageRoot,
      currentVersion: '1.2.3',
      cwd: root,
      inheritedEnvironment: { PATH: process.env.PATH },
      fetchLatest: async () => targetVersion,
      probe: async () => identity,
    });
    assert.equal(prepared.kind, 'current');
    assert.equal(prepared.targetVersion, targetVersion);
  }
});

test('preparation rejects a package-manager view of another installed version', async (t) => {
  const root = await temporaryRoot(t);
  const prefix = path.join(root, 'global');
  const packageRoot = path.join(prefix, 'lib/node_modules/@kin-tio/cli');
  await writeInstalledPackage(packageRoot);
  await assert.rejects(() => prepareKintioUpdate({
    packageRoot,
    currentVersion: '1.2.3',
    cwd: root,
    inheritedEnvironment: { PATH: process.env.PATH },
    probe: async () => ({
      manager: 'npm',
      prefix,
      packageRoot,
      realPackageRoot: packageRoot,
      binFile: path.join(packageRoot, 'bin/kintio.js'),
      realBinFile: path.join(packageRoot, 'bin/kintio.js'),
      version: '1.2.2',
    }),
  }), /differs from installed 1\.2\.2/u);
});
