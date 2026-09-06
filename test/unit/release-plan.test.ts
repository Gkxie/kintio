import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  buildReleasePlanFiles,
  freezeUnreleased,
  nextVersion,
  parseVersion,
  releaseNotes,
  unreleasedBody,
  validateFrozenChangelog,
  validateReleaseFiles,
  validateReleaseManifest,
} from '../../.github/scripts/release-plan.ts';

const packageSource = (version = '0.6.1', name = '@kin-tio/cli') => `${JSON.stringify({
  name,
  version,
  private: false,
}, undefined, 2)}\n`;

const runtimeSource = (version = '0.6.1') =>
  `export const KINTIO_VERSION = '${version}';\n`;

const changelogSource = (body = '- Fixed a user-visible problem.') => `# Changelog

## Unreleased

${body}

## 0.6.1 - 2026-08-31

- Previous release.
`;

describe('stable version planning', () => {
  test('parses stable SemVer and rejects non-stable or padded forms', () => {
    assert.deepEqual(parseVersion('12.3.45'), [12, 3, 45]);
    for (const invalid of ['v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3']) {
      assert.throws(() => parseVersion(invalid), /stable SemVer/u);
    }
  });

  test('uses patch for ordinary changes and ignores release chores', () => {
    assert.equal(nextVersion('0.6.1', [
      'fix(cli): recover setup',
      'docs: explain recovery',
      'chore(release)!: prepare v99.0.0',
    ]), '0.6.2');
  });

  test('uses minor for features or breaking changes during 0.x', () => {
    assert.equal(nextVersion('0.6.1', ['feat(cli): add a command']), '0.7.0');
    assert.equal(nextVersion('0.6.1', ['fix(config)!: replace a public key']), '0.7.0');
  });

  test('uses minor for features and major for breaking changes after 1.0', () => {
    assert.equal(nextVersion('1.4.2', ['feat(cli): add a command']), '1.5.0');
    assert.equal(nextVersion('1.4.2', ['fix(config)!: replace a public key']), '2.0.0');
  });
});

describe('Changelog freezing', () => {
  test('preserves continuation lines, links, and nested lists byte-for-byte', () => {
    const body = `- Added deterministic release planning.
  The continuation remains attached to the entry.
  ([#45](https://github.com/Gkxie/kintio/issues/45)).
  - Nested verification detail.`;
    const source = changelogSource(body);

    assert.equal(unreleasedBody(source), body);
    assert.equal(
      freezeUnreleased(source, '0.6.2'),
      `# Changelog

## Unreleased

## 0.6.2

${body}

## 0.6.1 - 2026-08-31

- Previous release.
`,
    );
  });

  test('rejects an empty Unreleased section or an indented-only nested item', () => {
    assert.throws(() => freezeUnreleased(changelogSource(''), '0.6.2'), /top-level/u);
    assert.throws(
      () => freezeUnreleased(changelogSource('  - Not a top-level entry.'), '0.6.2'),
      /top-level/u,
    );
  });

  test('rejects duplicate Unreleased sections', () => {
    const source = `${changelogSource()}\n## Unreleased\n\n- Duplicate.\n`;
    assert.throws(() => unreleasedBody(source), /exactly one/u);
  });

  test('rejects an existing target section, including dated history', () => {
    const source = `${changelogSource()}\n## 0.6.2 - 2026-09-01\n\n- Existing.\n`;
    assert.throws(() => freezeUnreleased(source, '0.6.2'), /already contains/u);
  });
});

describe('release plan files', () => {
  test('updates only the three release sources and returns the selected version', () => {
    const inputPackage = packageSource();
    const inputRuntime = runtimeSource();
    const inputChangelog = changelogSource('- Added a new capability.');
    const plan = buildReleasePlanFiles({
      packageSource: inputPackage,
      runtimeSource: inputRuntime,
      changelogSource: inputChangelog,
      subjects: ['feat(cli): expose release planning'],
    });

    assert.deepEqual(Object.keys(plan).sort(), [
      'changelogSource',
      'packageSource',
      'runtimeSource',
      'version',
    ]);
    assert.equal(plan.version, '0.7.0');
    assert.deepEqual(JSON.parse(plan.packageSource), {
      name: '@kin-tio/cli',
      version: '0.7.0',
      private: false,
    });
    assert.equal(plan.runtimeSource, "export const KINTIO_VERSION = '0.7.0';\n");
    assert.match(plan.changelogSource, /^## 0\.7\.0$/mu);
    assert.ok(plan.changelogSource.endsWith(
      '## 0.6.1 - 2026-08-31\n\n- Previous release.\n',
    ));
  });

  test('requires the public Kintio package identity', () => {
    assert.throws(() => buildReleasePlanFiles({
      packageSource: packageSource('0.6.1', 'kintio'),
      runtimeSource: runtimeSource(),
      changelogSource: changelogSource(),
      subjects: [],
    }), /name must be @kin-tio\/cli/u);
  });

  test('requires package and runtime versions to agree', () => {
    assert.throws(() => buildReleasePlanFiles({
      packageSource: packageSource('0.6.1'),
      runtimeSource: runtimeSource('0.6.0'),
      changelogSource: changelogSource(),
      subjects: [],
    }), /does not match runtime version/u);
  });

  test('requires the runtime version file to be exactly one constant line', () => {
    assert.throws(() => buildReleasePlanFiles({
      packageSource: packageSource(),
      runtimeSource: `${runtimeSource()}export const EXTRA = true;\n`,
      changelogSource: changelogSource(),
      subjects: [],
    }), /exactly one KINTIO_VERSION constant line/u);
  });
});

describe('release boundary files and manifests', () => {
  const files = ['CHANGELOG.md', 'package.json', 'src/version.ts']
    .map((filename) => ({ filename, status: 'modified' }));
  const manifest = () => ({
    version: '0.6.2',
    packageSource: packageSource('0.6.2'),
    runtimeSource: runtimeSource('0.6.2'),
    basePackageSource: packageSource('0.6.1'),
    baseRuntimeSource: runtimeSource('0.6.1'),
  });

  test('requires the three release files and permits an optional support-policy update', () => {
    assert.doesNotThrow(() => validateReleaseFiles(files));
    assert.doesNotThrow(() => validateReleaseFiles([
      ...files, { filename: 'SECURITY.md', status: 'modified' },
    ]));
    for (const missing of files) {
      assert.throws(() => validateReleaseFiles(files.filter((file) => file !== missing)), /must change/u);
    }
  });

  test('rejects renamed files and unrelated code or workflow changes', () => {
    assert.throws(() => validateReleaseFiles([
      ...files.slice(0, 2), { filename: 'src/version.ts', status: 'renamed' },
    ]), /rename/u);
    for (const filename of ['src/cli.ts', 'pnpm-lock.yaml', '.github/workflows/release.yml']) {
      assert.throws(() => validateReleaseFiles([...files, { filename, status: 'modified' }]), /changed/u);
    }
  });

  test('accepts a version-only manifest change and the canonical runtime constant', () => {
    assert.doesNotThrow(() => validateReleaseManifest(manifest()));
    assert.doesNotThrow(() => validateReleaseManifest({
      ...manifest(), baseRuntimeSource: 'export const KINTIO_VERSION = "0.6.1";\r\n',
    }));
  });

  test('rejects a changed package identity, extra manifest edits, and disagreement with the candidate version', () => {
    assert.throws(() => validateReleaseManifest({
      ...manifest(), packageSource: packageSource('0.6.2', 'other-package'),
    }), /identity/u);
    assert.throws(() => validateReleaseManifest({
      ...manifest(), packageSource: packageSource('0.6.3'),
    }), /identity/u);
    assert.throws(() => validateReleaseManifest({
      ...manifest(), packageSource: JSON.stringify({ ...JSON.parse(packageSource('0.6.2')), scripts: { postinstall: 'unexpected' } }),
    }), /beyond its version/u);
  });

  test('rejects a mismatched base runtime and changes outside the canonical new constant', () => {
    assert.throws(() => validateReleaseManifest({
      ...manifest(), baseRuntimeSource: runtimeSource('0.6.0'),
    }), /runtime/u);
    for (const source of [
      runtimeSource('0.6.3'),
      runtimeSource('0.6.2').replaceAll("'", '"'),
      runtimeSource('0.6.2').replaceAll('\n', '\r\n'),
      `${runtimeSource('0.6.2')}export const EXTRA = true;\n`,
    ]) {
      assert.throws(() => validateReleaseManifest({ ...manifest(), runtimeSource: source }), /runtime/u);
    }
  });
});

describe('frozen candidates and publication notes', () => {
  const frozen = () => freezeUnreleased(changelogSource('- Current release.'), '0.6.2');

  test('validates a dated or undated frozen section and produces its publication notes', () => {
    for (const source of [frozen(), frozen().replace('## 0.6.2\n', '## 0.6.2 - 2026-09-06\n')]) {
      assert.doesNotThrow(() => validateFrozenChangelog(source, '0.6.2'));
      assert.equal(releaseNotes(source, '0.6.2'), '- Current release.');
      assert.equal(releaseNotes(source, '0.6.2', '0.6.1'), '- Current release.');
      assert.equal(releaseNotes(source, '0.6.2', '0.6.2'), '- Current release.');
    }
  });

  test('preserves publication aggregation across an unpublished intermediate version', () => {
    const source = frozen().replace('- Previous release.', '- Earlier unpublished changes.\n\n## 0.6.0\n\n- Published already.');
    assert.equal(releaseNotes(source, '0.6.2', '0.6.0'),
      '- Current release.\n\n## 0.6.1 - 2026-08-31\n\n- Earlier unpublished changes.');
  });

  test('keeps empty-Unreleased enforcement at the frozen-candidate boundary', () => {
    const source = frozen().replace('## Unreleased\n', '## Unreleased\n\n- Future work.');
    assert.throws(() => validateFrozenChangelog(source, '0.6.2'), /empty Unreleased/u);
    assert.equal(releaseNotes(source, '0.6.2'), '- Current release.');
  });

  test('rejects duplicated or misplaced Unreleased and target sections at both boundaries', () => {
    for (const source of [
      frozen().replace('## Unreleased\n', ''),
      `${frozen()}\n## Unreleased\n`,
      `${frozen()}\n## 0.6.2 - 2026-09-06\n\n- Duplicate.`,
      frozen().replace('## Unreleased\n', '').replace('## 0.6.1', '## Unreleased\n\n## 0.6.1'),
    ]) {
      assert.throws(() => validateFrozenChangelog(source, '0.6.2'), /Unreleased|section/u);
      assert.throws(() => releaseNotes(source, '0.6.2'), /Unreleased|section/u);
    }
  });

  test('keeps frozen-entry validation distinct from trimmed, aggregated publication notes', () => {
    const source = frozen().replace('- Current release.', '  - Only nested detail.');
    assert.throws(() => validateFrozenChangelog(source, '0.6.2'), /entries/u);
    assert.equal(releaseNotes(source, '0.6.2'), '- Only nested detail.');
    const prose = frozen().replace('- Current release.', 'No release entries.');
    assert.throws(() => validateFrozenChangelog(prose, '0.6.2'), /entries/u);
    assert.throws(() => releaseNotes(prose, '0.6.2'), /entries/u);
    const withUnpublished = prose.replace('## 0.6.1', '## 0.6.0\n\n- Unpublished fix.\n\n## 0.6.1');
    assert.match(releaseNotes(withUnpublished, '0.6.2', '0.6.1'), /Unpublished fix/u);
  });

  test('rejects a missing, duplicated, or non-descending previously published section', () => {
    assert.throws(() => releaseNotes(frozen(), '0.6.2', '0.5.0'), /section/u);
    assert.throws(() => releaseNotes(`${frozen()}\n## 0.6.1\n\n- Duplicate.`, '0.6.2', '0.6.1'), /section/u);
    assert.throws(() => releaseNotes(frozen().replace('## 0.6.2', '## 0.6.3\n\n- Newer.\n\n## 0.6.2'), '0.6.2', '0.6.3'), /descending/u);
  });
});
