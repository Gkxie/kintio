import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  CLA_SIGNATURE_PHRASE,
  claSha256,
  runClaCheck,
  runClaPreflight,
} from '../../scripts/cla.ts';

const repository = {
  id: 101,
  full_name: 'Gkxie/kintio',
  default_branch: 'master',
};
const pullRequest = {
  number: 17,
  html_url: 'https://github.com/Gkxie/kintio/pull/17',
  head: { sha: 'a'.repeat(40) },
  user: { id: 202, login: 'contributor', type: 'User' },
  commits: 1,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function signatureBlob(record: Record<string, unknown>): Response {
  return json({
    content: Buffer.from(JSON.stringify(record)).toString('base64'),
    encoding: 'base64',
  });
}

function ledgerResponse(
  url: URL,
  record?: Record<string, unknown>,
  revision = record ? 'commit-signed' : 'commit-empty',
): Response | undefined {
  const treeSha = record
    ? 'tree-with-signature'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  if (url.pathname.endsWith('/git/ref/heads/cla-signatures')) {
    return json({ object: { sha: revision, type: 'commit' } });
  }
  if (url.pathname.endsWith(`/git/commits/${revision}`)) {
    return json({ tree: { sha: treeSha } });
  }
  if (record && url.pathname.endsWith(`/git/trees/${treeSha}`)) {
    return json({
      sha: treeSha,
      truncated: false,
      tree: [{ path: 'signatures/v1/202.json', type: 'blob', sha: 'signature-202' }],
    });
  }
  if (record && url.pathname.endsWith('/git/blobs/signature-202')) {
    return signatureBlob(record);
  }
  return undefined;
}

function authorQueryResult() {
  return {
    data: {
      repository: {
        pullRequest: {
          commits: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              commit: {
                authors: {
                  totalCount: 1,
                  nodes: [{
                    user: {
                      databaseId: pullRequest.user.id,
                      login: pullRequest.user.login,
                    },
                  }],
                },
              },
            }],
          },
        },
      },
    },
  };
}

test('an unsigned pull request on the empty ledger receives one pending status and signing prompt', async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls') && url.searchParams.get('state') === 'open') {
      return json([pullRequest]);
    }
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    const ledger = ledgerResponse(url);
    if (ledger) return ledger;
    if (url.pathname.includes('/contents/signatures/')) return json({}, 404);
    if (url.pathname.endsWith('/issues/17/comments') && method === 'GET') {
      const requirementHash = claSha256([
        claSha256('test CLA'),
        String(pullRequest.user.id),
        'false',
      ].join('\n'));
      return json([{
        body: `<!-- kintio-cla:request:${requirementHash} -->`,
        user: { id: 303, login: 'attacker', type: 'User' },
      }]);
    }
    if (url.pathname.endsWith(`/statuses/${pullRequest.head.sha}`)) {
      statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    if (url.pathname.endsWith('/issues/17/comments') && method === 'POST') {
      comments.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });

  assert.equal(statuses[0]?.state, 'pending');
  assert.equal(statuses[0]?.context, 'CLA');
  assert.match(String(comments[0]?.body), new RegExp(CLA_SIGNATURE_PHRASE));
});

test('a contributor comment records the document hash and makes the CLA status successful', async () => {
  const document = Buffer.from('test CLA');
  let stored: Record<string, unknown> | undefined;
  let ledgerPutAttempts = 0;
  const statuses: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls') && url.searchParams.get('state') === 'open') {
      return json([
        { number: 17, head: pullRequest.head },
        { number: 18, head: { sha: 'd'.repeat(40) } },
        { number: 20, head: { sha: 'f'.repeat(40) }, draft: true },
      ]);
    }
    if (url.pathname.endsWith('/pulls/18')) {
      return json({ ...pullRequest, number: 18, head: { sha: 'd'.repeat(40) } });
    }
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    const ledger = ledgerResponse(
      url,
      stored,
      stored ? 'commit-signed' : 'commit-empty',
    );
    if (ledger) return ledger;
    if (url.pathname.endsWith('/contents/CLA.md')) {
      return json({ content: document.toString('base64') });
    }
    if (url.pathname.includes('/contents/signatures/')) {
      if (method === 'GET') {
        return stored
          ? json({ content: Buffer.from(JSON.stringify(stored)).toString('base64') })
          : json({}, 404);
      }
      const request = JSON.parse(String(init?.body)) as { content: string; branch: string };
      assert.equal(request.branch, 'cla-signatures');
      ledgerPutAttempts += 1;
      if (ledgerPutAttempts === 1) return json({}, 409);
      stored = JSON.parse(Buffer.from(request.content, 'base64').toString('utf8')) as Record<string, unknown>;
      return json({}, 201);
    }
    if (/\/issues\/(?:17|18)\/comments$/u.test(url.pathname) && method === 'GET') {
      return json([]);
    }
    if (url.pathname.includes('/statuses/')) {
      statuses.push({
        ...JSON.parse(String(init?.body)) as Record<string, unknown>,
        sha: url.pathname.split('/').at(-1),
      });
      return json({}, 201);
    }
    if (/\/issues\/(?:17|18)\/comments$/u.test(url.pathname) && method === 'POST') {
      comments.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  const check = {
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 404,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}\n`,
        created_at: '2026-08-29T00:00:00Z',
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-404',
        author_association: 'CONTRIBUTOR',
        user: pullRequest.user,
      },
    },
    document,
    documentCommit: 'c'.repeat(40),
  } as const;
  await runClaCheck(check);
  await runClaCheck(check);

  assert.equal(stored?.githubUserId, pullRequest.user.id);
  assert.equal(stored?.claSha256, claSha256(document));
  assert.equal(stored?.claCommit, 'b'.repeat(40));
  assert.equal(ledgerPutAttempts, 2);
  assert.deepEqual(
    statuses.slice(0, 2).map((status) => [status.sha, status.state]),
    [[pullRequest.head.sha, 'success'], ['d'.repeat(40), 'success']],
  );
  assert.match(String(comments.at(-1)?.body), /All required contributors/u);
});

test('CLA evaluation publishes an error before querying authors for more than 250 commits', async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/17')) {
      return json({ ...pullRequest, commits: 251 });
    }
    if (url.pathname.includes('/statuses/')) {
      statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };
  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });
  assert.equal(statuses[0]?.state, 'error');
  assert.match(String(statuses[0]?.description), /at most 250 commits/u);
});

test('CLA signing rejects a commit whose document bytes do not match the signed hash', async () => {
  const document = Buffer.from('current CLA');
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    if (url.pathname.includes('/contents/signatures/')) return json({}, 404);
    if (url.pathname.endsWith('/contents/CLA.md')) {
      return json({ content: Buffer.from('different CLA').toString('base64') });
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };
  await assert.rejects(
    runClaCheck({
      fetch: fakeFetch,
      token: 'test-token',
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        repository,
        issue: { number: 17, pull_request: {} },
        comment: {
          id: 405,
          body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
          created_at: '2026-08-29T00:00:00Z',
          html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-2',
          author_association: 'CONTRIBUTOR',
          user: pullRequest.user,
        },
      },
      document,
      documentCommit: 'c'.repeat(40),
    }),
    /does not contain the declared document hash/u,
  );
});

test('CLA evaluation fails closed before ledger reads for more than 50 contributors', async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const authors = Array.from({ length: 51 }, (_, index) => ({
    user: { databaseId: index + 1, login: `contributor-${index + 1}` },
  }));
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') {
      return json({
        data: {
          repository: {
            pullRequest: {
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ commit: { authors: { totalCount: 51, nodes: authors } } }],
              },
            },
          },
        },
      });
    }
    if (url.pathname.includes('/statuses/')) {
      statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });

  assert.equal(statuses[0]?.state, 'error');
  assert.match(String(statuses[0]?.description), /at most 50 contributors/u);
});

test('50 unsigned contributors use one ledger snapshot instead of 50 record reads', async () => {
  const authors = Array.from({ length: 49 }, (_, index) => ({
    user: { databaseId: index + 1, login: `coauthor-${index + 1}` },
  }));
  const ledgerRequests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') {
      return json({
        data: {
          repository: {
            pullRequest: {
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ commit: { authors: { totalCount: 49, nodes: authors } } }],
              },
            },
          },
        },
      });
    }
    const ledger = ledgerResponse(url);
    if (ledger) {
      ledgerRequests.push(url.pathname);
      return ledger;
    }
    if (url.pathname.endsWith('/issues/17/comments') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/issues/17/comments') && method === 'POST') return json({}, 201);
    if (url.pathname.includes('/statuses/')) return json({}, 201);
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });

  assert.deepEqual(ledgerRequests, [
    '/repos/Gkxie/kintio/git/ref/heads/cla-signatures',
    '/repos/Gkxie/kintio/git/commits/commit-empty',
    '/repos/Gkxie/kintio/git/ref/heads/cla-signatures',
  ]);
});

test('CLA comment preflight admits only authenticated state-changing events', async () => {
  const document = Buffer.from('test CLA');
  let existingSignature: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    if (url.pathname.includes('/contents/signatures/')) {
      return existingSignature
        ? json({ content: Buffer.from(JSON.stringify(existingSignature)).toString('base64') })
        : json({}, 404);
    }
    if (url.pathname.endsWith('/contents/CLA.md')) {
      return json({ content: document.toString('base64') });
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };
  const common = {
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'issue_comment',
    document,
  } as const;
  const createdAt = '2026-08-29T00:00:00Z';

  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 405,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-2',
        user: pullRequest.user,
      },
    },
  }), 'sign');
  existingSignature = {
    version: 1,
    claVersion: '1.0',
    repositoryId: repository.id,
    githubUserId: pullRequest.user.id,
    githubLogin: pullRequest.user.login,
    claSha256: claSha256(document),
    claCommit: 'b'.repeat(40),
    claUrl: `https://github.com/Gkxie/kintio/blob/${'b'.repeat(40)}/CLA.md`,
    signedAt: createdAt,
    commentId: 405,
    commentUrl: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-405',
    pullRequest: 17,
  };
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 410,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-7',
        user: pullRequest.user,
      },
    },
  }), 'none');
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 405,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-405',
        user: pullRequest.user,
      },
    },
  }), 'sign');
  existingSignature = undefined;
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 406,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-3',
        user: { id: 303, login: 'not-a-contributor', type: 'User' },
      },
    },
  }), 'none');
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 407,
        body: 'recheck',
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-4',
        author_association: 'OWNER',
        user: { id: 1, login: 'owner', type: 'User' },
      },
    },
  }), 'sign');
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 408,
        body: 'recheck',
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-5',
        author_association: 'NONE',
        user: { id: 2, login: 'attacker', type: 'User' },
      },
    },
  }), 'none');
  assert.equal(await runClaPreflight({
    ...common,
    payload: {
      action: 'edited',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 409,
        body: CLA_SIGNATURE_PHRASE,
        created_at: createdAt,
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-6',
        user: pullRequest.user,
      },
    },
  }), 'none');
});

test('CLA preflight keeps invalid document bindings out of the writer queue', async () => {
  const document = Buffer.from('test CLA');
  const documentHash = claSha256(document);
  const validCommit = 'b'.repeat(40);
  const missingCommit = 'd'.repeat(40);
  const mismatchedCommit = 'e'.repeat(40);
  const inspectedCommits: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/contents/signatures/')) return json({}, 404);
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    if (url.pathname.endsWith('/contents/CLA.md')) {
      const commit = url.searchParams.get('ref') || '';
      inspectedCommits.push(commit);
      if (commit === missingCommit) return json({}, 404);
      return json({
        content: (commit === mismatchedCommit
          ? Buffer.from('different CLA')
          : document).toString('base64'),
      });
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };
  const payload = (id: number, commit: string, hash = documentHash) => ({
    action: 'created',
    repository,
    issue: { number: 17, pull_request: {} },
    comment: {
      id,
      body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${commit}\nCLA-SHA256: ${hash}`,
      created_at: '2026-08-29T00:00:00Z',
      html_url: `https://github.com/Gkxie/kintio/pull/17#issuecomment-${id}`,
      user: pullRequest.user,
    },
  });
  const check = (eventPayload: ReturnType<typeof payload>) => runClaPreflight({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'issue_comment',
    document,
    payload: eventPayload,
  });

  assert.equal(await check(payload(420, validCommit, 'f'.repeat(64))), 'none');
  assert.equal(await check(payload(421, missingCommit)), 'none');
  assert.equal(await check(payload(422, mismatchedCommit)), 'none');
  assert.equal(await check(payload(423, validCommit)), 'sign');
  assert.deepEqual(inspectedCommits, [
    missingCommit,
    mismatchedCommit,
    validCommit,
  ]);
});

test('a draft pull request cannot enter CLA comment processing', async () => {
  const document = Buffer.from('test CLA');
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.includes('/contents/signatures/')) return json({}, 404);
    if (url.pathname.endsWith('/pulls/17')) {
      return json({ ...pullRequest, draft: true });
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };

  assert.equal(await runClaPreflight({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'issue_comment',
    document,
    payload: {
      action: 'created',
      repository,
      issue: { number: 17, pull_request: {} },
      comment: {
        id: 413,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: '2026-08-29T00:00:00Z',
        html_url: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-413',
        user: pullRequest.user,
      },
    },
  }), 'none');
  assert.deepEqual(requests, [
    '/repos/Gkxie/kintio/contents/signatures/v1/202.json',
    '/repos/Gkxie/kintio/pulls/17',
  ]);
});

test('live draft state stops evaluation after a non-draft event snapshot', async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith('/pulls/17')) {
      return json({ ...pullRequest, draft: true });
    }
    throw new Error(`Unexpected CLA request: ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });

  assert.deepEqual(requests, ['/repos/Gkxie/kintio/pulls/17']);
});

test('a failed open pull refresh does not block later pull requests after signing', async () => {
  const document = Buffer.from('test CLA');
  const signingPull = {
    ...pullRequest,
    number: 19,
    head: { sha: 'e'.repeat(40) },
  };
  let stored: Record<string, unknown> | undefined;
  const statuses: Array<{ sha: string; state: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls') && url.searchParams.get('state') === 'open') {
      return json([
        { number: 17, head: pullRequest.head },
        { number: 18, head: { sha: 'd'.repeat(40) } },
      ]);
    }
    if (url.pathname.endsWith('/pulls/19')) return json(signingPull);
    if (url.pathname.endsWith('/pulls/17')) {
      return json({ ...pullRequest, commits: 251 });
    }
    if (url.pathname.endsWith('/pulls/18')) {
      return json({ ...pullRequest, number: 18, head: { sha: 'd'.repeat(40) } });
    }
    if (url.pathname === '/graphql') return json(authorQueryResult());
    if (url.pathname.endsWith('/contents/CLA.md')) {
      return json({ content: document.toString('base64') });
    }
    if (url.pathname.includes('/contents/signatures/')) {
      if (method === 'GET') {
        return stored
          ? json({ content: Buffer.from(JSON.stringify(stored)).toString('base64') })
          : json({}, 404);
      }
      const request = JSON.parse(String(init?.body)) as { content: string };
      stored = JSON.parse(
        Buffer.from(request.content, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      return json({}, 201);
    }
    const ledger = ledgerResponse(
      url,
      stored,
      stored ? 'commit-signed' : 'commit-empty',
    );
    if (ledger) return ledger;
    if (url.pathname.endsWith('/issues/18/comments') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/issues/18/comments') && method === 'POST') return json({}, 201);
    if (url.pathname.includes('/statuses/')) {
      const body = JSON.parse(String(init?.body)) as { state: unknown };
      statuses.push({ sha: url.pathname.split('/').at(-1) || '', state: body.state });
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  await assert.rejects(runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      repository,
      issue: { number: 19, pull_request: {} },
      comment: {
        id: 411,
        body: `${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${'b'.repeat(40)}\nCLA-SHA256: ${claSha256(document)}`,
        created_at: '2026-08-29T00:00:00Z',
        html_url: 'https://github.com/Gkxie/kintio/pull/19#issuecomment-411',
        user: pullRequest.user,
      },
    },
    document,
    documentCommit: 'c'.repeat(40),
  }), /CLA refresh failed for #17/u);

  assert.deepEqual(statuses, [
    { sha: pullRequest.head.sha, state: 'error' },
    { sha: 'd'.repeat(40), state: 'success' },
  ]);
});

test('GraphQL pagination includes co-authors and fails closed for an unlinked author', async () => {
  const pagedPull = { ...pullRequest, commits: 101 };
  const statuses: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const cursors: unknown[] = [];
  const linkedNode = {
    commit: {
      authors: {
        totalCount: 1,
        nodes: [{ user: { databaseId: 202, login: 'contributor' } }],
      },
    },
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls/17')) return json(pagedPull);
    if (url.pathname === '/graphql') {
      const request = JSON.parse(String(init?.body)) as {
        variables: { after: unknown };
      };
      cursors.push(request.variables.after);
      if (request.variables.after === null) {
        return json({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  totalCount: 101,
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                  nodes: Array.from({ length: 100 }, () => linkedNode),
                },
              },
            },
          },
        });
      }
      return json({
        data: {
          repository: {
            pullRequest: {
              commits: {
                totalCount: 101,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  commit: {
                    authors: {
                      totalCount: 2,
                      nodes: [
                        { user: { databaseId: 303, login: 'coauthor' } },
                        { user: null },
                      ],
                    },
                  },
                }],
              },
            },
          },
        },
      });
    }
    if (url.pathname.includes('/contents/signatures/')) return json({}, 404);
    const ledger = ledgerResponse(url);
    if (ledger) return ledger;
    if (url.pathname.endsWith('/issues/17/comments') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/issues/17/comments') && method === 'POST') {
      comments.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    if (url.pathname.includes('/statuses/')) {
      statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document: Buffer.from('test CLA'),
    documentCommit: 'b'.repeat(40),
  });

  assert.deepEqual(cursors, [null, 'cursor-1']);
  assert.equal(statuses[0]?.state, 'pending');
  assert.match(String(statuses[0]?.description), /not linked/u);
  assert.match(String(comments[0]?.body), /@contributor, @coauthor/u);
  assert.match(String(comments[0]?.body), /not linked to a GitHub account/u);
});

test('a signature that appears during evaluation wins over an older pending result', async () => {
  const document = Buffer.from('test CLA');
  const signature = {
    version: 1,
    claVersion: '1.0',
    repositoryId: repository.id,
    githubUserId: pullRequest.user.id,
    githubLogin: pullRequest.user.login,
    claSha256: claSha256(document),
    claCommit: 'b'.repeat(40),
    claUrl: `https://github.com/Gkxie/kintio/blob/${'b'.repeat(40)}/CLA.md`,
    signedAt: '2026-08-29T00:00:00Z',
    commentId: 412,
    commentUrl: 'https://github.com/Gkxie/kintio/pull/17#issuecomment-412',
    pullRequest: 17,
  };
  let pendingPublished = false;
  const statuses: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname.endsWith('/pulls/17')) return json(pullRequest);
    if (url.pathname === '/graphql') return json(authorQueryResult());
    const ledger = ledgerResponse(
      url,
      pendingPublished ? signature : undefined,
      pendingPublished ? 'commit-signed' : 'commit-empty',
    );
    if (ledger) return ledger;
    if (url.pathname.endsWith('/issues/17/comments') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/issues/17/comments') && method === 'POST') return json({}, 201);
    if (url.pathname.includes('/statuses/')) {
      const body = JSON.parse(String(init?.body)) as { state: string };
      statuses.push(body.state);
      pendingPublished ||= body.state === 'pending';
      return json({}, 201);
    }
    throw new Error(`Unexpected CLA request: ${method} ${url.pathname}`);
  };

  await runClaCheck({
    fetch: fakeFetch,
    token: 'test-token',
    eventName: 'pull_request_target',
    payload: { repository, pull_request: { number: 17 } },
    document,
    documentCommit: 'b'.repeat(40),
  });

  assert.deepEqual(statuses, ['pending', 'success']);
});
