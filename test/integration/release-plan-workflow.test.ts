import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, test } from 'vitest';

import { buildReleasePlanFiles } from '../../.github/scripts/release-plan.ts';

const validator = path.resolve('.github/scripts/reconcile-release.ts');
const temporaryDirectories: string[] = [];

function releaseEvent(action: string, title = 'chore(release): prepare v0.7.0') {
  return {
    repository: 'Gkxie/kintio',
    event_name: 'pull_request_target',
    actor: 'kintio-release[bot]',
    triggering_actor: 'kintio-release[bot]',
    run_attempt: 1,
    run_id: 1,
    event: {
      action,
      changes: {} as Record<string, { from: string }>,
      pull_request: {
        number: 50,
        draft: false,
        title,
        user: { login: 'kintio-release[bot]' },
        base: { ref: 'master', repo: { full_name: 'Gkxie/kintio' } },
        head: { ref: 'release/next', repo: { full_name: 'Gkxie/kintio' } },
      },
    },
  };
}

function releaseWorkflow(github: ReturnType<typeof releaseEvent>) {
  const workflow = fs.readFileSync('.github/workflows/release-codex.yml', 'utf8')
    .replaceAll('\r\n', '\n');
  const events = /^    types: \[([^\]]+)\]$/mu.exec(workflow)?.[1]?.split(', ');
  const condition = /^    if: >-\n([\s\S]+?)(?=^    runs-on:)/mu.exec(workflow)?.[1];
  const group = /^  group: (.+)$/mu.exec(workflow)?.[1];
  const command = /reconcile-release\.ts (verify(?:-source)?)$/mu.exec(workflow)?.[1];
  assert.ok(events && condition && group, 'Release workflow must declare its event gate and concurrency');
  assert.ok(command === 'verify' || command === 'verify-source');
  // The checked-in gate uses only property reads, boolean/equality operators,
  // and literals, which have the same semantics here as in Actions expressions.
  const evaluate = (expression: string) => runInNewContext(expression, { github }) as unknown;
  return {
    triggered: events.includes(github.event.action),
    eligible: events.includes(github.event.action) && Boolean(evaluate(condition)),
    group: group.replace(/\$\{\{(.+?)\}\}/gu, (_match, expression: string) => String(evaluate(expression))),
    command,
  } as const;
}

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
  command: 'verify' | 'verify-source' = 'verify',
  environment: NodeJS.ProcessEnv = {},
): CommandResult {
  return run(
    repository,
    process.execPath,
    ['--experimental-strip-types', validator, command],
    {
      ...process.env,
      BASE_SHA: baseSha,
      GITHUB_REPOSITORY: 'Gkxie/kintio',
      HEAD_REF: 'release/next',
      HEAD_REPOSITORY: 'Gkxie/kintio',
      PR_AUTHOR: 'kintio-release[bot]',
      PR_TITLE: title,
      RELEASE_BOT_LOGIN: 'kintio-release[bot]',
      ...environment,
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

  test.each(['verify', 'verify-source'] as const)('%s accepts the exact deterministic three-file candidate', (command) => {
    const { baseSha, repository } = fixture();
    const result = verify(repository, baseSha, undefined, command);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test.each(['verify', 'verify-source'] as const)('%s rejects a candidate that changes package behavior with the version', (command) => {
    const { baseSha, candidate, repository } = fixture();
    const packageJson = JSON.parse(candidate.packageSource) as Record<string, unknown>;
    packageJson.scripts = { preinstall: 'node unexpected.js' };
    write(repository, 'package.json', `${JSON.stringify(packageJson, undefined, 2)}\n`);
    git(repository, 'add', 'package.json');
    git(repository, 'commit', '--amend', '--no-edit');

    const result = verify(repository, baseSha, undefined, command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package\.json differs from the deterministic Release plan/u);
  });

  test.each(['verify', 'verify-source'] as const)('%s rejects a generated commit that carries any fourth file', (command) => {
    const { baseSha, repository } = fixture();
    write(repository, 'unexpected.txt', 'not part of a Release PR\n');
    git(repository, 'add', 'unexpected.txt');
    git(repository, 'commit', '--amend', '--no-edit');

    const result = verify(repository, baseSha, undefined, command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed files outside the deterministic plan/u);
  });

});

describe('Release Codex event eligibility', () => {
  test('source validation does not depend on title update order; Release plan still requires the corrected title', () => {
    const { baseSha, repository } = fixture();
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const synchronized = releaseEvent('synchronize', 'chore(release): prepare v0.6.2');
    assert.equal(releaseWorkflow(synchronized).eligible, true);
    assert.notEqual(verify(repository, baseSha, synchronized.event.pull_request.title).status, 0);
    const source = verify(repository, baseSha, synchronized.event.pull_request.title, releaseWorkflow(synchronized).command);
    assert.equal(source.status, 0, source.stderr || source.stdout);

    const corrected = releaseEvent('edited');
    corrected.run_id = 2;
    corrected.event.changes.title = { from: synchronized.event.pull_request.title };
    assert.equal(releaseWorkflow(corrected).triggered, false);
    const result = verify(repository, baseSha, corrected.event.pull_request.title);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git(repository, 'rev-parse', 'HEAD'), headSha);
    assert.equal(git(repository, 'status', '--porcelain'), '');
  });

  test('a force push followed by body and title edits creates only one Codex workflow, not skipped duplicate checks', () => {
    const synchronized = releaseEvent('synchronize');
    const metadataEdits = ['body', 'title'].map((field, index) => {
      const event = releaseEvent('edited');
      event.run_id = index + 2;
      event.event.changes[field] = { from: 'Previous metadata' };
      return event;
    });
    const runs = [synchronized, ...metadataEdits].filter((event) => releaseWorkflow(event).triggered);
    assert.deepEqual(runs, [synchronized]);
    assert.equal(releaseWorkflow(runs[0]!).eligible, true);
  });

  test.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])('%s automatically validates the trusted candidate', (action) => {
    assert.equal(releaseWorkflow(releaseEvent(action)).eligible, true);
  });

  test('new source updates replace the preceding candidate approval, regardless of metadata', () => {
    const previous = releaseEvent('synchronize');
    const next = releaseEvent('synchronize', 'chore(release): prepare v0.8.0');
    next.run_id = 2;
    assert.equal(releaseWorkflow(next).eligible, true);
    assert.equal(releaseWorkflow(next).group, releaseWorkflow(previous).group);
  });

  test.each([
    ['draft', (event: ReturnType<typeof releaseEvent>) => { event.event.pull_request.draft = true; }],
    ['fork', (event: ReturnType<typeof releaseEvent>) => { event.event.pull_request.head.repo.full_name = 'elsewhere/kintio'; }],
    ['wrong author', (event: ReturnType<typeof releaseEvent>) => { event.event.pull_request.user.login = 'Gkxie'; }],
    ['wrong branch', (event: ReturnType<typeof releaseEvent>) => { event.event.pull_request.head.ref = 'feature/release'; }],
    ['wrong base', (event: ReturnType<typeof releaseEvent>) => { event.event.pull_request.base.ref = 'other'; }],
    ['untrusted actor', (event: ReturnType<typeof releaseEvent>) => { event.actor = 'other'; }],
    ['different triggering actor', (event: ReturnType<typeof releaseEvent>) => { event.triggering_actor = 'Gkxie'; }],
    ['rerun', (event: ReturnType<typeof releaseEvent>) => { event.run_attempt = 2; }],
  ])('source updates remain ineligible for %s', (_reason, mutate) => {
    const event = releaseEvent('synchronize');
    mutate(event);
    assert.equal(releaseWorkflow(event).eligible, false);
  });

  test.each(['verify', 'verify-source'] as const)('%s rejects a candidate based on stale master even for an owner-triggered update', (command) => {
    const { baseSha, repository } = fixture();
    const event = releaseEvent('synchronize');
    event.actor = 'Gkxie';
    event.triggering_actor = 'Gkxie';
    assert.equal(releaseWorkflow(event).eligible, true);
    git(repository, 'checkout', '-b', 'updated-master', baseSha);
    git(repository, 'commit', '--allow-empty', '-m', 'docs: update master');
    const updatedBase = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', 'master');
    const result = verify(repository, updatedBase, event.event.pull_request.title, command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must directly follow current master/u);
  });

  test.each([
    { PR_AUTHOR: 'other' },
    { HEAD_REPOSITORY: 'elsewhere/kintio' },
    { RELEASE_BOT_LOGIN: 'other' },
    { HEAD_REF: 'feature/other' },
  ])('source-only verification rejects an untrusted candidate identity: %j', (environment) => {
    const { baseSha, repository } = fixture();
    assert.notEqual(verify(repository, baseSha, undefined, 'verify-source', environment).status, 0);
  });
});
