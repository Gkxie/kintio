import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

type Boundary = 'release-pr' | 'release';
type Fixture = {
  packageSource: string;
  runtimeSource: string;
  changelog: string;
  files: { filename: string; status: string }[];
};

function verify(t: TestContext, boundary: Boundary, change: (fixture: Fixture) => void = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-release-boundary-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = (version: string) => JSON.stringify({ name: '@kin-tio/cli', version, type: 'module' });
  const runtime = (version: string) => `export const KINTIO_VERSION = '${version}';\n`;
  const fixture: Fixture = {
    packageSource: manifest('0.6.2'),
    runtimeSource: runtime('0.6.2'),
    changelog: '# Changelog\n\n## Unreleased\n\n## 0.6.2\n\n- Current release.\n\n## 0.6.1\n\n- Previously published.\n',
    files: ['CHANGELOG.md', 'package.json', 'src/version.ts'].map((filename) => ({ filename, status: 'modified' })),
  };
  change(fixture);
  fs.mkdirSync(path.join(directory, 'src'));
  fs.mkdirSync(path.join(directory, '.github', 'scripts'), { recursive: true });
  fs.copyFileSync('.github/scripts/release-plan.ts', path.join(directory, '.github', 'scripts', 'release-plan.ts'));
  fs.writeFileSync(path.join(directory, 'package.json'), fixture.packageSource);
  fs.writeFileSync(path.join(directory, 'src', 'version.ts'), fixture.runtimeSource);
  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), fixture.changelog);
  fs.writeFileSync(path.join(directory, 'version-tags.txt'), 'v0.6.1\nv0.6.2\n');

  const sha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const repository = 'fixture-owner/kintio';
  const pull = {
    number: 42, merged: true, merged_at: '2026-09-06T00:00:00Z',
    user: { login: 'kintio-release[bot]' },
    merged_by: { login: 'fixture-owner' },
    base: { ref: 'master', sha: baseSha },
    head: { ref: 'release/next', repo: { full_name: repository } },
    merge_commit_sha: sha,
    title: 'chore(release): prepare v0.6.2',
    changed_files: fixture.files.length,
  };
  const contents = {
    current: {
      'package.json': fixture.packageSource,
      'src/version.ts': fixture.runtimeSource,
      'CHANGELOG.md': fixture.changelog,
    },
    base: { 'package.json': manifest('0.6.1'), 'src/version.ts': runtime('0.6.1') },
  };
  const workflow = fs.readFileSync(`.github/workflows/${boundary}.yml`, 'utf8');
  const module = /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/u.exec(workflow)?.[1];
  assert.ok(module, `missing ${boundary} validation module`);
  const bootstrap = `
    const fixture = ${JSON.stringify({ files: fixture.files, pull, contents, repository, sha, baseSha })};
    globalThis.fetch = async (input, options = {}) => {
      if (options.method && options.method !== 'GET') throw new Error('Test refused an external write');
      const url = new URL(input);
      if (url.origin !== 'https://api.github.com') throw new Error('Test refused an external host');
      const route = url.pathname.replace('/repos/' + fixture.repository, '');
      let result;
      if (route === '/pulls/42') result = fixture.pull;
      else if (route === '/pulls/42/files') result = fixture.files;
      else if (route === '/commits/' + fixture.sha + '/pulls') result = [fixture.pull];
      else if (route.startsWith('/contents/')) {
        const sources = url.searchParams.get('ref') === fixture.baseSha ? fixture.contents.base : fixture.contents.current;
        const source = sources[route.slice('/contents/'.length)];
        if (source === undefined) throw new Error('Unknown fixture file');
        result = { type: 'file', content: Buffer.from(source).toString('base64') };
      } else if (route === '/git/matching-refs/tags/v') result = [{ ref: 'refs/tags/v0.6.1' }];
      else if (route === '/git/ref/tags/v0.6.2') result = { object: { type: 'tag', sha: 'existing-tag' } };
      else if (route === '/git/tags/existing-tag') result = { object: { type: 'commit', sha: fixture.sha } };
      else if (route === '/releases') result = [{ tag_name: 'v0.6.1', draft: false, prerelease: false }];
      else if (route === '/actions/workflows/release.yml/runs') result = {
        workflow_runs: [{ head_sha: fixture.sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture-owner/kintio/actions/runs/1' }],
      };
      else throw new Error('Unexpected fixture request: ' + route);
      return { ok: true, status: 200, json: async () => result };
    };
  `;
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    input: bootstrap + module.split('\n').map((line) => line.replace(/^ {10}/u, '')).join('\n'),
    env: {
      ...process.env,
      GH_TOKEN: 'synthetic-no-network-token',
      GITHUB_OUTPUT: path.join(directory, 'outputs'),
      RUNNER_TEMP: directory,
      GITHUB_REPOSITORY: repository,
      REPOSITORY: repository,
      REPOSITORY_OWNER: 'fixture-owner',
      RELEASE_BOT_LOGIN: 'kintio-release[bot]',
      RELEASE_TAG: 'v0.6.2',
      EVENT_SHA: sha,
      MERGE_SHA: sha,
      PR_NUMBER: '42',
      PR_TITLE: pull.title,
      HEAD_REF: pull.head.ref,
    },
  });
  return { result, directory };
}

for (const boundary of ['release-pr', 'release'] as const) {
  test(`${boundary} executes shared validation from its checked-out source with synthetic GitHub results`, (t) => {
    const { result, directory } = verify(t, boundary);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(fs.readFileSync(path.join(directory, 'outputs'), 'utf8'), /version=0\.6\.2/u);
    if (boundary === 'release') {
      assert.equal(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), '- Current release.\n');
    }
  });

  test(`${boundary} rejects package behavior changes before any publication operation`, (t) => {
    const { result } = verify(t, boundary, (fixture) => {
      fixture.packageSource = JSON.stringify({ ...JSON.parse(fixture.packageSource), scripts: { postinstall: 'unexpected' } });
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /beyond its version/u);
  });

  test(`${boundary} rejects a Release PR carrying unrelated code`, (t) => {
    const { result } = verify(t, boundary, (fixture) => {
      fixture.files.push({ filename: 'src/cli.ts', status: 'modified' });
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release PR changed src\/cli.ts/u);
  });
}

test('frozen authorization rejects nonempty Unreleased while publication excludes it from notes', (t) => {
  const change = (fixture: Fixture) => {
    fixture.changelog = fixture.changelog.replace('## Unreleased\n', '## Unreleased\n\n- Future work.');
  };
  const frozen = verify(t, 'release-pr', change);
  assert.notEqual(frozen.result.status, 0);
  assert.match(frozen.result.stderr, /empty Unreleased/u);
  const published = verify(t, 'release', change);
  assert.equal(published.result.status, 0, published.result.stderr);
  assert.equal(fs.readFileSync(path.join(published.directory, 'release-notes.md'), 'utf8'), '- Current release.\n');
});
