import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  releaseCommentBody,
  type ReleaseReport,
  upsertReleaseComment,
} from '../../.github/scripts/report-release.ts';

const report = (state: ReleaseReport['state']): ReleaseReport => ({
  pullRequest: 56,
  repository: 'Gkxie/kintio',
  runUrl: 'https://github.com/Gkxie/kintio/actions/runs/123',
  state,
  token: 'test-token',
  version: '0.7.0',
});

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Release PR status comments', () => {
  test('renders one version marker and state-specific destinations', () => {
    const started = releaseCommentBody(report('started'));
    const succeeded = releaseCommentBody(report('succeeded'));
    const failed = releaseCommentBody(report('failed'));
    for (const body of [started, succeeded, failed]) {
      assert.equal(body.match(/kintio-release-status:v0\.7\.0/gu)?.length, 1);
      assert.match(body, /actions\/runs\/123/u);
      assert.doesNotMatch(body, /test-token/u);
    }
    assert.match(started, /will be updated/u);
    assert.match(succeeded, /npmjs\.com.*cli\/v\/0\.7\.0/u);
    assert.match(succeeded, /releases\/tag\/v0\.7\.0/u);
    assert.match(failed, /did not complete successfully/u);
  });

  test('creates once and updates the same bot comment on retry', async () => {
    const calls: Array<{ body?: string; method: string; url: string }> = [];
    let stored: Record<string, unknown> | undefined;
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method || 'GET');
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (method === 'GET') return response(stored ? [stored] : []);
      if (method === 'POST') {
        stored = {
          id: 99,
          user: { login: 'github-actions[bot]' },
          body: JSON.parse(body || '{}').body,
        };
        return response(stored, 201);
      }
      if (method === 'PATCH') {
        stored = { ...stored, body: JSON.parse(body || '{}').body };
        return response(stored);
      }
      throw new Error(`unexpected ${method}`);
    };

    assert.equal(await upsertReleaseComment(report('started'), request), 'created');
    assert.equal(await upsertReleaseComment(report('succeeded'), request), 'updated');
    assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST', 'GET', 'PATCH']);
    assert.match(String(stored?.body), /Publication completed successfully/u);
  });

  test('leaves other versions and foreign markers alone but rejects duplicate bot records', async () => {
    for (const [comments, expected] of [
      [[
        { id: 1, user: { login: 'github-actions[bot]' }, body: 'unrelated' },
        { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- kintio-release-status:v0.6.2 -->' },
      ], 'created'],
      [[
        { id: 1, user: { login: 'github-actions[bot]' }, body: '<!-- kintio-release-status:v0.7.0 -->' },
        { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- kintio-release-status:v0.7.0 -->' },
      ], 'duplicate'],
      [[
        { id: 1, user: { login: 'someone-else' }, body: '<!-- kintio-release-status:v0.7.0 -->' },
      ], 'created'],
    ] as const) {
      const request: typeof fetch = async (_input, init) => {
        if ((init?.method || 'GET') === 'GET') return response(comments);
        return response({ id: 3 }, 201);
      };
      if (expected === 'created') {
        assert.equal(await upsertReleaseComment(report('started'), request), 'created');
      } else {
        await assert.rejects(
          () => upsertReleaseComment(report('started'), request),
          /duplicate status comments/u,
        );
      }
    }
  });

  test('fails closed on malformed identity, URL, API response, or comment ID', async () => {
    const validRequest: typeof fetch = async () => response([]);
    await assert.rejects(
      () => upsertReleaseComment({ ...report('started'), pullRequest: 0 }, validRequest),
      /PR number/u,
    );
    await assert.rejects(
      () => upsertReleaseComment({ ...report('started'), runUrl: 'http://example.com' }, validRequest),
      /workflow URL/u,
    );
    await assert.rejects(
      () => upsertReleaseComment(report('started'), async () => response({})),
      /comment list/u,
    );
    await assert.rejects(
      () => upsertReleaseComment(report('started'), async (_input, init) =>
        (init?.method || 'GET') === 'GET'
          ? response([{
              id: 'bad',
              user: { login: 'github-actions[bot]' },
              body: '<!-- kintio-release-status:v0.7.0 -->',
            }])
          : response({})),
      /existing Release status comment/u,
    );
  });
});
