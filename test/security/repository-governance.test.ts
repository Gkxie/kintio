import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

async function read(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

async function filesBelow(directory: string, suffix = '.ts'): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesBelow(target, suffix)
      : Promise.resolve(entry.isFile() && entry.name.endsWith(suffix) ? [target] : []);
  }))).flat();
}

test('local documentation links resolve to existing files', async () => {
  const files = [
    'README.md',
    'README.zh-CN.md',
    'CONTRIBUTING.md',
    'MAINTAINING.md',
    'ROADMAP.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'CHANGELOG.md',
    '.env.example',
    ...(await filesBelow('docs', '.md')),
  ];
  for (const file of files) {
    const content = await read(file);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const link = match[1] || '';
      if (/^(?:https?:|mailto:|#)/u.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0] || '');
      await fs.access(path.resolve(path.dirname(file), target));
    }
  }
});

test('the documented source-to-test fragment points to its heading', async () => {
  const [contributing, architecture] = await Promise.all([
    read('CONTRIBUTING.md'),
    read('docs/architecture.md'),
  ]);
  assert.match(
    contributing,
    /\]\(docs\/architecture\.md#where-to-make-changes\)/u,
  );
  assert.match(architecture, /^## Where to make changes$/mu);
});

test('English is canonical and Chinese is limited to the entry README', async () => {
  const rootMarkdown = (await fs.readdir('.', { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .filter((file) => file !== 'README.zh-CN.md');
  const englishFiles = Array.from(new Set([
    ...rootMarkdown,
    '.env.example',
    'LICENSE',
    'THIRD_PARTY_NOTICES',
    '.github/CODEOWNERS',
    ...(await filesBelow('docs', '.md')),
    ...(await filesBelow('codex-workspace/.agents/skills', '.md')),
    ...(await filesBelow('.github', '.md')),
    ...(await filesBelow('.github', '.yml')),
    ...(await filesBelow('.github', '.yaml')),
  ]));
  for (const file of englishFiles) {
    const content = (await read(file)).replaceAll('简体中文', 'Chinese');
    assert.doesNotMatch(content, /\p{Script=Han}/u, file);
  }
  const chineseEntry = await read('README.zh-CN.md');
  assert.match(chineseEntry, /\p{Script=Han}/u);
  assert.match(chineseEntry, /\[English\]\(README\.md\)/u);
});

test('public collaboration files keep stable forms, one test entry point, and release metadata', async () => {
  const [
    bug,
    feature,
    issueConfig,
    pullRequest,
    contributing,
    maintaining,
    codeOfConduct,
    security,
    codeowners,
    license,
    notices,
    packageSource,
    runtimeVersion,
    gitignore,
    cla,
  ] = await Promise.all([
    read('.github/ISSUE_TEMPLATE/bug_report.yml'),
    read('.github/ISSUE_TEMPLATE/feature_request.yml'),
    read('.github/ISSUE_TEMPLATE/config.yml'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
    read('CONTRIBUTING.md'),
    read('MAINTAINING.md'),
    read('CODE_OF_CONDUCT.md'),
    read('SECURITY.md'),
    read('.github/CODEOWNERS'),
    read('LICENSE'),
    read('THIRD_PARTY_NOTICES'),
    read('package.json'),
    read('src/version.ts'),
    read('.gitignore'),
    read('CLA.md'),
  ]);
  for (const form of [bug, feature]) {
    assert.equal(
      form.match(/^  - type:/gmu)?.length,
      form.match(/^    id:/gmu)?.length,
      'every Issue Form input requires a stable id',
    );
  }
  assert.match(pullRequest, /pnpm test/u);
  assert.match(pullRequest, /^## Changelog impact$/mu);
  assert.match(pullRequest, /Material generative AI or agent use \(required/u);
  assert.match(pullRequest, /not an unattended or bulk-generated submission/u);
  assert.match(bug, /^    id: environment$/mu);
  assert.match(bug, /Start method:/u);
  assert.match(contributing, /pnpm test/u);
  assert.match(contributing, /Contributor License\s+Agreement/u);
  assert.match(contributing, /does not accept unattended or undisclosed agent submissions/u);
  assert.match(contributing, /Routine autocomplete, formatters, linters/u);
  assert.match(contributing, /at most one\s+pull request open, including drafts/u);
  assert.match(maintaining, /`status: needs reproduction`/u);
  assert.match(maintaining, /successful `CLA` status/u);
  assert.match(maintaining, /all external contributors/u);
  assert.match(maintaining, /concurrent open pull request cap at one/u);
  assert.match(maintaining, /^## Abuse response$/mu);
  assert.match(maintaining, /contributors_only[\s\S]+collaborators_only/u);
  assert.match(maintaining, /audit collaborators,[\s\S]+webhooks,[\s\S]+deploy keys/u);
  assert.match(codeOfConduct, /phishing, malicious links or attachments/u);
  assert.match(codeOfConduct, /close or lock discussions/u);
  assert.match(codeOfConduct, /block accounts, and report abuse to GitHub/u);
  assert.match(security, /Harassment, spam, and impersonation/u);
  assert.match(security, /Private Vulnerability Reporting/u);
  assert.match(codeowners, /^\*\s+@[A-Za-z0-9-]+$/mu);
  assert.match(issueConfig, /security\/advisories\/new/u);
  assert.match(issueConfig, /discussions\/categories\/q-a/u);
  assert.match(issueConfig, /discussions\/categories\/ideas/u);
  assert.match(issueConfig, /CODE_OF_CONDUCT\.md#enforcement/u);
  assert.match(license, /Apache License\s+Version 2\.0/iu);
  assert.match(notices, /Tencent[\s\S]+MIT License/iu);
  assert.match(cla, /Project Owner[^\n]+XIE YU/su);
  assert.match(cla, /I have read the CLA Document and I hereby sign the CLA/u);
  const packageJson = JSON.parse(packageSource) as {
    name?: string;
    version?: string;
    private?: boolean;
    license?: string;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    repository?: { url?: string };
    bugs?: { url?: string };
    homepage?: string;
  };
  assert.match(packageJson.version || '', /^0\./u);
  assert.equal(packageJson.name, 'kintio');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(packageJson.bin?.kintio, 'bin/kintio.js');
  assert.equal(packageJson.scripts?.prepack, 'pnpm run build');
  assert.equal(packageJson.dependencies?.pm2, '7.0.4');
  for (const file of [
    'dist',
    'bin/kintio.js',
    '.env.example',
    'ecosystem.config.cjs',
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
  ]) {
    assert.equal(packageJson.files?.includes(file), true, `missing package file ${file}`);
  }
  for (const readme of [await read('README.md'), await read('README.zh-CN.md')]) {
    const setupIndex = readme.indexOf('kintio setup');
    assert.notEqual(setupIndex, -1);
    assert.ok(readme.indexOf('kintio start', setupIndex) > setupIndex);
  }
  assert.equal(
    packageJson.repository?.url,
    'git+https://github.com/Gkxie/kintio.git',
  );
  assert.equal(
    packageJson.bugs?.url,
    'https://github.com/Gkxie/kintio/issues',
  );
  assert.equal(
    packageJson.homepage,
    'https://github.com/Gkxie/kintio#readme',
  );
  assert.equal(
    /^export const KINTIO_VERSION = ['"]([^'"]+)['"];\r?\n?$/u.exec(
      runtimeVersion,
    )?.[1],
    packageJson.version,
  );
  const ignored = new Set(gitignore.split(/\r?\n/u));
  for (const pattern of ['.env.*', '*.pem', '*.key', '*.sqlite', '*.db']) {
    assert.equal(ignored.has(pattern), true, `missing .gitignore pattern ${pattern}`);
  }
});

test('GitHub automation covers CI, security, dependency policy, and releases', async () => {
  const [
    ci,
    prTitle,
    codeql,
    dependencyReview,
    dependabot,
    secretScan,
    release,
    vitest,
    claWorkflow,
    claScript,
  ] = await Promise.all([
    read('.github/workflows/ci.yml'),
    read('.github/workflows/pr-title.yml'),
    read('.github/workflows/codeql.yml'),
    read('.github/workflows/dependency-review.yml'),
    read('.github/dependabot.yml'),
    read('.github/workflows/secret-scan.yml'),
    read('.github/workflows/release.yml'),
    read('vitest.config.ts'),
    read('.github/workflows/cla.yml'),
    read('scripts/cla.ts'),
  ]);
  assert.match(ci, /pull_request:/u);
  assert.match(prTitle, /types: \[opened, edited, reopened, synchronize\]/u);
  assert.match(prTitle, /name: PR title/u);
  assert.match(prTitle, /feat\|fix\|docs\|refactor/u);
  assert.match(ci, /pnpm test/u);
  assert.match(ci, /pnpm exec tsc/u);
  assert.match(ci, /KNIP_DISABLE_RAW_TRANSFER=1 pnpm exec knip/u);
  assert.match(ci, /pnpm run build/u);
  assert.match(ci, /pnpm audit --prod --audit-level=high/u);
  assert.match(ci, /Verify coverage artifact round trip/u);
  assert.match(ci, /kintio-coverage-round-trip\/coverage-summary\.json/u);
  assert.match(vitest, /GITHUB_ACTIONS[\s\S]+github-actions/u);
  assert.match(claWorkflow, /pull_request_target:/u);
  assert.match(claWorkflow, /types: \[opened, reopened, synchronize, ready_for_review\]/u);
  assert.match(claWorkflow, /pull_request\.draft == false/u);
  assert.match(claWorkflow, /issue_comment:/u);
  assert.doesNotMatch(claWorkflow.split(/^jobs:$/mu)[0] || '', /concurrency:/u);
  assert.match(claWorkflow, /comment-preflight:[\s\S]+outputs:[\s\S]+mode:/u);
  assert.match(
    claWorkflow,
    /comment\.body == 'recheck'[\s\S]+comment\.author_association == 'OWNER'/u,
  );
  assert.match(
    claWorkflow,
    /group: cla-preflight-[^\n]+[\s\S]+cancel-in-progress: true/u,
  );
  assert.match(claWorkflow, /scripts\/cla\.ts preflight/u);
  assert.match(claWorkflow, /needs: comment-preflight/u);
  assert.match(claWorkflow, /group: cla-evaluate-[^\n]+[\s\S]+cancel-in-progress: true/u);
  assert.match(claWorkflow, /group: cla-sign-\$\{\{ github\.repository_id \}\}[\s\S]+queue: max/u);
  assert.match(claWorkflow, /contents: write/u);
  assert.match(claWorkflow, /pull-requests: write/u);
  assert.match(claWorkflow, /statuses: write/u);
  assert.match(claWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.doesNotMatch(claWorkflow, /pull_request\.head|github\.head_ref/u);
  assert.doesNotMatch(claWorkflow, /contributor-assistant/u);
  assert.match(claScript, /claSha256/u);
  assert.match(claScript, /githubUserId/u);
  assert.match(claScript, /CLA_LEDGER_BRANCH = 'cla-signatures'/u);
  assert.doesNotMatch(claWorkflow, /edited|deleted|revalidate-comment/u);
  assert.match(codeql, /security-events: write/u);
  assert.match(codeql, /repository\.visibility == 'public'/u);
  assert.match(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40} # v4/u);
  assert.match(
    dependencyReview,
    /actions\/dependency-review-action@[0-9a-f]{40} # v5\.0\.0/u,
  );
  assert.match(dependencyReview, /repository\.visibility == 'public'/u);
  assert.match(dependabot, /package-ecosystem: npm/u);
  assert.match(dependabot, /package-ecosystem: github-actions/u);
  assert.match(
    dependabot,
    /dependency-name: '@types\/node'[\s\S]+version-update:semver-major/u,
  );
  assert.match(
    secretScan,
    /ghcr\.io\/gitleaks\/gitleaks:v8\.29\.0@sha256:71d3ee5990f2176f763b438298453fc37e87b119122045e176ca9d44ff00b08b/u,
  );
  assert.match(secretScan, /docker run --rm --network none/u);
  assert.match(secretScan, /\$GITHUB_WORKSPACE:\/repo:ro/u);
  assert.match(release, /tags: \['v\*\.\*\.\*'\]/u);
  assert.match(release, /tag .* does not match package version/u);
  assert.match(release, /git merge-base --is-ancestor/u);
  assert.match(release, /Remote tag no longer points to the verified commit/u);
  assert.match(release, /contents: read[\s\S]+contents: write/u);
  assert.match(release, /group: release/u);
  assert.match(release, /queue: max/u);
  assert.match(release, /overwrite: true/u);
  assert.match(release, /pnpm test/u);
  assert.match(release, /gh release create/u);
  assert.doesNotMatch(release, /gh release edit/u);
  assert.match(release, /pre-existing release .* is refused/u);
  assert.doesNotMatch(release, /gh release view/u);
  const downloadArtifact = /actions\/download-artifact@([0-9a-f]{40})/u;
  const ciDownload = downloadArtifact.exec(ci);
  const releaseDownload = downloadArtifact.exec(release);
  assert.ok(ciDownload, 'CI must exercise download-artifact');
  assert.ok(releaseDownload, 'releases must use download-artifact');
  assert.equal(
    ciDownload[1],
    releaseDownload[1],
    'CI must exercise the same download-artifact revision used by releases',
  );
  for (const workflow of [
    ci,
    prTitle,
    codeql,
    dependencyReview,
    secretScan,
    release,
    claWorkflow,
  ]) {
    for (const uses of workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) {
      assert.match(
        uses[1] || '',
        /(?:@[0-9a-f]{40}|@sha256:[0-9a-f]{64})$/u,
      );
    }
  }
});

test('deterministic behavior specifications cannot be skipped or left todo', async () => {
  const files = (await Promise.all([
    'test/unit',
    'test/integration',
    'test/recovery',
    'test/security',
  ].map((directory) => filesBelow(directory)))).flat();
  const forbidden = /\b(?:test|it|describe)\s*\.\s*(?:skip|todo|skipIf|runIf)\s*\(/u;
  for (const file of files) assert.doesNotMatch(await read(file), forbidden, file);
});
