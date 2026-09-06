import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'vitest';

import { buildReleasePlanFiles } from '../../.github/scripts/release-plan.ts';

const validator = path.resolve('.github/scripts/reconcile-release.ts');
const temporaryDirectories: string[] = [];

type CommandResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

function temporaryRepository(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-release-plan-'));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  cwd: string,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  return spawnSync(executable, args, { cwd, env, encoding: 'utf8' }) as CommandResult;
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(repository: string, file: string, source: string): void {
  const target = path.join(repository, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function fixture(): {
  baseSha: string;
  candidate: ReturnType<typeof buildReleasePlanFiles>;
  repository: string;
} {
  const repository = temporaryRepository();
  git(repository, 'init', '-b', 'master');
  git(repository, 'config', 'user.name', 'Kintio Test');
  git(repository, 'config', 'user.email', 'test@kintio.invalid');
  git(repository, 'config', 'core.autocrlf', 'false');

  const originalPackage = '{\n  "name": "@kin-tio/cli",\n  "version": "0.6.1",\n  "type": "module"\n}\n';
  const originalRuntime = "export const KINTIO_VERSION = '0.6.1';\n";
  const originalChangelog = '# Changelog\n\n## Unreleased\n\n## 0.6.1 - 2026-08-31\n\n- Previous.\n';
  write(repository, 'package.json', originalPackage);
  write(repository, 'src/version.ts', originalRuntime);
  write(repository, 'CHANGELOG.md', originalChangelog);
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'chore(release): prepare v0.6.1');
  git(repository, 'tag', '-a', 'v0.6.1', '-m', 'v0.6.1');

  const changedChangelog = originalChangelog.replace(
    '## Unreleased\n\n',
    '## Unreleased\n\n- Added a channel capability.\n\n',
  );
  write(repository, 'CHANGELOG.md', changedChangelog);
  git(repository, 'add', 'CHANGELOG.md');
  git(repository, 'commit', '-m', 'feat(channel): add a capability');
  const baseSha = git(repository, 'rev-parse', 'HEAD');
  const candidate = buildReleasePlanFiles({
    packageSource: originalPackage,
    runtimeSource: originalRuntime,
    changelogSource: changedChangelog,
    subjects: ['feat(channel): add a capability'],
  });
  write(repository, 'package.json', candidate.packageSource);
  write(repository, 'src/version.ts', candidate.runtimeSource);
  write(repository, 'CHANGELOG.md', candidate.changelogSource);
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'chore(release): prepare v0.7.0');
  return { baseSha, candidate, repository };
}

function verify(
  repository: string,
  baseSha: string,
  title = 'chore(release): prepare v0.7.0',
): CommandResult {
  return run(
    repository,
    process.execPath,
    ['--experimental-strip-types', validator, 'verify'],
    {
      ...process.env,
      BASE_SHA: baseSha,
      GITHUB_REPOSITORY: 'Gkxie/kintio',
      HEAD_REF: 'release/next',
      HEAD_REPOSITORY: 'Gkxie/kintio',
      PR_AUTHOR: 'kintio-release[bot]',
      PR_TITLE: title,
      RELEASE_BOT_LOGIN: 'kintio-release[bot]',
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Release plan check', () => {
  test('revalidates corrected PR metadata without changing the candidate commit', () => {
    const workflow = fs.readFileSync('.github/workflows/release-plan.yml', 'utf8')
      .replaceAll('\r\n', '\n');
    assert.match(
      workflow,
      /^  pull_request:\n    branches: \[master\]\n    types: \[opened, synchronize, reopened, edited\]$/mu,
    );
    assert.match(
      workflow,
      /^concurrency:\n  group: release-plan-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true$/mu,
    );

    const { baseSha, repository } = fixture();
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const stale = verify(repository, baseSha, 'chore(release): prepare v0.6.2');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Release PR title must be chore\(release\): prepare v0\.7\.0/u);

    const corrected = verify(repository, baseSha);
    assert.equal(corrected.status, 0, corrected.stderr || corrected.stdout);
    assert.equal(git(repository, 'rev-parse', 'HEAD'), headSha);
    assert.equal(git(repository, 'status', '--porcelain'), '');
  });

  test('accepts the exact deterministic three-file candidate', () => {
    const { baseSha, repository } = fixture();
    const result = verify(repository, baseSha);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test('rejects a candidate that changes package behavior with the version', () => {
    const { baseSha, candidate, repository } = fixture();
    const packageJson = JSON.parse(candidate.packageSource) as Record<string, unknown>;
    packageJson.scripts = { preinstall: 'node unexpected.js' };
    write(repository, 'package.json', `${JSON.stringify(packageJson, undefined, 2)}\n`);
    git(repository, 'add', 'package.json');
    git(repository, 'commit', '--amend', '--no-edit');

    const result = verify(repository, baseSha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package\.json differs from the deterministic Release plan/u);
  });

  test('rejects a generated commit that carries any fourth file', () => {
    const { baseSha, repository } = fixture();
    write(repository, 'unexpected.txt', 'not part of a Release PR\n');
    git(repository, 'add', 'unexpected.txt');
    git(repository, 'commit', '--amend', '--no-edit');

    const result = verify(repository, baseSha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed files outside the deterministic plan/u);
  });

});
