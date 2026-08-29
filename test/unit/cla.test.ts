import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'vitest';

import {
  CLA_SIGNATURE_PHRASE,
  CLA_VERSION,
  claSha256,
  requiredContributors,
  signatureBindingFromComment,
  signatureCovers,
} from '../../scripts/cla.ts';

test('CLA document title and evaluator use the same version', async () => {
  const document = await fs.readFile('CLA.md', 'utf8');
  assert.match(document, new RegExp(`Agreement \\(v${CLA_VERSION}\\)`, 'u'));
});

test('CLA hash is deterministic and the signature phrase stays exact', () => {
  assert.deepEqual(
    claSha256('agreement\n'),
    'cc1255d8a184b123a12f8188cf7d6815f88dbcea94d9655dc0c4d65ae5d62e8e',
  );
  assert.equal(
    CLA_SIGNATURE_PHRASE,
    'I have read the CLA Document and I hereby sign the CLA',
  );
  assert.deepEqual(
    signatureBindingFromComment(
      `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${'a'.repeat(64)}`,
    ),
    { commit: 'b'.repeat(40), hash: 'a'.repeat(64) },
  );
  assert.deepEqual(
    signatureBindingFromComment(
      `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${'a'.repeat(64)}\n`,
    ),
    { commit: 'b'.repeat(40), hash: 'a'.repeat(64) },
  );
  assert.equal(
    signatureBindingFromComment(
      `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${'a'.repeat(64)}\n\n`,
    ),
    undefined,
  );
  assert.equal(signatureBindingFromComment(CLA_SIGNATURE_PHRASE), undefined);
});

test('CLA contributor discovery deduplicates people, ignores bots, and flags unlinked authors', () => {
  const result = requiredContributors(
    { id: 7, login: 'opener', type: 'User' },
    [
      {
        authors: [{ id: 7, login: 'opener', type: 'User' }],
        hasUnlinkedAuthors: false,
      },
      {
        authors: [{ id: 8, login: 'coauthor', type: 'User' }],
        hasUnlinkedAuthors: false,
      },
      {
        authors: [{ id: 49_699_333, login: 'dependabot[bot]', type: 'Bot' }],
        hasUnlinkedAuthors: false,
      },
      { authors: [null], hasUnlinkedAuthors: true },
    ],
  );
  assert.deepEqual(result.contributors, [
    { id: 7, login: 'opener' },
    { id: 8, login: 'coauthor' },
  ]);
  assert.equal(result.hasUnlinkedAuthors, true);
});

test('CLA signatures bind repository, immutable user ID, and document hash', () => {
  const signature = {
    version: 1,
    claVersion: '1.0',
    repositoryId: 11,
    githubUserId: 22,
    githubLogin: 'contributor-before-rename',
    claSha256: 'a'.repeat(64),
    claCommit: 'c'.repeat(40),
    claUrl: `https://github.com/Gkxie/kintio/blob/${'c'.repeat(40)}/CLA.md`,
    signedAt: '2026-08-29T00:00:00Z',
    commentId: 1,
    commentUrl: 'https://github.com/Gkxie/kintio/pull/1#issuecomment-1',
    pullRequest: 1,
  };
  assert.equal(signatureCovers(signature, {
    repositoryId: 11,
    contributorId: 22,
    documentHash: 'a'.repeat(64),
  }), true);
  assert.equal(signatureCovers(signature, {
    repositoryId: 11,
    contributorId: 22,
    documentHash: 'b'.repeat(64),
  }), false);
  assert.equal(signatureCovers({
    ...signature,
    commentUrl: 'https://github.com/Gkxie/kintio/pull/2#issuecomment-1',
  }, {
    repositoryId: 11,
    contributorId: 22,
    documentHash: 'a'.repeat(64),
  }), false);
});
