import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

async function read(file: string): Promise<string> {
  return (await fs.readFile(file, 'utf8')).replaceAll('\r\n', '\n');
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
    ...(await fs.readdir('.', { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name),
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

test('package, release version, and public entry points stay aligned', async () => {
  const [packageSource, runtimeVersion, license, cla, gitignore] = await Promise.all([
    read('package.json'),
    read('src/version.ts'),
    read('LICENSE'),
    read('CLA.md'),
    read('.gitignore'),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    name?: string;
    version?: string;
    private?: boolean;
    author?: string;
    license?: string;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    repository?: { url?: string };
    publishConfig?: { access?: string; registry?: string };
  };
  assert.equal(packageJson.name, '@kin-tio/cli');
  assert.match(packageJson.version || '', /^0\.\d+\.\d+$/u);
  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.author, 'XIE YU');
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(packageJson.bin?.kintio, 'bin/kintio.js');
  assert.equal(packageJson.scripts?.prepack, 'pnpm run build');
  assert.equal(packageJson.repository?.url, 'git+https://github.com/Gkxie/kintio.git');
  assert.equal(
    /^export const KINTIO_VERSION = ['"]([^'"]+)['"];\r?\n?$/u.exec(runtimeVersion)?.[1],
    packageJson.version,
  );
  assert.deepEqual(packageJson.files?.toSorted(), [
    '.env.example',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'README.zh-CN.md',
    'THIRD_PARTY_NOTICES',
    'assets/ilink-login-card.png',
    'bin/kintio.js',
    'codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md',
    'dist',
  ].toSorted());
  assert.match(license, /Apache License\s+Version 2\.0/iu);
  assert.match(cla, /Project Owner[^\n]+XIE YU/su);
  const ignored = new Set(gitignore.split(/\r?\n/u));
  for (const pattern of ['.env.*', '*.pem', '*.key', '*.sqlite', '*.db']) {
    assert.equal(ignored.has(pattern), true, `missing .gitignore pattern ${pattern}`);
  }
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const readme = await read(file);
    const installIndex = readme.indexOf('npm install --global @kin-tio/cli');
    const setupIndex = readme.indexOf('kintio setup');
    assert.notEqual(installIndex, -1);
    assert.notEqual(setupIndex, -1);
    assert.ok(installIndex < setupIndex);
    assert.ok(readme.indexOf('kintio start', setupIndex) > setupIndex);
  }
});

test('Issue Forms expose stable input identifiers', async () => {
  for (const file of [
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
  ]) {
    const form = await read(file);
    assert.equal(
      form.match(/^  - type:/gmu)?.length,
      form.match(/^    id:/gmu)?.length,
      `${file} requires one id per input`,
    );
  }
});

test('repository workflows preserve executable security boundaries', async () => {
  const workflowFiles = [
    '.github/workflows/ci.yml',
    '.github/workflows/cla.yml',
    '.github/workflows/codeql.yml',
    '.github/workflows/dependency-review.yml',
    '.github/workflows/pr-title.yml',
    '.github/workflows/real-codex.yml',
    '.github/workflows/release.yml',
    '.github/workflows/secret-scan.yml',
  ];
  const workflows = new Map(
    await Promise.all(workflowFiles.map(async (file) => [file, await read(file)] as const)),
  );
  for (const [file, workflow] of workflows) {
    for (const uses of workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) {
      assert.match(
        uses[1] || '',
        /(?:@[0-9a-f]{40}|@sha256:[0-9a-f]{64})$/u,
        file,
      );
    }
  }

  const ci = workflows.get('.github/workflows/ci.yml') || '';
  assert.match(ci, /^  pull_request:$/mu);
  assert.doesNotMatch(ci, /^  (?:push|workflow_dispatch):/mu);
  for (const command of [
    'pnpm exec tsc -p tsconfig.test.json',
    'KNIP_DISABLE_RAW_TRANSFER=1 pnpm exec knip',
    'pnpm run build',
    'npm pack --json --ignore-scripts',
    'npm install --global',
    'pnpm test',
  ]) assert.ok(ci.includes(command), command);
  for (const operatingSystem of [
    'ubuntu-latest',
    'macos-latest',
    'windows-latest',
  ]) assert.ok(ci.includes(operatingSystem), operatingSystem);
  assert.match(ci, /name: Unit, integration, recovery, security/u);
  assert.match(ci, /needs: platform-tests/u);
  assert.doesNotMatch(ci, /pnpm audit|upload-artifact|download-artifact/u);

  const secretScan = workflows.get('.github/workflows/secret-scan.yml') || '';
  assert.match(secretScan, /^  pull_request:$/mu);
  assert.doesNotMatch(secretScan, /^  (?:push|workflow_dispatch):/mu);
  assert.match(secretScan, /docker run --rm --network none/u);
  assert.match(secretScan, /\$GITHUB_WORKSPACE:\/repo:ro/u);

  const cla = workflows.get('.github/workflows/cla.yml') || '';
  assert.match(cla, /contributor-assistant\/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08/u);
  assert.match(cla, /github\.event\.action == 'closed' && github\.event\.pull_request\.merged == true/u);
  assert.match(cla, /path-to-document: https:\/\/github\.com\/Gkxie\/kintio\/blob\/cla-v1\.1\/CLA\.md/u);
  assert.match(cla, /path-to-signatures: signatures\/v1\.1\/cla\.json/u);
  assert.match(cla, /allowlist: dependabot\[bot\]/u);
  assert.match(cla, /The pull request opener must be a primary commit author/u);
  assert.doesNotMatch(cla, /renovate|actions\/checkout/u);

  const realCodex = workflows.get('.github/workflows/real-codex.yml') || '';
  assert.match(realCodex, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(realCodex, /^  (?:push|pull_request|schedule):/mu);
  assert.match(realCodex, /github\.ref == 'refs\/heads\/master'/u);
  assert.match(realCodex, /startsWith\(github\.ref, 'refs\/heads\/codex\/'\)/u);
  assert.match(realCodex, /github\.actor == 'Gkxie'/u);
  assert.match(realCodex, /github\.triggering_actor == 'Gkxie'/u);
  assert.match(realCodex, /github\.run_attempt == 1/u);
  assert.match(realCodex, /^    environment: codex-eval$/mu);
  assert.match(realCodex, /persist-credentials: false/u);
  assert.match(realCodex, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(realCodex, /CODEX_SHA256: [0-9a-f]{64}/u);
  assert.match(realCodex, /sha256sum --check --strict/u);
  assert.match(realCodex, /KINTIO_CI_API_KEY: \$\{\{ secrets\.KINTIO_CI_API_KEY \}\}/u);
  assert.equal(realCodex.match(/secrets\.KINTIO_CI_API_KEY/gu)?.length, 1);
  assert.match(realCodex, /codex login --with-api-key/u);
  assert.match(realCodex, /requires_openai_auth = true/u);
  assert.doesNotMatch(realCodex, /env_key = "KINTIO_CI_API_KEY"/u);
  assert.match(realCodex, /base_url = "\$KINTIO_CI_BASE_URL"/u);
  assert.match(realCodex, /model_reasoning_effort = "none"/u);
  assert.doesNotMatch(realCodex, /^\s+CODEX_(?:MODEL|PATH|REASONING_EFFORT|WEB_SEARCH_MODE):/mu);
  assert.doesNotMatch(realCodex, /REAL_CODEX_CONCURRENCY|upload-artifact|download-artifact/u);
  assert.match(realCodex, /name: Remove isolated Codex state\n\s+if: always\(\)/u);

  const release = workflows.get('.github/workflows/release.yml') || '';
  assert.match(release, /tags: \['v\*\.\*\.\*'\]/u);
  assert.match(release, /git merge-base --is-ancestor/u);
  assert.match(release, /Release tags must be annotated tags/u);
  assert.match(release, /contents: read[\s\S]+contents: write/u);
  assert.match(release, /gh release create/u);
  assert.doesNotMatch(release, /pnpm audit|gh release edit/u);
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
