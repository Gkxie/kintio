import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { test } from 'vitest';

import {
  assertExactStableVersion,
  detectGlobalInstallation,
  detectGlobalInstallationFromIdentity,
  planGlobalInstall,
  readInstalledPackageIdentity,
  type InstalledPackageIdentity,
} from '../../src/update/global-install.ts';

async function temporaryRoot(t: TestContext, name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writePackage(packageRoot: string, version = '1.2.3'): Promise<void> {
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

function npmPackageRoot(prefix: string): string {
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules/@kin-tio/cli')
    : path.join(prefix, 'lib/node_modules/@kin-tio/cli');
}

function windowsIdentity(
  packageRoot: string,
  realPackageRoot = packageRoot,
): InstalledPackageIdentity {
  const binFile = path.win32.join(packageRoot, 'bin/kintio.js');
  return {
    packageRoot,
    realPackageRoot,
    binFile,
    realBinFile: path.win32.join(realPackageRoot, 'bin/kintio.js'),
    version: '1.2.3',
  };
}

function windowsCanonical(aliases: ReadonlyMap<string, string>) {
  return (value: string): string => {
    const normalized = path.win32.normalize(value).toLowerCase();
    return aliases.get(normalized) || normalized;
  };
}

const virtualPathPolicy = {
  pathIsDirectory: () => true,
  pathIsFile: () => true,
  pathIsSymbolicLink: () => false,
} as const;

test('reads only the published Kintio package identity and stable bin', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-identity-');
  const packageRoot = path.join(root, 'package with spaces');
  await writePackage(packageRoot);

  const identity = readInstalledPackageIdentity(packageRoot);
  assert.equal(identity.packageRoot, packageRoot);
  assert.equal(identity.binFile, path.join(packageRoot, 'bin/kintio.js'));
  assert.equal(identity.version, '1.2.3');
  assert.equal(identity.realPackageRoot, await fs.realpath(packageRoot));

  await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'not-kintio',
    version: '1.2.3',
    bin: { kintio: 'bin/kintio.js' },
  })}\n`);
  assert.throws(
    () => readInstalledPackageIdentity(packageRoot),
    /package identity is invalid/u,
  );
});

test('rejects missing, redirected, oversized, or malformed package metadata', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-invalid-package-');
  assert.throws(
    () => readInstalledPackageIdentity('relative/package'),
    /package root must be an absolute path/u,
  );
  assert.throws(
    () => readInstalledPackageIdentity(path.join(root, 'missing')),
    /package root is missing/u,
  );

  const fileRoot = path.join(root, 'not-a-directory');
  await fs.writeFile(fileRoot, 'file');
  assert.throws(
    () => readInstalledPackageIdentity(fileRoot),
    /package root must be a directory/u,
  );

  const missingManifest = path.join(root, 'missing-manifest');
  await fs.mkdir(missingManifest);
  assert.throws(
    () => readInstalledPackageIdentity(missingManifest),
    /package manifest is missing/u,
  );

  const invalidManifest = path.join(root, 'invalid-manifest');
  await fs.mkdir(invalidManifest);
  await fs.writeFile(path.join(invalidManifest, 'package.json'), '{');
  assert.throws(
    () => readInstalledPackageIdentity(invalidManifest),
    /package manifest is invalid/u,
  );

  const oversizedManifest = path.join(root, 'oversized-manifest');
  await fs.mkdir(oversizedManifest);
  await fs.writeFile(path.join(oversizedManifest, 'package.json'), 'x'.repeat(64 * 1024 + 1));
  assert.throws(
    () => readInstalledPackageIdentity(oversizedManifest),
    /package manifest exceeds 65536 bytes/u,
  );

  const missingVersion = path.join(root, 'missing-version');
  await fs.mkdir(missingVersion);
  await fs.writeFile(path.join(missingVersion, 'package.json'), JSON.stringify({
    name: '@kin-tio/cli',
    bin: { kintio: 'bin/kintio.js' },
  }));
  assert.throws(
    () => readInstalledPackageIdentity(missingVersion),
    /package version is missing/u,
  );

  const wrongBin = path.join(root, 'wrong-bin');
  await fs.mkdir(wrongBin);
  await fs.writeFile(path.join(wrongBin, 'package.json'), JSON.stringify({
    name: '@kin-tio/cli',
    version: '1.2.3',
    bin: { kintio: '../outside.js' },
  }));
  assert.throws(
    () => readInstalledPackageIdentity(wrongBin),
    /package bin must be bin\/kintio\.js/u,
  );

  const linkedBin = path.join(root, 'linked-bin');
  await writePackage(linkedBin);
  const outsideBin = path.join(root, 'outside.js');
  await fs.writeFile(outsideBin, '');
  await fs.rm(path.join(linkedBin, 'bin/kintio.js'));
  await fs.symlink(outsideBin, path.join(linkedBin, 'bin/kintio.js'), 'file');
  assert.throws(
    () => readInstalledPackageIdentity(linkedBin),
    /package bin must be a regular file/u,
  );
});

test('detects an npm-owned installation and pins its spaced prefix', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-npm-');
  const prefix = path.join(root, 'Node Prefix With Spaces');
  const packageRoot = npmPackageRoot(prefix);
  await writePackage(packageRoot);

  const installation = detectGlobalInstallation({
    packageRoot,
    npm: { prefix },
  });
  assert.deepEqual(installation, {
    ...readInstalledPackageIdentity(packageRoot),
    manager: 'npm',
    prefix,
  });
  const command = planGlobalInstall(installation, '2.4.6');
  assert.deepEqual(command, {
    file: 'npm',
    args: [
      'install', '--global',
      '--prefix', prefix,
      '--registry', 'https://registry.npmjs.org/',
      '--ignore-scripts',
      '@kin-tio/cli@2.4.6',
    ],
  });
  assert.equal('shell' in command, false);
  assert.equal(command.args.includes(prefix), true);
});

test('rejects npm links and package-manager probes that do not own the package', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-link-');
  const source = path.join(root, 'source');
  const prefix = path.join(root, 'global');
  const linked = npmPackageRoot(prefix);
  await writePackage(source);
  await fs.mkdir(path.dirname(linked), { recursive: true });
  await fs.symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => detectGlobalInstallation({ packageRoot: source, npm: { prefix } }),
    /unambiguous global npm or pnpm installation/u,
  );
  assert.throws(
    () => detectGlobalInstallation({
      packageRoot: source,
      npm: { prefix: path.join(root, 'another-prefix') },
    }),
    /unambiguous global npm or pnpm installation/u,
  );
});

test('detects pnpm through its stable global link, not its versioned store path', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-pnpm-');
  const globalDir = path.join(root, 'pnpm global with spaces');
  const globalRoot = path.join(globalDir, '5/node_modules');
  const globalBinDir = path.join(root, 'pnpm bin with spaces');
  const stored = path.join(
    globalDir,
    '5/node_modules/.pnpm/@kin-tio+cli@1.2.3/node_modules/@kin-tio/cli',
  );
  const stable = path.join(globalRoot, '@kin-tio/cli');
  await Promise.all([
    writePackage(stored),
    fs.mkdir(path.dirname(stable), { recursive: true }),
    fs.mkdir(globalBinDir, { recursive: true }),
  ]);
  await fs.symlink(
    stored,
    stable,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const installation = detectGlobalInstallation({
    packageRoot: stored,
    pnpm: { root: globalRoot, globalDir, globalBinDir },
  });
  assert.equal(installation.manager, 'pnpm');
  assert.equal(installation.packageRoot, stable);
  assert.equal(installation.binFile, path.join(stable, 'bin/kintio.js'));
  assert.equal(installation.realPackageRoot, await fs.realpath(stored));
  assert.deepEqual(planGlobalInstall(installation, '3.0.1'), {
    file: 'pnpm',
    args: [
      'add', '--global',
      '--global-dir', globalDir,
      '--global-bin-dir', globalBinDir,
      '--registry', 'https://registry.npmjs.org/',
      '--ignore-scripts',
      '@kin-tio/cli@3.0.1',
    ],
  });
});

test('fails closed for a pnpm root outside its declared global directory', async (t) => {
  const root = await temporaryRoot(t, 'kintio-global-pnpm-mismatch-');
  const globalDir = path.join(root, 'global');
  const globalRoot = path.join(root, 'other/5/node_modules');
  const packageRoot = path.join(globalRoot, '@kin-tio/cli');
  const globalBinDir = path.join(root, 'bin');
  await Promise.all([
    writePackage(packageRoot),
    fs.mkdir(globalDir, { recursive: true }),
    fs.mkdir(globalBinDir, { recursive: true }),
  ]);

  assert.throws(
    () => detectGlobalInstallation({
      packageRoot,
      pnpm: { root: globalRoot, globalDir, globalBinDir },
    }),
    /unambiguous global npm or pnpm installation/u,
  );
});

test('classifies npm and pnpm Windows paths case-insensitively', () => {
  const npmPrefix = 'C:\\Users\\Ada Example\\AppData\\Roaming\\npm';
  const npmRoot = path.win32.join(
    npmPrefix,
    'node_modules/@kin-tio/cli',
  );
  const npmIdentity = windowsIdentity(npmRoot.toUpperCase());
  const npm = detectGlobalInstallationFromIdentity({
    identity: npmIdentity,
    npm: { prefix: npmPrefix },
    platform: 'win32',
    canonicalize: windowsCanonical(new Map()),
    ...virtualPathPolicy,
  });
  assert.equal(npm.manager, 'npm');
  assert.equal(npm.packageRoot, npmRoot);
  assert.equal(npm.binFile, path.win32.join(npmRoot, 'bin/kintio.js'));

  const globalDir = 'C:\\Users\\Ada Example\\AppData\\Local\\pnpm\\global';
  const globalRoot = path.win32.join(globalDir, '5/node_modules');
  const stableRoot = path.win32.join(globalRoot, '@kin-tio/cli');
  const storedRoot = path.win32.join(
    globalRoot,
    '.pnpm/@kin-tio+cli@1.2.3/node_modules/@kin-tio/cli',
  );
  const aliases = new Map<string, string>([
    [stableRoot.toLowerCase(), storedRoot.toLowerCase()],
    [
      path.win32.join(stableRoot, 'bin/kintio.js').toLowerCase(),
      path.win32.join(storedRoot, 'bin/kintio.js').toLowerCase(),
    ],
  ]);
  const pnpm = detectGlobalInstallationFromIdentity({
    identity: windowsIdentity(storedRoot),
    pnpm: {
      root: globalRoot,
      globalDir,
      globalBinDir: 'C:\\Users\\Ada Example\\AppData\\Local\\pnpm',
    },
    platform: 'win32',
    canonicalize: windowsCanonical(aliases),
    ...virtualPathPolicy,
  });
  assert.equal(pnpm.manager, 'pnpm');
  assert.equal(pnpm.packageRoot, stableRoot);
  assert.equal(
    pnpm.binFile,
    path.win32.join(stableRoot, 'bin/kintio.js'),
  );
});

test('rejects ambiguous ownership, relative probes, and non-exact versions', () => {
  const prefix = '/opt/kintio';
  const packageRoot = '/opt/kintio/lib/node_modules/@kin-tio/cli';
  const identity: InstalledPackageIdentity = {
    packageRoot,
    realPackageRoot: packageRoot,
    binFile: `${packageRoot}/bin/kintio.js`,
    realBinFile: `${packageRoot}/bin/kintio.js`,
    version: '1.2.3',
  };
  assert.throws(
    () => detectGlobalInstallationFromIdentity({
      identity,
      npm: { prefix },
      pnpm: {
        root: '/opt/kintio/lib/node_modules',
        globalDir: '/opt/kintio',
        globalBinDir: '/opt/kintio/bin',
      },
      platform: 'linux',
      canonicalize: (value) => value,
      ...virtualPathPolicy,
    }),
    /ownership is ambiguous/u,
  );
  assert.throws(
    () => detectGlobalInstallationFromIdentity({
      identity,
      npm: { prefix: 'relative' },
      platform: 'linux',
      canonicalize: (value) => value,
      ...virtualPathPolicy,
    }),
    /npm global prefix must be an absolute path/u,
  );
  for (const version of ['latest', '1.2', '01.2.3', '1.2.3-beta.1', '1.2.3;echo']) {
    assert.throws(() => assertExactStableVersion(version), /exact stable X\.Y\.Z/u);
  }
  assert.equal(assertExactStableVersion('0.7.2'), '0.7.2');
});

test('rejects a pnpm probe with two logical package aliases', () => {
  const root = '/pnpm/global/5';
  const first = `${root}/@kin-tio/cli`;
  const second = `${root}/node_modules/@kin-tio/cli`;
  const real = '/pnpm/store/@kin-tio/cli';
  const realBin = `${real}/bin/kintio.js`;
  const aliases = new Map([
    [first, real],
    [`${first}/bin/kintio.js`, realBin],
    [second, real],
    [`${second}/bin/kintio.js`, realBin],
  ]);
  assert.throws(
    () => detectGlobalInstallationFromIdentity({
      identity: {
        packageRoot: real,
        realPackageRoot: real,
        binFile: realBin,
        realBinFile: realBin,
        version: '1.2.3',
      },
      pnpm: {
        root,
        globalDir: '/pnpm/global',
        globalBinDir: '/pnpm/bin',
      },
      platform: 'linux',
      canonicalize: (value) => aliases.get(value) || value,
      ...virtualPathPolicy,
    }),
    /more than one matching package root/u,
  );
});
