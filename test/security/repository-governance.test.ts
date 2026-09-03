import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const [packageSource, runtimeVersion, license, cla, gitignore, logo, avatar, bin] =
    await Promise.all([
      read('package.json'),
      read('src/version.ts'),
      read('LICENSE'),
      read('CLA.md'),
      read('.gitignore'),
      read('assets/logo.svg'),
      read('assets/avatar.svg'),
      read('bin/kintio.js'),
    ]);
  const packageJson = JSON.parse(packageSource) as {
    name?: string;
    version?: string;
    private?: boolean;
    author?: string;
    license?: string;
    bin?: Record<string, string>;
    engines?: Record<string, string>;
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
  assert.equal(packageJson.engines?.node, '>=24');
  assert.match(bin, /nodeMajor < 24/u);
  assert.match(bin, /requires Node\.js 24 or newer/u);
  assert.ok(bin.indexOf('nodeMajor < 24') < bin.indexOf("import('../dist/cli.js')"));
  assert.equal(packageJson.scripts?.prepack, 'pnpm run build');
  assert.equal(packageJson.scripts?.test, 'vitest run && cargo test --locked');
  assert.equal(packageJson.repository?.url, 'git+https://github.com/Gkxie/kintio.git');
  assert.equal(
    /^export const KINTIO_VERSION = ['"]([^'"]+)['"];\r?\n?$/u.exec(runtimeVersion)?.[1],
    packageJson.version,
  );
  assert.deepEqual(packageJson.files?.toSorted(), [
    'CHANGELOG.md',
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
  for (const [file, logoSource] of [
    ['README.md', 'https://raw.githubusercontent.com/Gkxie/kintio/master/assets/logo.svg'],
    ['README.zh-CN.md', 'assets/logo.svg'],
  ] as const) {
    const readme = await read(file);
    assert.ok(readme.includes(`<img src="${logoSource}" alt="Kintio" width="320" />`));
    const installIndex = readme.indexOf('npm install --global @kin-tio/cli');
    const setupIndex = readme.indexOf('kintio setup');
    assert.notEqual(installIndex, -1);
    assert.notEqual(setupIndex, -1);
    assert.ok(installIndex < setupIndex);
    assert.ok(readme.indexOf('kintio start', setupIndex) > setupIndex);
  }
  assert.match(logo, /<title id="kintio-wordmark-title">Kintio<\/title>/u);
  assert.match(logo, /fill="#211920"/u);
  assert.match(avatar, /<title id="kintio-avatar-title">Kintio TIO avatar<\/title>/u);
  assert.match(avatar, /clipPath id="kintio-kinetic-panels-circle"/u);
});

test('the native migration stays pinned, non-published, and separate from production', async () => {
  const [cargo, toolchain, build, lock] = await Promise.all([
    read('Cargo.toml'),
    read('rust-toolchain.toml'),
    read('rust/build.rs'),
    read('Cargo.lock'),
  ]);
  assert.match(cargo, /^name = "kintio-native"$/mu);
  assert.match(cargo, /^version = "0\.0\.0"$/mu);
  assert.match(cargo, /^publish = false$/mu);
  assert.match(cargo, /^name = "kintio-rs"$/mu);
  assert.match(cargo, /^unsafe_code = "forbid"$/mu);
  assert.match(toolchain, /^channel = "1\.98\.0"$/mu);
  assert.match(toolchain, /^components = \["clippy", "rustfmt"\]$/mu);
  assert.match(build, /cargo:rustc-env=KINTIO_VERSION/u);
  assert.match(build, /trim_end_matches\(\['\\r', '\\n'\]\)/u);
  assert.match(lock, /^version = 4$/mu);
  assert.equal(JSON.parse(await read('package.json')).bin.kintio, 'bin/kintio.js');
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
    '.github/workflows/prepare-release.yml',
    '.github/workflows/pr-title.yml',
    '.github/workflows/release-codex.yml',
    '.github/workflows/release-plan.yml',
    '.github/workflows/release-pr.yml',
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
  const packagePreparation = await read('scripts/prepare-package.ts');
  assert.match(ci, /^  pull_request:$/mu);
  assert.doesNotMatch(ci, /^  (?:push|workflow_dispatch):/mu);
  for (const command of [
    'pnpm exec tsc -p tsconfig.test.json',
    'KNIP_DISABLE_RAW_TRANSFER=1 pnpm exec knip',
    'cargo fmt --check',
    'cargo clippy --locked --all-targets -- -D warnings',
    'pnpm run build',
    'scripts/prepare-package.ts',
    'npm pack --json --ignore-scripts',
    'npm install --global',
    'pnpm test',
  ]) assert.ok(ci.includes(command), command);
  assert.match(ci, /packed Changelog does not start with the package version/u);
  assert.match(ci, /packed Changelog contains repository-only headings/u);
  assert.match(packagePreparation, /publishedChangelog/u);
  assert.match(packagePreparation, /preparePackage/u);
  assert.match(packagePreparation, /fs\.rm\('README\.zh-CN\.md'\)/u);
  for (const operatingSystem of [
    'ubuntu-latest',
    'macos-latest',
    'windows-latest',
  ]) assert.ok(ci.includes(operatingSystem), operatingSystem);
  assert.match(ci, /name: Unit, integration, recovery, security/u);
  assert.match(ci, /needs: platform-tests/u);
  assert.doesNotMatch(ci, /pnpm audit|upload-artifact|download-artifact/u);

  const dependabot = await read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem: cargo/u);

  const secretScan = workflows.get('.github/workflows/secret-scan.yml') || '';
  assert.match(secretScan, /^  pull_request:$/mu);
  assert.doesNotMatch(secretScan, /^  (?:push|workflow_dispatch):/mu);
  assert.match(secretScan, /docker run --rm --network none/u);
  assert.match(secretScan, /\$GITHUB_WORKSPACE:\/repo:ro/u);

  const cla = workflows.get('.github/workflows/cla.yml') || '';
  assert.match(cla, /contributor-assistant\/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08/u);
  assert.match(cla, /lock-pullrequest-aftermerge:\s*false/u);
  assert.doesNotMatch(cla, /lock-pullrequest-aftermerge:\s*true/u);
  assert.match(cla, /github\.event\.action == 'closed' && github\.event\.pull_request\.merged == true/u);
  assert.match(cla, /path-to-document: https:\/\/github\.com\/Gkxie\/kintio\/blob\/cla-v1\.1\/CLA\.md/u);
  assert.match(cla, /path-to-signatures: signatures\/v1\.1\/cla\.json/u);
  assert.match(cla, /allowlist: dependabot\[bot\]/u);
  assert.match(cla, /The pull request opener must be a primary commit author/u);
  assert.doesNotMatch(cla, /renovate|actions\/checkout/u);
  const approvedBotSource = /else if \(!\[([\s\S]*?)\]\.includes\(pullRequest\.author\?\.login\)\)/u
    .exec(cla)?.[1] || '';
  const approvedGraphqlBots = new Set(
    [...approvedBotSource.matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
  );
  assert.deepEqual(approvedGraphqlBots, new Set([
    'dependabot[bot]',
    'dependabot',
    'kintio-release[bot]',
    'kintio-release',
  ]));

  await assert.rejects(
    fs.access('.github/workflows/real-codex.yml'),
    { code: 'ENOENT' },
  );

  const releaseCodex = workflows.get('.github/workflows/release-codex.yml') || '';
  assert.match(releaseCodex, /^  pull_request_target:\n    branches: \[master\]$/mu);
  assert.doesNotMatch(releaseCodex, /^  (?:pull_request|push|workflow_dispatch|schedule):/mu);
  assert.match(releaseCodex, /types: \[opened, synchronize, reopened, ready_for_review\]/u);
  for (const file of ['CHANGELOG.md', 'package.json', 'src/version.ts']) {
    assert.match(
      releaseCodex,
      new RegExp(`^      - ${file.replaceAll('.', '\\.')}$`, 'mu'),
    );
  }
  for (const identity of [
    "github.event.pull_request.user.login == 'kintio-release[bot]'",
    "github.actor == 'kintio-release[bot]'",
    "github.triggering_actor == 'kintio-release[bot]'",
    "github.actor == 'Gkxie'",
    "github.triggering_actor == 'Gkxie'",
  ]) assert.ok(releaseCodex.includes(identity), identity);
  assert.match(releaseCodex, /github\.event_name == 'pull_request_target'/u);
  assert.match(releaseCodex, /github\.event\.pull_request\.base\.repo\.full_name == github\.repository/u);
  assert.match(releaseCodex, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(releaseCodex, /github\.event\.pull_request\.head\.ref == 'release\/next'/u);
  assert.match(releaseCodex, /github\.event\.pull_request\.draft == false/u);
  assert.match(releaseCodex, /github\.run_attempt == 1/u);
  assert.match(releaseCodex, /group: release-codex-validation-/u);
  assert.match(releaseCodex, /cancel-in-progress: true/u);
  const authorizeJob = /^  authorize:\n([\s\S]*?)(?=^  validate:)/mu.exec(releaseCodex)?.[1] || '';
  const validateJob = /^  validate:\n([\s\S]*)/mu.exec(releaseCodex)?.[1] || '';
  assert.match(authorizeJob, /name: Authorize deterministic Release/u);
  assert.doesNotMatch(authorizeJob, /environment: codex-eval|secrets\./u);
  assert.match(authorizeJob, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(authorizeJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(authorizeJob, /path: trusted/u);
  assert.match(authorizeJob, /path: candidate/u);
  assert.match(authorizeJob, /working-directory: candidate/u);
  assert.match(authorizeJob, /test "\$\(git rev-parse HEAD\)" = "\$HEAD_SHA"/u);
  assert.match(authorizeJob, /\.\.\/trusted\/\.github\/scripts\/reconcile-release\.ts verify/u);
  assert.match(authorizeJob, /authorized=true\\nhead_sha=%s\\n/u);
  assert.match(validateJob, /needs: authorize/u);
  assert.match(validateJob, /if: needs\.authorize\.outputs\.authorized == 'true'/u);
  assert.match(validateJob, /^    environment: codex-eval$/mu);
  assert.match(validateJob, /ref: \$\{\{ needs\.authorize\.outputs\.head_sha \}\}/u);
  assert.match(validateJob, /test "\$\(git rev-parse HEAD\)" = "\$AUTHORIZED_HEAD_SHA"/u);
  assert.match(validateJob, /persist-credentials: false/u);
  assert.match(validateJob, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(validateJob, /KINTIO_CI_API_KEY: \$\{\{ secrets\.KINTIO_CI_API_KEY \}\}/u);
  assert.equal(releaseCodex.match(/secrets\.KINTIO_CI_API_KEY/gu)?.length, 1);
  assert.match(validateJob, /name: Remove isolated Codex state\n\s+if: always\(\)/u);

  const prepareRelease = workflows.get('.github/workflows/prepare-release.yml') || '';
  assert.match(prepareRelease, /^  push:\n    branches: \[master\]$/mu);
  assert.match(prepareRelease, /^  workflow_dispatch:$/mu);
  assert.match(prepareRelease, /group: prepare-release\n  cancel-in-progress: true/u);
  assert.match(prepareRelease, /vars\.KINTIO_RELEASE_APP_CLIENT_ID != ''/u);
  assert.match(prepareRelease, /actions\/create-github-app-token@[0-9a-f]{40}/u);
  assert.match(prepareRelease, /permission-contents: write/u);
  assert.match(prepareRelease, /permission-pull-requests: write/u);
  assert.match(
    prepareRelease,
    /APP_SLUG: \$\{\{ steps\.app-token\.outputs\.app-slug \}\}/u,
  );
  assert.match(prepareRelease, /test "\$APP_SLUG" = kintio-release/u);
  assert.match(prepareRelease, /peter-evans\/create-pull-request@[0-9a-f]{40}/u);
  assert.match(prepareRelease, /branch: release\/next/u);
  assert.match(prepareRelease, /sign-commits: true/u);
  assert.doesNotMatch(
    prepareRelease,
    /id-token: write|actions: write|packages: write|NPM_TOKEN|NODE_AUTH_TOKEN/u,
  );

  const releasePlan = workflows.get('.github/workflows/release-plan.yml') || '';
  assert.match(releasePlan, /name: Release plan/u);
  assert.match(releasePlan, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(releasePlan, /path: trusted/u);
  assert.match(releasePlan, /\.\.\/trusted\/\.github\/scripts\/reconcile-release\.ts/u);
  assert.doesNotMatch(releasePlan, /pull_request_target|contents: write|secrets\./u);

  const release = workflows.get('.github/workflows/release.yml') || '';
  assert.match(release, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(release, /^  push:/mu);
  assert.match(release, /git merge-base --is-ancestor/u);
  assert.match(release, /associatedPulls\.find/u);
  assert.match(release, /pull\.user\?\.login === process\.env\.REPOSITORY_OWNER/u);
  assert.match(release, /pull\.user\?\.login === process\.env\.RELEASE_BOT_LOGIN/u);
  assert.match(release, /pull\.head\?\.ref === 'release\/next'/u);
  assert.match(release, /releasePull\.merged_by\?\.login !== process\.env\.REPOSITORY_OWNER/u);
  assert.match(release, /tag commit is not an authorized merged Release PR/u);
  assert.match(release, /allowedReleaseFiles/u);
  assert.match(release, /Release tags must be annotated tags/u);
  assert.match(release, /contents: read[\s\S]+contents: write/u);
  assert.match(release, /scripts\/prepare-package\.ts/u);
  assert.match(release, /npm pack --json --ignore-scripts/u);
  assert.match(release, /environment: npm-release/u);
  assert.equal(release.match(/id-token: write/gu)?.length, 1);
  assert.equal(release.match(/retention-days: 30/gu)?.length, 2);
  assert.match(release, /createHash\('sha512'\)/u);
  assert.match(release, /const minimum = \[11, 5, 1\]/u);
  assert.match(release, /npm publish-time scan pending/u);
  assert.match(release, /\['dist-tag', 'ls', metadata\.name/u);
  assert.match(release, /attempt <= 80/u);
  assert.match(release, /needs: \[verify, publish-npm, smoke-registry\]/u);
  assert.match(release, /npm install --global/u);
  assert.match(release, /npm audit signatures --prefix/u);
  assert.match(release, /--include-attestations/u);
  assert.match(release, /attestationBundles/u);
  assert.match(release, /gh release create/u);
  assert.match(release, /name: Reconcile the next Release PR after publication/u);
  assert.match(release, /^  report:\n    if: always\(\) && needs\.verify\.outputs\.pull_request != ''$/mu);
  assert.match(
    release,
    /needs: \[verify, publish-npm, smoke-registry, release, prepare-next\]/u,
  );
  assert.match(release, /pull-requests: write/u);
  assert.match(release, /\.github\/scripts\/report-release\.ts/u);
  assert.match(
    release,
    /gh workflow run prepare-release\.yml[\s\S]*--repo "\$GITHUB_REPOSITORY"[\s\S]*--ref master/u,
  );
  assert.doesNotMatch(
    release,
    /pnpm audit|gh release edit|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u,
  );
  const publishJob = /^  publish-npm:[\s\S]+?(?=^  smoke-registry:)/mu.exec(release)?.[0] || '';
  const smokeJob = /^  smoke-registry:[\s\S]+?(?=^  release:)/mu.exec(release)?.[0] || '';
  const verifyJob = /^  verify:[\s\S]+?(?=^  publish-npm:)/mu.exec(release)?.[0] || '';
  const reportJob = /^  report:[\s\S]+$/mu.exec(release)?.[0] || '';
  assert.match(verifyJob, /tag_type=\$\(git cat-file -t/u);
  assert.match(verifyJob, /Release tags must be annotated tags/u);
  assert.ok(verifyJob.indexOf('tag_type=$(') < verifyJob.indexOf('npm pack'));
  assert.match(publishJob, /id-token: write/u);
  assert.doesNotMatch(publishJob, /actions\/checkout|pnpm install|npm pack/u);
  assert.doesNotMatch(smokeJob, /id-token: write/u);
  assert.match(reportJob, /contents: read[\s\S]+pull-requests: write/u);
  assert.doesNotMatch(reportJob, /id-token: write|secrets\./u);

  const releasePr = workflows.get('.github/workflows/release-pr.yml') || '';
  assert.match(releasePr, /types: \[closed\]/u);
  assert.match(releasePr, /group: authorize-release/u);
  assert.match(releasePr, /pull_request\.user\.login == github\.repository_owner/u);
  assert.match(releasePr, /pull_request\.user\.login == 'kintio-release\[bot\]'/u);
  assert.match(releasePr, /pull_request\.head\.ref == 'release\/next'/u);
  assert.match(releasePr, /pull_request\.merged_by\.login == github\.repository_owner/u);
  assert.match(releasePr, /pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(releasePr, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/v'\)/u);
  assert.match(releasePr, /actions: write[\s\S]+contents: write[\s\S]+pull-requests: write/u);
  assert.match(releasePr, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/u);
  assert.match(releasePr, /persist-credentials: false/u);
  assert.match(releasePr, /const required = \['CHANGELOG\.md', 'package\.json', 'src\/version\.ts'\]/u);
  assert.match(releasePr, /new Set\(\[\.\.\.required, 'SECURITY\.md'\]\)/u);
  assert.match(releasePr, /file\.status === 'renamed'/u);
  assert.match(releasePr, /'\/git\/tags'/u);
  assert.match(releasePr, /'\/git\/refs'/u);
  assert.match(releasePr, /'\/actions\/workflows\/release\.yml\/dispatches'/u);
  assert.match(releasePr, /workflow_runs\?\.find/u);
  assert.match(releasePr, /\.github\/scripts\/report-release\.ts/u);
  assert.match(releasePr, /Release PR changed package\.json beyond its version/u);
  assert.match(releasePr, /Release PR file enumeration is incomplete/u);
  assert.doesNotMatch(releasePr, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

test('release workflow inline modules remain syntactically executable', async () => {
  for (const [file, expected] of [
    ['.github/workflows/release.yml', 4],
    ['.github/workflows/release-pr.yml', 1],
  ] as const) {
    const workflow = await read(file);
    const modules = [...workflow.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/gmu,
    )].map((match) => (match[1] || '')
      .split('\n')
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n'));
    assert.equal(modules.length, expected, file);
    for (const [index, source] of modules.entries()) {
      const checked = spawnSync(
        process.execPath,
        ['--input-type=module', '--check'],
        { input: source, encoding: 'utf8' },
      );
      assert.equal(
        checked.status,
        0,
        `${file} inline module ${index + 1}: ${checked.stderr}`,
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
