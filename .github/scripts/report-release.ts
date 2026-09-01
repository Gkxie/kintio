import { pathToFileURL } from 'node:url';

export type ReleaseReportState = 'started' | 'succeeded' | 'failed';

export interface ReleaseReport {
  pullRequest: number;
  repository: string;
  runUrl: string;
  state: ReleaseReportState;
  token: string;
  version: string;
}

interface CommentRecord {
  body?: unknown;
  id?: unknown;
  user?: { login?: unknown };
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BOT_LOGIN = 'github-actions[bot]';

function marker(version: string): string {
  return `<!-- kintio-release-status:v${version} -->`;
}

function assertReport(report: ReleaseReport): void {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(report.repository)) {
    throw new Error('invalid GitHub repository');
  }
  if (!Number.isSafeInteger(report.pullRequest) || report.pullRequest < 1) {
    throw new Error('invalid Release PR number');
  }
  if (!VERSION.test(report.version)) throw new Error('invalid release version');
  if (!['started', 'succeeded', 'failed'].includes(report.state)) {
    throw new Error('invalid release report state');
  }
  const runUrl = new URL(report.runUrl);
  if (runUrl.protocol !== 'https:' || !runUrl.pathname.includes('/actions/')) {
    throw new Error('invalid Release workflow URL');
  }
  if (!report.token) throw new Error('GitHub token is required');
}

export function releaseCommentBody({
  repository,
  runUrl,
  state,
  version,
}: Omit<ReleaseReport, 'pullRequest' | 'token'>): string {
  if (!VERSION.test(version)) throw new Error('invalid release version');
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
  const encodedVersion = encodeURIComponent(version);
  const run = `[Release workflow](${runUrl})`;
  const heading = `### Release \`v${version}\``;
  if (state === 'started') {
    return `${marker(version)}\n${heading}\n\n` +
      `⏳ Publication has started. Follow ${run} for live progress.\n\n` +
      'This comment will be updated when the workflow reaches a terminal state.\n';
  }
  if (state === 'failed') {
    return `${marker(version)}\n${heading}\n\n` +
      `❌ Publication did not complete successfully. Inspect ${run} before retrying.\n`;
  }
  return `${marker(version)}\n${heading}\n\n` +
    `✅ Publication completed successfully.\n\n` +
    `- ${run}\n` +
    `- [npm package](https://www.npmjs.com/package/@kin-tio/cli/v/${encodedVersion})\n` +
    `- [GitHub Release](https://github.com/${encodedRepository}/releases/tag/v${encodedVersion})\n`;
}

async function api(
  report: ReleaseReport,
  route: string,
  options: { body?: Record<string, unknown>; method?: 'GET' | 'PATCH' | 'POST' } = {},
  request: typeof fetch = fetch,
): Promise<unknown> {
  const response = await request(
    `https://api.github.com/repos/${report.repository}${route}`,
    {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${report.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kintio-release-status',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `${options.method || 'GET'} ${route} failed: HTTP ${response.status}`,
    );
  }
  return response.status === 204 ? undefined : await response.json();
}

export async function upsertReleaseComment(
  report: ReleaseReport,
  request: typeof fetch = fetch,
): Promise<'created' | 'updated'> {
  assertReport(report);
  const comments: CommentRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await api(
      report,
      `/issues/${report.pullRequest}/comments?per_page=100&page=${page}`,
      {},
      request,
    );
    if (!Array.isArray(result)) throw new Error('invalid GitHub comment list');
    comments.push(...result as CommentRecord[]);
    if (result.length < 100) break;
  }
  const expectedMarker = marker(report.version);
  const matches = comments.filter((comment) =>
    comment.user?.login === BOT_LOGIN &&
    typeof comment.body === 'string' &&
    comment.body.includes(expectedMarker));
  if (matches.length > 1) {
    throw new Error(`Release PR has duplicate status comments for v${report.version}`);
  }
  const existing = matches[0];
  const body = releaseCommentBody(report);
  if (!existing) {
    await api(
      report,
      `/issues/${report.pullRequest}/comments`,
      { method: 'POST', body: { body } },
      request,
    );
    return 'created';
  }
  if (!Number.isSafeInteger(existing.id) || Number(existing.id) < 1) {
    throw new Error('invalid existing Release status comment');
  }
  await api(
    report,
    `/issues/comments/${existing.id}`,
    { method: 'PATCH', body: { body } },
    request,
  );
  return 'updated';
}

function reportFromEnvironment(environment: NodeJS.ProcessEnv): ReleaseReport {
  return {
    pullRequest: Number(environment.RELEASE_PR_NUMBER || 0),
    repository: String(environment.GITHUB_REPOSITORY || ''),
    runUrl: String(environment.RELEASE_RUN_URL || ''),
    state: String(environment.RELEASE_STATUS || '') as ReleaseReportState,
    token: String(environment.GH_TOKEN || ''),
    version: String(environment.RELEASE_VERSION || ''),
  };
}

async function main(): Promise<void> {
  const state = await upsertReleaseComment(reportFromEnvironment(process.env));
  console.log(`Release PR status comment ${state}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
