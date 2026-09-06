export type StableVersion = readonly [major: number, minor: number, patch: number];

export interface ReleasePlanInput {
  packageSource: string;
  runtimeSource: string;
  changelogSource: string;
  subjects: string[];
}

export interface ReleasePlanFiles {
  version: string;
  packageSource: string;
  runtimeSource: string;
  changelogSource: string;
}

interface UnreleasedSection {
  headingEnd: number;
  nextHeadingStart: number;
  segment: string;
  eol: '\n' | '\r\n';
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_CHORE = /^chore\(release\)!?:/u;
const FEATURE = /^feat(?:\([^()\r\n]+\))?!?:/u;
const BREAKING = /^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!:/u;

export function parseVersion(value: string): StableVersion {
  const match = STABLE_VERSION.exec(value);
  if (!match) throw new Error(`invalid stable SemVer: ${value}`);

  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!version.every(Number.isSafeInteger)) {
    throw new Error(`stable SemVer component exceeds the safe integer range: ${value}`);
  }
  return version;
}

export function nextVersion(current: string, subjects: string[]): string {
  const [major, minor, patch] = parseVersion(current);
  let hasFeature = false;
  let hasBreakingChange = false;

  for (const rawSubject of subjects) {
    const subject = rawSubject.trim();
    if (RELEASE_CHORE.test(subject)) continue;
    if (FEATURE.test(subject)) hasFeature = true;
    if (BREAKING.test(subject)) hasBreakingChange = true;
  }

  if (major === 0) {
    return hasFeature || hasBreakingChange
      ? `0.${minor + 1}.0`
      : `0.${minor}.${patch + 1}`;
  }
  if (hasBreakingChange) return `${major + 1}.0.0`;
  if (hasFeature) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function unreleasedBody(source: string): string {
  const section = locateUnreleased(source);
  requireTopLevelEntry(section.segment);
  return section.segment
    .replace(/^(?:[ \t]*\r?\n)+/u, '')
    .replace(/(?:\r?\n[ \t]*)+$/u, '');
}

export function freezeUnreleased(source: string, version: string): string {
  parseVersion(version);
  assertVersionSectionAbsent(source, version);
  const section = locateUnreleased(source);
  requireTopLevelEntry(section.segment);

  return source.slice(0, section.headingEnd)
    + section.eol
    + section.eol
    + `## ${version}`
    + section.segment
    + source.slice(section.nextHeadingStart);
}

export function buildReleasePlanFiles(input: ReleasePlanInput): ReleasePlanFiles {
  const packageJson = parsePackage(input.packageSource);
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== 'string') {
    throw new Error('package.json version must be a stable SemVer string');
  }
  parseVersion(packageVersion);

  const runtime = parseRuntimeVersion(input.runtimeSource);
  if (runtime.version !== packageVersion) {
    throw new Error(
      `package version ${packageVersion} does not match runtime version ${runtime.version}`,
    );
  }

  const version = nextVersion(packageVersion, input.subjects);
  const changelogSource = freezeUnreleased(input.changelogSource, version);
  const updatedPackage = { ...packageJson, version };

  return {
    version,
    packageSource: renderPackage(updatedPackage, input.packageSource),
    runtimeSource:
      `export const KINTIO_VERSION = ${runtime.quote}${version}${runtime.quote};${runtime.eol}`,
    changelogSource,
  };
}

export function validateReleaseFiles(
  files: readonly { filename: string; status: string }[],
): void {
  const required = ['CHANGELOG.md', 'package.json', 'src/version.ts'];
  const allowed = new Set([...required, 'SECURITY.md']);
  for (const file of required) {
    if (!files.some((item) => item.filename === file)) {
      throw new Error('Release PR must change ' + file);
    }
  }
  for (const file of files) {
    if (file.status === 'renamed') throw new Error('Release PR cannot rename files');
    if (!allowed.has(file.filename)) throw new Error('Release PR changed ' + file.filename);
  }
}

export function validateReleaseManifest(input: {
  version: string;
  packageSource: string;
  runtimeSource: string;
  basePackageSource: string;
  baseRuntimeSource: string;
}): void {
  const packageJson = JSON.parse(input.packageSource) as Record<string, unknown>;
  const basePackage = JSON.parse(input.basePackageSource) as Record<string, unknown>;
  if (packageJson.name !== '@kin-tio/cli' || packageJson.version !== input.version) {
    throw new Error('package identity does not match the Release PR');
  }
  const releasePackage = { ...packageJson };
  const previousPackage = { ...basePackage };
  delete releasePackage.version;
  delete previousPackage.version;
  if (JSON.stringify(releasePackage) !== JSON.stringify(previousPackage)) {
    throw new Error('Release PR changed package.json beyond its version');
  }
  const baseRuntimeVersion = /^export const KINTIO_VERSION = ['"]([^'"]+)['"];\r?\n?$/u
    .exec(input.baseRuntimeSource)?.[1];
  if (
    baseRuntimeVersion !== basePackage.version ||
    input.runtimeSource !== `export const KINTIO_VERSION = '${input.version}';\n`
  ) throw new Error('runtime version does not match the Release PR');
}

export function validateFrozenChangelog(source: string, version: string): void {
  const { lines, unreleased, start, nextSection } = releasedSection(source, version);
  if (lines.slice(unreleased + 1, start).join('\n').trim()) {
    throw new Error('Changelog does not freeze one empty Unreleased section');
  }
  if (!lines.slice(start + 1, nextSection).some((line) => line.startsWith('- '))) {
    throw new Error('release Changelog section has no entries');
  }
}

export function releaseNotes(source: string, version: string, latestPublished?: string): string {
  const { lines, start, nextSection } = releasedSection(source, version);
  const end = latestPublished && latestPublished !== version
    ? findReleasedVersion(lines, latestPublished)
    : nextSection;
  if (end <= start) throw new Error('published changelog versions are not descending');
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes.split('\n').some((line) => line.startsWith('- '))) {
    throw new Error(`CHANGELOG.md has no unpublished entries for ${version}`);
  }
  return notes;
}

function releasedSection(source: string, version: string): {
  lines: string[];
  unreleased: number;
  start: number;
  nextSection: number;
} {
  const lines = source.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => line === '## Unreleased' ? [index] : []);
  if (headings.length !== 1) throw new Error('CHANGELOG.md requires one Unreleased section');
  const unreleased = headings[0]!;
  const start = findReleasedVersion(lines, version);
  if (unreleased > start) throw new Error('Unreleased must precede released versions');
  const nextSection = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return { lines, unreleased, start, nextSection: nextSection < 0 ? lines.length : nextSection };
}

function findReleasedVersion(lines: readonly string[], version: string): number {
  const dated = new RegExp('^## ' + version.replaceAll('.', '\\.') + ' - \\d{4}-\\d{2}-\\d{2}$', 'u');
  const matches = lines.flatMap((line, index) =>
    line === '## ' + version || dated.test(line) ? [index] : [],
  );
  if (matches.length !== 1) throw new Error(`CHANGELOG.md requires one section for ${version}`);
  return matches[0]!;
}

function locateUnreleased(source: string): UnreleasedSection {
  const matches = [...source.matchAll(/^## Unreleased\r?$/gmu)];
  if (matches.length !== 1) {
    throw new Error('CHANGELOG.md must contain exactly one "## Unreleased" section');
  }

  const match = matches[0];
  if (!match || match.index === undefined) {
    throw new Error('cannot locate the Unreleased section');
  }
  const headingEnd = match.index + '## Unreleased'.length;
  const afterHeading = source.slice(headingEnd);
  const nextHeadingOffset = afterHeading.search(/^## .+\r?$/mu);
  const nextHeadingStart = nextHeadingOffset < 0
    ? source.length
    : headingEnd + nextHeadingOffset;
  const segment = source.slice(headingEnd, nextHeadingStart);
  const eol = segment.startsWith('\r\n') || source.includes('\r\n') ? '\r\n' : '\n';

  return { headingEnd, nextHeadingStart, segment, eol };
}

function requireTopLevelEntry(segment: string): void {
  if (!segment.split(/\r?\n/u).some((line) => line.startsWith('- '))) {
    throw new Error('Unreleased must contain at least one top-level "- " entry');
  }
}

function assertVersionSectionAbsent(source: string, version: string): void {
  const headings = source.matchAll(/^## (\d+\.\d+\.\d+)(?:[ \t]+.*)?\r?$/gmu);
  for (const heading of headings) {
    if (heading[1] === version) {
      throw new Error(`CHANGELOG.md already contains a section for ${version}`);
    }
  }
}

function parsePackage(source: string): Record<string, unknown> & {
  name: string;
  version?: unknown;
} {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('package.json is not valid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('package.json must contain one JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.name !== '@kin-tio/cli') {
    throw new Error('package.json name must be @kin-tio/cli');
  }
  return record as Record<string, unknown> & { name: string; version?: unknown };
}

function parseRuntimeVersion(source: string): {
  version: string;
  quote: "'" | '"';
  eol: string;
} {
  const match = /^(?:export const KINTIO_VERSION = )(['"])([^'"\r\n]+)\1;(\r?\n)?$/u
    .exec(source);
  if (!match || (match[1] !== "'" && match[1] !== '"') || !match[2]) {
    throw new Error('src/version.ts must contain exactly one KINTIO_VERSION constant line');
  }
  parseVersion(match[2]);
  return {
    quote: match[1],
    version: match[2],
    eol: match[3] || '',
  };
}

function renderPackage(packageJson: Record<string, unknown>, original: string): string {
  const indentation = /^([ \t]+)"/mu.exec(original)?.[1] || '  ';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = /\r?\n$/u.test(original) ? eol : '';
  return JSON.stringify(packageJson, undefined, indentation).replace(/\n/gu, eol) + finalEol;
}
