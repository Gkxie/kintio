import assert from 'node:assert/strict';
import { test } from 'vitest';

import { publishedChangelog } from '../../scripts/prepare-package.ts';

const source = (eol = '\n') => [
  '# Changelog',
  '',
  'This file records important user-visible changes after the first public release.',
  '',
  '## Unreleased',
  '',
  '- This change is not released.',
  '',
  '## 0.8.0',
  '',
  '- Current release.',
  '',
  '## 0.7.2 - 2026-09-01',
  '',
  '- Previous release.',
  '',
].join(eol);

test('published Changelog starts at the current version and preserves released history', () => {
  assert.equal(
    publishedChangelog(source(), '0.8.0'),
    `# Changelog

## 0.8.0

- Current release.

## 0.7.2 - 2026-09-01

- Previous release.
`,
  );
  const windows = publishedChangelog(source('\r\n'), '0.8.0');
  assert.equal(windows.includes('\r\n'), false);
  assert.equal(windows.includes('\n## Unreleased'), false);
});

test('published Changelog rejects an invalid heading or stale package version', () => {
  assert.throws(
    () => publishedChangelog(source().replace('# Changelog', '# Changes'), '0.8.0'),
    /must start/u,
  );
  assert.throws(() => publishedChangelog(source(), '0.8.1'), /newest released version/u);
  assert.throws(
    () => publishedChangelog(`${source()}\n## 0.8.0\n\n- Duplicate.\n`, '0.8.0'),
    /newest released version/u,
  );
});
