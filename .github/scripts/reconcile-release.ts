import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { buildReleasePlanFiles } from './release-plan.ts';

const RELEASE_BRANCH = 'release/next';
const RELEASE_BOT_LOGIN = 'kintio-release[bot]';

type CandidatePlan = {
  body: string;
  files: Record<'CHANGELOG.md' | 'package.json' | 'src/version.ts', string>;
  status: 'candidate';
  title: string;
  version: string;
};

type IdlePlan = {
  reason: string;
  status: 'no-change' | 'release-pending';
};

type ReleasePlan = CandidatePlan | IdlePlan;

function git(args: string[], trim = true): string {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function semver(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compareVersion(left: string, right: string): number {
  const a = semver(left);
  const b = semver(right);
  if (!a || !b) throw new Error(`cannot compare ${left} and ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function latestVersionTag(): string {
  const tags = git(['tag', '--list'])
    .split(/\r?\n/u)
    .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag));
  tags.sort((left, right) => compareVersion(right, left));
  const tag = tags[0];
  if (!tag) throw new Error('the repository has no stable release tag');
  if (git(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    throw new Error(`${tag} must be an annotated tag`);
  }
  return tag;
}

function currentPackageVersion(source: string): string {
  const value = JSON.parse(source) as { name?: string; version?: string };
  if (value.name !== '@kin-tio/cli' || !semver(value.version || '')) {
    throw new Error('package.json is not a stable Kintio release package');
  }
  return value.version || '';
}

function unreleasedState(source: string): { body?: string } {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const headings = lines.reduce<number[]>(
    (indexes, line, index) => line === '## Unreleased'
      ? [...indexes, index]
      : indexes,
    [],
  );
  if (headings.length !== 1) {
    throw new Error('CHANGELOG.md requires exactly one Unreleased section');
  }
  const end = lines.findIndex(
    (line, index) => index > headings[0]! && line.startsWith('## '),
  );
  const body = lines.slice(headings[0]! + 1, end < 0 ? lines.length : end)
    .join('\n')
    .trim();
  return body ? { body } : {};
}

function releaseBody(plan: {
  baseTag: string;
  subjects: string[];
  version: string;
}): string {
  const changes = plan.subjects.length > 0
    ? plan.subjects.map((subject) => `- ${subject}`).join('\n')
    : '- The reviewed Unreleased section defines this candidate.';
  return `## Why

Freeze the reviewed Unreleased changes as \`${plan.version}\`. This pull request
is maintained deterministically from trusted \`master\`; do not edit its branch.

## Release decision

- Previous release: \`${plan.baseTag}\`
- Candidate: \`v${plan.version}\`
- Included commits:
${changes}

## Verification

All normal required checks run on every bot update. The Release plan check also
regenerates these three files from the pull request base and compares them byte
for byte.

## Authorization

Only the repository owner's Squash Merge authorizes the annotated Tag, npm OIDC
publication, provenance verification, Registry smoke test, and GitHub Release.
The preparation bot cannot perform any of those operations.
`;
}

async function writeOutputs(values: Record<string, string>): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await fs.appendFile(
    output,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
}

async function githubGet<T>(route: string, allow404 = false): Promise<T | undefined> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error('GitHub repository and token are required');
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kintio-release-preparation',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (allow404 && response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET ${route} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function buildPlan(): Promise<ReleasePlan> {
  const [packageSource, runtimeSource, changelogSource] = await Promise.all([
    fs.readFile('package.json', 'utf8'),
    fs.readFile('src/version.ts', 'utf8'),
    fs.readFile('CHANGELOG.md', 'utf8'),
  ]);
  const baseSha = git(['rev-parse', 'HEAD']);
  const baseTag = latestVersionTag();
  if (!gitSucceeds(['merge-base', '--is-ancestor', baseTag, baseSha])) {
    throw new Error(`${baseTag} is not an ancestor of master`);
  }
  const tagVersion = baseTag.slice(1);
  const packageVersion = currentPackageVersion(packageSource);
  const { body: unreleased } = unreleasedState(changelogSource);

  if (packageVersion !== tagVersion) {
    if (compareVersion(packageVersion, tagVersion) > 0) {
      return {
        status: 'release-pending',
        reason: `${packageVersion} is merged but its Tag or Release is still converging`,
      };
    }
    throw new Error(`package version ${packageVersion} differs from ${baseTag}`);
  }

  const published = await githubGet<{ draft?: boolean; prerelease?: boolean }>(
    `/releases/tags/${encodeURIComponent(baseTag)}`,
    true,
  );
  if (!published || published.draft || published.prerelease) {
    return {
      status: 'release-pending',
      reason: `${baseTag} does not have a published stable GitHub Release`,
    };
  }
  if (!unreleased) return { status: 'no-change', reason: 'Unreleased is empty' };

  const subjects = git(['log', '--format=%s', `${baseTag}..${baseSha}`])
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((subject) => !/^chore\(release\):/u.test(subject));
  const files = buildReleasePlanFiles({
    packageSource,
    runtimeSource,
    changelogSource,
    subjects,
  });
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/tags/v${files.version}`])) {
    throw new Error(`v${files.version} already exists`);
  }
  return {
    status: 'candidate',
    version: files.version,
    title: `chore(release): prepare v${files.version}`,
    body: releaseBody({ baseTag, subjects, version: files.version }),
    files: {
      'CHANGELOG.md': files.changelogSource,
      'package.json': files.packageSource,
      'src/version.ts': files.runtimeSource,
    },
  };
}

async function prepareCandidate(bodyFile: string): Promise<void> {
  const plan = await buildPlan();
  if (plan.status !== 'candidate') {
    await writeOutputs({ status: plan.status });
    console.log(`${plan.status}: ${plan.reason}`);
    return;
  }
  await Promise.all([
    ...Object.entries(plan.files).map(([file, source]) => fs.writeFile(file, source)),
    fs.writeFile(bodyFile, plan.body, { mode: 0o600 }),
  ]);
  await writeOutputs({
    status: plan.status,
    title: plan.title,
    version: plan.version,
  });
  console.log(`candidate: ${plan.version}`);
}

function readAt(ref: string, file: string): string {
  return git(['show', `${ref}:${file}`], false);
}

async function verifyCandidate(): Promise<void> {
  if (process.env.HEAD_REF !== RELEASE_BRANCH) {
    console.log('Ordinary pull request; no Release plan to validate.');
    return;
  }
  if (
    process.env.PR_AUTHOR !== RELEASE_BOT_LOGIN
    || process.env.RELEASE_BOT_LOGIN !== RELEASE_BOT_LOGIN
    || process.env.HEAD_REPOSITORY !== process.env.GITHUB_REPOSITORY
  ) {
    throw new Error('release/next must be owned by the trusted Release App');
  }
  const baseSha = process.env.BASE_SHA || '';
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) throw new Error('invalid pull request base SHA');
  if (git(['show', '-s', '--format=%P', 'HEAD']) !== baseSha) {
    throw new Error('the generated release commit must directly follow current master');
  }
  const packageSource = readAt(baseSha, 'package.json');
  const runtimeSource = readAt(baseSha, 'src/version.ts');
  const changelogSource = readAt(baseSha, 'CHANGELOG.md');
  const baseTag = latestVersionTag();
  if (!gitSucceeds(['merge-base', '--is-ancestor', baseTag, baseSha])) {
    throw new Error(`${baseTag} is not an ancestor of the Release PR base`);
  }
  if (currentPackageVersion(packageSource) !== baseTag.slice(1)) {
    throw new Error('the Release PR base version differs from its latest Tag');
  }
  const subjects = git(['log', '--format=%s', `${baseTag}..${baseSha}`])
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((subject) => !/^chore\(release\):/u.test(subject));
  const expected = buildReleasePlanFiles({
    packageSource,
    runtimeSource,
    changelogSource,
    subjects,
  });
  const expectedTitle = `chore(release): prepare v${expected.version}`;
  if (process.env.PR_TITLE !== expectedTitle) {
    throw new Error(`Release PR title must be ${expectedTitle}`);
  }
  const expectedFiles = new Map<string, string>([
    ['CHANGELOG.md', expected.changelogSource],
    ['package.json', expected.packageSource],
    ['src/version.ts', expected.runtimeSource],
  ]);
  const changed = git(['diff', '--name-only', baseSha, 'HEAD'])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (
    changed.length !== expectedFiles.size
    || changed.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error('Release PR changed files outside the deterministic plan');
  }
  for (const [file, content] of expectedFiles) {
    if (await fs.readFile(file, 'utf8') !== content) {
      throw new Error(`${file} differs from the deterministic Release plan`);
    }
  }
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/tags/v${expected.version}`])) {
    throw new Error(`v${expected.version} already exists`);
  }
}

async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2);
  if (command === 'prepare' && file) {
    await prepareCandidate(file);
    return;
  }
  if (command === 'verify' && !file) {
    await verifyCandidate();
    return;
  }
  throw new Error('Usage: reconcile-release.ts <prepare BODY_FILE|verify>');
}

await main();
