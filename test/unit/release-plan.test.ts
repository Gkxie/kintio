import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  buildReleasePlanFiles,
  freezeUnreleased,
  nextVersion,
  parseVersion,
  unreleasedBody,
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

