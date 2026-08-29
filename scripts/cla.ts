import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLA_CONTEXT = 'CLA';
export const CLA_SIGNATURE_PHRASE =
  'I have read the CLA Document and I hereby sign the CLA';
export const CLA_LEDGER_BRANCH = 'cla-signatures';
const CLA_LEDGER_VERSION = 1;
export const CLA_VERSION = '1.0';
const EMPTY_GIT_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_PULL_COMMITS = 250;
const MAX_REQUIRED_CONTRIBUTORS = 50;
const EXEMPT_BOT_IDS = new Set([
  49_699_333, // dependabot[bot]
  29_139_614, // renovate[bot]
]);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GITHUB_ACTIONS_BOT_ID = 41_898_282;
const REQUEST_MARKER_PREFIX = '<!-- kintio-cla:request:';
const SUCCESS_MARKER_PREFIX = '<!-- kintio-cla:success:';

interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly type?: string;
}

interface PullRequest {
  readonly number: number;
  readonly html_url: string;
  readonly head: { readonly sha: string };
  readonly user: GitHubUser;
  readonly commits: number;
  readonly draft?: boolean;
}

interface ContributorRequirement {
  readonly contributors: Contributor[];
  readonly hasUnlinkedAuthors: boolean;
}

interface PullCommit {
  readonly authors: readonly (GitHubUser | null)[];
  readonly hasUnlinkedAuthors: boolean;
}

interface IssueComment {
  readonly body: string;
  readonly user: GitHubUser;
}

export interface Contributor {
  readonly id: number;
  readonly login: string;
}

export interface ClaSignature {
  readonly version: number;
  readonly claVersion: string;
  readonly repositoryId: number;
  readonly githubUserId: number;
  readonly githubLogin: string;
  readonly claSha256: string;
  readonly claCommit: string;
  readonly claUrl: string;
  readonly signedAt: string;
  readonly commentId: number;
  readonly commentUrl: string;
  readonly pullRequest: number;
}

interface EventPayload {
  readonly action?: string;
  readonly repository: {
    readonly id: number;
    readonly full_name: string;
    readonly default_branch: string;
  };
  readonly pull_request?: { readonly number: number };
  readonly issue?: {
    readonly number: number;
    readonly pull_request?: unknown;
  };
  readonly comment?: {
    readonly id: number;
    readonly body: string;
    readonly created_at: string;
    readonly html_url: string;
    readonly author_association?: string;
    readonly user: GitHubUser;
  };
}

interface PullAuthorsConnection {
  readonly totalCount: number;
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: Array<{
    readonly commit: {
      readonly authors: {
        readonly totalCount: number;
        readonly nodes: Array<{
          readonly user: { readonly databaseId: number | null; readonly login: string } | null;
        }>;
      };
    };
  }>;
}

interface PullAuthorsQuery {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: { readonly commits: PullAuthorsConnection };
    };
  };
  readonly errors?: unknown[];
}

interface SignatureSnapshot {
  readonly revision: string;
  readonly changed: boolean;
  readonly records: ReadonlyMap<number, ClaSignature>;
}

type Fetch = typeof fetch;

class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function claSha256(document: string | Buffer): string {
  return crypto.createHash('sha256').update(document).digest('hex');
}

function parseSignatureRecord(content: string, target: string): ClaSignature {
  try {
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8')) as ClaSignature;
  } catch {
    throw new Error(`CLA signature record ${target} is invalid`);
  }
}

export function signatureBindingFromComment(
  body: string,
): { readonly commit: string; readonly hash: string } | undefined {
  const escaped = CLA_SIGNATURE_PHRASE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(
    `^${escaped}\\r?\\nCLA-COMMIT: ([0-9a-f]{40})\\r?\\nCLA-SHA256: ([0-9a-f]{64})(?:\\r?\\n)?$`,
    'u',
  ).exec(body);
  return match ? { commit: match[1] || '', hash: match[2] || '' } : undefined;
}

export function requiredContributors(
  opener: GitHubUser,
  commits: readonly PullCommit[],
): ContributorRequirement {
  const contributors = new Map<number, Contributor>();
  let hasUnlinkedAuthors = false;
  for (const commit of commits) {
    hasUnlinkedAuthors ||= commit.hasUnlinkedAuthors;
  }
  for (const user of [opener, ...commits.flatMap((commit) => commit.authors)]) {
    if (!user) {
      hasUnlinkedAuthors = true;
      continue;
    }
    if (EXEMPT_BOT_IDS.has(user.id)) continue;
    contributors.set(user.id, { id: user.id, login: user.login });
  }
  return {
    contributors: [...contributors.values()].sort((left, right) =>
      left.id - right.id
    ),
    hasUnlinkedAuthors,
  };
}

export function signatureCovers(
  signature: ClaSignature | undefined,
  input: {
    readonly repositoryId: number;
    readonly contributorId: number;
    readonly documentHash: string;
  },
): boolean {
  const immutableUrl = signature?.claCommit
    ? `https://github.com/Gkxie/kintio/blob/${signature.claCommit}/CLA.md`
    : '';
  const commentUrl = signature
    ? /^https:\/\/github\.com\/Gkxie\/kintio\/pull\/(\d+)#issuecomment-(\d+)$/u
      .exec(signature.commentUrl)
    : null;
  return Boolean(
    signature &&
    commentUrl &&
    signature.version === CLA_LEDGER_VERSION &&
    signature.claVersion === CLA_VERSION &&
    signature.repositoryId === input.repositoryId &&
    signature.githubUserId === input.contributorId &&
    signature.claSha256 === input.documentHash &&
    /^[0-9a-f]{40}$/u.test(signature.claCommit) &&
    signature.claUrl === immutableUrl &&
    Number.isFinite(Date.parse(signature.signedAt)) &&
    Number.isInteger(signature.commentId) &&
    signature.commentId > 0 &&
    Number.isInteger(signature.pullRequest) &&
    signature.pullRequest > 0 &&
    Number(commentUrl[1]) === signature.pullRequest &&
    Number(commentUrl[2]) === signature.commentId,
  );
}

class GitHubApi {
  readonly #fetch: Fetch;
  readonly #repository: string;
  readonly #token: string;

  constructor(input: { fetch: Fetch; repository: string; token: string }) {
    this.#fetch = input.fetch;
    this.#repository = input.repository;
    this.#token = input.token;
  }

  async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<T | undefined> {
    const response = await this.#fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kintio-cla',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API ${method} ${endpoint} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined;
    return await response.json() as T;
  }

  async pullRequest(number: number): Promise<PullRequest> {
    const value = await this.request<PullRequest>(
      'GET',
      `/repos/${this.#repository}/pulls/${number}`,
    );
    if (!value) throw new Error('Pull request response was empty');
    return value;
  }

  async openPullRequests(): Promise<Array<{
    number: number;
    head: { sha: string };
    draft?: boolean;
  }>> {
    const pulls: Array<{
      number: number;
      head: { sha: string };
      draft?: boolean;
    }> = [];
    for (let page = 1; page <= 100; page += 1) {
      const values = await this.request<Array<{
        number: number;
        head: { sha: string };
        draft?: boolean;
      }>>('GET', `/repos/${this.#repository}/pulls?state=open&per_page=100&page=${page}`);
      if (!values) throw new Error('Open pull requests response was empty');
      pulls.push(...values);
      if (values.length < 100) return pulls;
    }
    throw new Error('Open pull request pagination exceeded its safety limit');
  }

  async pullCommits(number: number, expectedCount: number): Promise<PullCommit[]> {
    if (expectedCount > MAX_PULL_COMMITS) {
      throw new Error(`Pull request has more than ${MAX_PULL_COMMITS} commits; squash it before CLA evaluation`);
    }
    const [owner, name] = this.#repository.split('/');
    if (!owner || !name) throw new Error('Invalid GitHub repository name');
    const commits: PullCommit[] = [];
    let after: string | null = null;
    for (let page = 1; page <= 100; page += 1) {
      const response: PullAuthorsQuery | undefined =
        await this.request<PullAuthorsQuery>('POST', '/graphql', {
        query: `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{commit{authors(first:100){totalCount nodes{user{databaseId login}}}}}}}}}`,
        variables: { owner, name, number, after },
      });
      if (!response || response.errors?.length) {
        throw new Error('GitHub GraphQL CLA author query failed');
      }
      const connection: PullAuthorsConnection | undefined =
        response.data?.repository?.pullRequest?.commits;
      if (!connection || connection.totalCount !== expectedCount) {
        throw new Error('Pull request commit count changed during CLA evaluation');
      }
      for (const node of connection.nodes) {
        const authors = node.commit.authors;
        commits.push({
          authors: authors.nodes.map((author) => {
            const user = author.user;
            return user?.databaseId
              ? { id: user.databaseId, login: user.login }
              : null;
          }),
          hasUnlinkedAuthors: authors.totalCount !== authors.nodes.length ||
            authors.nodes.some((author) => !author.user?.databaseId),
        });
      }
      if (!connection.pageInfo.hasNextPage) {
        if (commits.length !== expectedCount) {
          throw new Error('Pull request commit pagination is incomplete');
        }
        return commits;
      }
      after = connection.pageInfo.endCursor;
      if (!after) throw new Error('Pull request commit pagination cursor is missing');
    }
    throw new Error('Pull request commit pagination exceeded its safety limit');
  }

  async signature(userId: number): Promise<ClaSignature | undefined> {
    const target = `signatures/v${CLA_LEDGER_VERSION}/${userId}.json`;
    const value = await this.request<{ content: string }>(
      'GET',
      `/repos/${this.#repository}/contents/${target}?ref=${CLA_LEDGER_BRANCH}`,
      undefined,
      true,
    );
    if (!value) return undefined;
    return parseSignatureRecord(value.content, target);
  }

  async signatureSnapshot(
    userIds: readonly number[],
    previousRevision?: string,
  ): Promise<SignatureSnapshot> {
    const ref = await this.request<{
      object: { sha: string; type: string };
    }>('GET', `/repos/${this.#repository}/git/ref/heads/${CLA_LEDGER_BRANCH}`);
    if (!ref || ref.object.type !== 'commit') {
      throw new Error('CLA signature branch does not point to a commit');
    }
    if (ref.object.sha === previousRevision) {
      return { revision: ref.object.sha, changed: false, records: new Map() };
    }
    const commit = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${this.#repository}/git/commits/${ref.object.sha}`,
    );
    if (!commit) throw new Error('CLA signature commit is missing');
    let treeEntries: Array<{ path: string; type: string; sha: string }> = [];
    if (commit.tree.sha !== EMPTY_GIT_TREE_SHA) {
      const tree = await this.request<{
        sha: string;
        truncated: boolean;
        tree: Array<{ path: string; type: string; sha: string }>;
      }>(
        'GET',
        `/repos/${this.#repository}/git/trees/${commit.tree.sha}?recursive=1`,
      );
      if (!tree || tree.truncated || tree.sha !== commit.tree.sha) {
        throw new Error('CLA signature tree is missing or truncated');
      }
      treeEntries = tree.tree;
    }
    const blobs = new Map(
      treeEntries
        .filter((entry) => entry.type === 'blob')
        .map((entry) => [entry.path, entry.sha]),
    );
    const records = new Map<number, ClaSignature>();
    for (const userId of userIds) {
      const target = `signatures/v${CLA_LEDGER_VERSION}/${userId}.json`;
      const sha = blobs.get(target);
      if (!sha) continue;
      const blob = await this.request<{ content: string; encoding: string }>(
        'GET',
        `/repos/${this.#repository}/git/blobs/${sha}`,
      );
      if (!blob || blob.encoding !== 'base64') {
        throw new Error(`CLA signature blob ${target} is invalid`);
      }
      records.set(userId, parseSignatureRecord(blob.content, target));
    }
    return { revision: ref.object.sha, changed: true, records };
  }

  async claDocumentAt(commit: string): Promise<Buffer> {
    const value = await this.request<{ content: string }>(
      'GET',
      `/repos/${this.#repository}/contents/CLA.md?ref=${commit}`,
    );
    if (!value) throw new Error('CLA document response was empty');
    return Buffer.from(value.content, 'base64');
  }

  async saveSignature(signature: ClaSignature): Promise<void> {
    const target = `signatures/v${CLA_LEDGER_VERSION}/${signature.githubUserId}.json`;
    const content = Buffer.from(`${JSON.stringify(signature, null, 2)}\n`).toString('base64');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const existing = await this.request<{ sha: string; content: string }>(
        'GET',
        `/repos/${this.#repository}/contents/${target}?ref=${CLA_LEDGER_BRANCH}`,
        undefined,
        true,
      );
      if (existing) {
        try {
          const record = parseSignatureRecord(existing.content, target);
          if (signatureCovers(record, {
            repositoryId: signature.repositoryId,
            contributorId: signature.githubUserId,
            documentHash: signature.claSha256,
          }) &&
            record.commentId === signature.commentId &&
            record.claCommit === signature.claCommit &&
            record.signedAt === signature.signedAt
          ) return;
        } catch {
          throw new Error(`CLA signature record ${target} is invalid`);
        }
      }
      try {
        await this.request(
          'PUT',
          `/repos/${this.#repository}/contents/${target}`,
          {
            message: `cla: record signature for ${signature.githubLogin}`,
            content,
            branch: CLA_LEDGER_BRANCH,
            ...(existing ? { sha: existing.sha } : {}),
          },
        );
        return;
      } catch (error) {
        if (
          error instanceof GitHubApiError &&
          [409, 422].includes(error.status) &&
          attempt < 4
        ) continue;
        throw error;
      }
    }
  }

  async setStatus(input: {
    sha: string;
    state: 'pending' | 'success' | 'error';
    description: string;
    targetUrl: string;
  }): Promise<void> {
    await this.request(
      'POST',
      `/repos/${this.#repository}/statuses/${input.sha}`,
      {
        state: input.state,
        context: CLA_CONTEXT,
        description: input.description.slice(0, 140),
        target_url: input.targetUrl,
      },
    );
  }

  async comments(number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const values = await this.request<IssueComment[]>(
        'GET',
        `/repos/${this.#repository}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      if (!values) throw new Error('Issue comments response was empty');
      comments.push(...values);
      if (values.length < 100) return comments;
    }
    throw new Error('Pull request exceeds the CLA comment pagination limit');
  }

  async comment(number: number, body: string): Promise<void> {
    await this.request(
      'POST',
      `/repos/${this.#repository}/issues/${number}/comments`,
      { body },
    );
  }
}

async function evaluate(input: {
  api: GitHubApi;
  payload: EventPayload;
  pullRequest: PullRequest;
  documentHash: string;
  documentCommit: string;
  documentUrl: string;
  required?: ContributorRequirement;
}): Promise<void> {
  if (input.pullRequest.commits > MAX_PULL_COMMITS) {
    await input.api.setStatus({
      sha: input.pullRequest.head.sha,
      state: 'error',
      description: `CLA supports at most ${MAX_PULL_COMMITS} commits per pull request`,
      targetUrl: input.documentUrl,
    });
    return;
  }
  const required = input.required || requiredContributors(
    input.pullRequest.user,
    await input.api.pullCommits(
      input.pullRequest.number,
      input.pullRequest.commits,
    ),
  );
  if (required.contributors.length > MAX_REQUIRED_CONTRIBUTORS) {
    await input.api.setStatus({
      sha: input.pullRequest.head.sha,
      state: 'error',
      description: `CLA supports at most ${MAX_REQUIRED_CONTRIBUTORS} contributors per pull request`,
      targetUrl: input.documentUrl,
    });
    return;
  }
  const snapshot = await input.api.signatureSnapshot(
    required.contributors.map((contributor) => contributor.id),
  );
  const missing = required.contributors.filter((contributor) =>
    !signatureCovers(snapshot.records.get(contributor.id), {
        repositoryId: input.payload.repository.id,
        contributorId: contributor.id,
        documentHash: input.documentHash,
      })
  );

  const comments = await input.api.comments(input.pullRequest.number);
  const botComments = comments.filter((comment) =>
    comment.user.id === GITHUB_ACTIONS_BOT_ID &&
    comment.user.login === 'github-actions[bot]'
  );
  const requirementHash = claSha256([
    input.documentHash,
    required.contributors.map((contributor) => contributor.id).join(','),
    String(required.hasUnlinkedAuthors),
  ].join('\n'));
  const publishSuccess = async (): Promise<void> => {
    await input.api.setStatus({
      sha: input.pullRequest.head.sha,
      state: 'success',
      description: 'All required contributors signed the current CLA',
      targetUrl: input.documentUrl,
    });
    const marker = `${SUCCESS_MARKER_PREFIX}${requirementHash} -->`;
    if (!botComments.some((comment) => comment.body.includes(marker))) {
      await input.api.comment(
        input.pullRequest.number,
        `${marker}\nAll required contributors have signed the current CLA. ✅`,
      );
    }
  };
  if (missing.length === 0 && !required.hasUnlinkedAuthors) {
    await publishSuccess();
    return;
  }

  await input.api.setStatus({
    sha: input.pullRequest.head.sha,
    state: 'pending',
    description: required.hasUnlinkedAuthors
      ? 'A commit author is not linked to a GitHub account'
      : 'CLA signatures are required',
    targetUrl: input.documentUrl,
  });
  if (!required.hasUnlinkedAuthors) {
    const refreshed = await input.api.signatureSnapshot(
      missing.map((contributor) => contributor.id),
      snapshot.revision,
    );
    const stillMissing = refreshed.changed
      ? missing.filter((contributor) => !signatureCovers(
        refreshed.records.get(contributor.id),
        {
        repositoryId: input.payload.repository.id,
        contributorId: contributor.id,
        documentHash: input.documentHash,
        },
      ))
      : missing;
    if (stillMissing.length === 0) {
      await publishSuccess();
      return;
    }
    missing.splice(0, missing.length, ...stillMissing);
  }
  const marker = `${REQUEST_MARKER_PREFIX}${requirementHash} -->`;
  if (botComments.some((comment) => comment.body.includes(marker))) return;
  const mentions = missing.map((contributor) => `@${contributor.login}`).join(', ');
  const unlinked = required.hasUnlinkedAuthors
    ? '\n\nAt least one commit author is not linked to a GitHub account. Re-author that commit with a verified GitHub email before rechecking.'
    : '';
  await input.api.comment(
    input.pullRequest.number,
    `${marker}\nThank you for contributing. ${mentions || 'The contributors'} must read the [Contributor License Agreement](${input.documentUrl}) and each post this exact three-line comment:\n\n\`\`\`text\n${CLA_SIGNATURE_PHRASE}\nCLA-COMMIT: ${input.documentCommit}\nCLA-SHA256: ${input.documentHash}\n\`\`\`${unlinked}`,
  );
}

async function refreshOpenPullRequestsForUser(input: {
  api: GitHubApi;
  payload: EventPayload;
  userId: number;
  documentHash: string;
  documentCommit: string;
  documentUrl: string;
}): Promise<void> {
  const failures: string[] = [];
  for (const summary of await input.api.openPullRequests()) {
    if (summary.draft) continue;
    try {
      const pullRequest = await input.api.pullRequest(summary.number);
      if (pullRequest.draft) continue;
      const required = requiredContributors(
        pullRequest.user,
        await input.api.pullCommits(pullRequest.number, pullRequest.commits),
      );
      if (!required.contributors.some((user) => user.id === input.userId)) {
        continue;
      }
      await evaluate({
        api: input.api,
        payload: input.payload,
        pullRequest,
        documentHash: input.documentHash,
        documentCommit: input.documentCommit,
        documentUrl: input.documentUrl,
        required,
      });
    } catch {
      failures.push(`#${summary.number}`);
      try {
        await input.api.setStatus({
          sha: summary.head.sha,
          state: 'error',
          description: 'CLA evaluation failed; inspect the workflow log',
          targetUrl: input.documentUrl,
        });
      } catch {
        // Continue so one malformed pull request cannot block the others.
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`CLA refresh failed for ${failures.join(', ')}`);
  }
}

export async function runClaCheck(input: {
  fetch: Fetch;
  token: string;
  eventName: string;
  payload: EventPayload;
  document: Buffer;
  documentCommit: string;
  serverUrl?: string;
}): Promise<void> {
  const repository = input.payload.repository.full_name;
  const api = new GitHubApi({ fetch: input.fetch, repository, token: input.token });
  const pullNumber = input.payload.pull_request?.number || input.payload.issue?.number;
  if (!pullNumber) throw new Error('CLA event is not associated with a pull request');
  const documentHash = claSha256(input.document);
  if (!/^[0-9a-f]{40}$/u.test(input.documentCommit)) {
    throw new Error('CLA document commit must be a full Git commit SHA');
  }
  const serverUrl = input.serverUrl || 'https://github.com';
  const documentUrl = `${serverUrl}/${repository}/blob/${input.documentCommit}/CLA.md`;

  if (input.eventName === 'issue_comment') {
    const comment = input.payload.comment;
    if (!comment) throw new Error('CLA comment event is missing its comment');
    if (input.payload.action && input.payload.action !== 'created') return;
    const pullRequest = await api.pullRequest(pullNumber);
    if (pullRequest.draft) return;
    const commits = await api.pullCommits(pullRequest.number, pullRequest.commits);
    const required = requiredContributors(pullRequest.user, commits);
    const isContributor = required.contributors.some((user) => user.id === comment.user.id);
    const signed = signatureBindingFromComment(comment.body);
    if (signed) {
      if (!isContributor) return;
      if (signed.hash !== documentHash) {
        await evaluate({
          api,
          payload: input.payload,
          pullRequest,
          documentHash,
          documentCommit: input.documentCommit,
          documentUrl,
        });
        return;
      }
      const existing = await api.signature(comment.user.id);
      if (signatureCovers(existing, {
        repositoryId: input.payload.repository.id,
        contributorId: comment.user.id,
        documentHash,
      })) {
        if (existing?.commentId === comment.id) {
          await refreshOpenPullRequestsForUser({
            api,
            payload: input.payload,
            userId: comment.user.id,
            documentHash,
            documentCommit: input.documentCommit,
            documentUrl,
          });
        } else {
          await evaluate({
            api,
            payload: input.payload,
            pullRequest,
            documentHash,
            documentCommit: input.documentCommit,
            documentUrl,
            required,
          });
        }
        return;
      }
      if (claSha256(await api.claDocumentAt(signed.commit)) !== signed.hash) {
        throw new Error('Signed CLA commit does not contain the declared document hash');
      }
      const signedDocumentUrl = `${serverUrl}/${repository}/blob/${signed.commit}/CLA.md`;
      await api.saveSignature({
        version: CLA_LEDGER_VERSION,
        claVersion: CLA_VERSION,
        repositoryId: input.payload.repository.id,
        githubUserId: comment.user.id,
        githubLogin: comment.user.login,
        claSha256: documentHash,
        claCommit: signed.commit,
        claUrl: signedDocumentUrl,
        signedAt: comment.created_at,
        commentId: comment.id,
        commentUrl: comment.html_url,
        pullRequest: pullRequest.number,
      });
      await refreshOpenPullRequestsForUser({
        api,
        payload: input.payload,
        userId: comment.user.id,
        documentHash,
        documentCommit: input.documentCommit,
        documentUrl,
      });
      return;
    } else if (comment.body === 'recheck') {
      if (!TRUSTED_ASSOCIATIONS.has(comment.author_association || '')) return;
    } else {
      return;
    }
  }

  const pullRequest = await api.pullRequest(pullNumber);
  if (pullRequest.draft) return;
  await evaluate({
    api,
    payload: input.payload,
    pullRequest,
    documentHash,
    documentCommit: input.documentCommit,
    documentUrl,
  });
}

export async function runClaPreflight(input: {
  fetch: Fetch;
  token: string;
  eventName: string;
  payload: EventPayload;
  document: Buffer;
}): Promise<'none' | 'sign'> {
  if (input.eventName !== 'issue_comment' || !input.payload.issue?.pull_request) {
    return 'none';
  }
  const comment = input.payload.comment;
  if (!comment) return 'none';
  if (input.payload.action !== 'created') return 'none';
  const api = new GitHubApi({
    fetch: input.fetch,
    repository: input.payload.repository.full_name,
    token: input.token,
  });
  if (comment.body === 'recheck') {
    return TRUSTED_ASSOCIATIONS.has(comment.author_association || '')
      ? 'sign'
      : 'none';
  }
  const signed = signatureBindingFromComment(comment.body);
  const documentHash = claSha256(input.document);
  if (!signed || signed.hash !== documentHash) return 'none';
  const existing = await api.signature(comment.user.id);
  if (signatureCovers(existing, {
    repositoryId: input.payload.repository.id,
    contributorId: comment.user.id,
    documentHash,
  })) return existing?.commentId === comment.id ? 'sign' : 'none';
  const pullRequest = await api.pullRequest(input.payload.issue.number);
  if (pullRequest.draft) return 'none';
  const required = requiredContributors(
    pullRequest.user,
    await api.pullCommits(pullRequest.number, pullRequest.commits),
  );
  if (!required.contributors.some((user) => user.id === comment.user.id)) {
    return 'none';
  }
  try {
    if (claSha256(await api.claDocumentAt(signed.commit)) !== documentHash) {
      return 'none';
    }
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return 'none';
    throw error;
  }
  return 'sign';
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventPath || !token || !eventName) {
    throw new Error('GITHUB_EVENT_PATH, GITHUB_TOKEN, and GITHUB_EVENT_NAME are required');
  }
  const payload = JSON.parse(await fs.readFile(eventPath, 'utf8')) as EventPayload;
  if (process.argv[2] === 'preflight') {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required for CLA preflight');
    const document = await fs.readFile(path.resolve('CLA.md'));
    const mode = await runClaPreflight({
      fetch,
      token,
      eventName,
      payload,
      document,
    });
    await fs.appendFile(output, `mode=${mode}\n`);
    return;
  }
  const document = await fs.readFile(path.resolve('CLA.md'));
  const documentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  await runClaCheck({
    fetch,
    token,
    eventName,
    payload,
    document,
    documentCommit,
    ...(process.env.GITHUB_SERVER_URL
      ? { serverUrl: process.env.GITHUB_SERVER_URL }
      : {}),
  });
}

const entryPoint = process.argv[1]
  ? path.resolve(process.argv[1])
  : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CLA check failed');
    process.exitCode = 1;
  });
}
