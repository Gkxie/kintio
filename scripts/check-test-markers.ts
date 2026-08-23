#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const deterministicDirectories = [
  'test/unit',
  'test/integration',
  'test/recovery',
  'test/security',
] as const;
const optInDirectory = 'test/opt-in';
const testFilePattern = /\.test\.(?:[cm]?[jt]s)$/u;
const sourceFilePattern = /\.(?:[cm]?[jt]s)$/u;
const optInFilePattern = /\.integration\.ts$/u;
const acceptanceIdPattern = /^\| ([A-Z]+\d+) \|/gmu;

type LexicalState =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'single-quote'
  | 'double-quote'
  | 'template';
type AcceptanceClassification = 'deterministic' | 'agent-eval' | 'manual';
type EvidenceStatus = 'planned' | 'verified' | 'manual';

export interface MarkerFinding {
  label: string;
  line: number;
  marker: string;
}

interface AcceptanceCheck {
  classification: string;
  suite: string;
  file?: string | null;
  test?: string;
  status?: string;
}

interface AcceptanceEntry {
  id: string;
  checks: AcceptanceCheck[];
}

interface AcceptanceMap {
  status?: string;
  suites: Record<string, string | null>;
  entries: AcceptanceEntry[];
}

interface AcceptanceSummary {
  totalIds: number;
  verified: number;
  planned: number;
  manual: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function parseAcceptanceMap(value: unknown): AcceptanceMap {
  if (!isRecord(value) || !isRecord(value.suites) || !Array.isArray(value.entries)) {
    throw new Error('test/acceptance-map.json has an invalid root structure');
  }
  const suites: Record<string, string | null> = {};
  for (const [name, command] of Object.entries(value.suites)) {
    if (command !== null && typeof command !== 'string') {
      throw new Error(`Acceptance suite ${name} must be a string or null`);
    }
    suites[name] = command;
  }
  const entries = value.entries.map((entry, entryIndex): AcceptanceEntry => {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      throw new Error(`Acceptance entry ${entryIndex} is invalid`);
    }
    if (!Array.isArray(entry.checks)) {
      throw new Error(`Acceptance ${entry.id} checks must be an array`);
    }
    const checks = entry.checks.map((check, checkIndex): AcceptanceCheck => {
      if (
        !isRecord(check) ||
        typeof check.classification !== 'string' ||
        typeof check.suite !== 'string'
      ) {
        throw new Error(`Acceptance ${entry.id} check ${checkIndex} is invalid`);
      }
      return {
        classification: check.classification,
        suite: check.suite,
        ...(typeof check.file === 'string' || check.file === null
          ? { file: check.file }
          : {}),
        ...(typeof check.test === 'string' ? { test: check.test } : {}),
        ...(typeof check.status === 'string' ? { status: check.status } : {}),
      };
    });
    return { id: entry.id, checks };
  });
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    suites,
    entries,
  };
}

function blankCommentsAndStrings(source: string): string {
  let output = '';
  let state: LexicalState = 'code';

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    const next = source[index + 1];

    if (state === 'code') {
      if (character === '/' && next === '/') {
        output += '  ';
        index += 1;
        state = 'line-comment';
      } else if (character === '/' && next === '*') {
        output += '  ';
        index += 1;
        state = 'block-comment';
      } else if (character === "'") {
        output += ' ';
        state = 'single-quote';
      } else if (character === '"') {
        output += ' ';
        state = 'double-quote';
      } else if (character === '`') {
        output += ' ';
        state = 'template';
      } else {
        output += character;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (character === '\n') {
        output += '\n';
        state = 'code';
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (character === '\\') {
      output += ' ';
      if (next !== undefined) {
        output += next === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    const closesState =
      (state === 'single-quote' && character === "'") ||
      (state === 'double-quote' && character === '"') ||
      (state === 'template' && character === '`');
    output += character === '\n' ? '\n' : ' ';
    if (closesState) state = 'code';
  }

  return output;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

export function findForbiddenMarkers(source: string): MarkerFinding[] {
  const searchable = blankCommentsAndStrings(source);
  const findings: MarkerFinding[] = [];
  const patterns: ReadonlyArray<{ label: string; expression: RegExp }> = [
    {
      label: 'focused/skipped test member',
      expression:
        /\b(?:test|it|describe|suite)\s*\.\s*(?:skip|todo|only)\b/gu,
    },
    {
      label: 'skip/todo/only test option',
      expression: /\b(?:skip|todo|only)\s*:/gu,
    },
  ];

  for (const { label, expression } of patterns) {
    for (const match of searchable.matchAll(expression)) {
      findings.push({
        label,
        line: lineNumber(searchable, match.index),
        marker: match[0].replace(/\s+/gu, ''),
      });
    }
  }

  return findings.sort((left, right) => left.line - right.line);
}

function readStringLiteral(source: string, start: number): string | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let value = '';

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === quote) return value;
    if (quote === '`' && character === '$' && source[index + 1] === '{') {
      return undefined;
    }
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) return undefined;
    const replacements: Readonly<Record<string, string>> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0',
    };
    value += replacements[escaped] ?? escaped;
    index += 1;
  }
  return undefined;
}

function declaredTestNames(source: string): Set<string> {
  const searchable = blankCommentsAndStrings(source);
  const names = new Set<string>();
  for (const match of searchable.matchAll(/\b(?:test|it)\s*\(/gu)) {
    let titleStart = (match.index ?? 0) + match[0].length;
    while (/\s/u.test(source.charAt(titleStart))) titleStart += 1;
    const title = readStringLiteral(source, titleStart);
    if (title !== undefined) names.add(title);
  }
  return names;
}

async function filesBelow(
  relativeDirectory: string,
  predicate: (filename: string) => boolean = () => true,
): Promise<string[]> {
  const root = path.join(projectRoot, relativeDirectory);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && predicate(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function evidenceStatus(
  map: AcceptanceMap,
  check: AcceptanceCheck,
): EvidenceStatus | undefined {
  const candidate =
    check.status ??
    (check.classification === 'manual' ? 'manual' : map.status ?? 'planned');
  return ['planned', 'verified', 'manual'].includes(candidate)
    ? (candidate as EvidenceStatus)
    : undefined;
}

function suiteForTestFile(file: string): string | undefined {
  const normalized = file.split(path.sep).join('/');
  for (const suite of ['unit', 'integration', 'recovery', 'security']) {
    if (normalized.startsWith(`test/${suite}/`)) return suite;
  }
  if (normalized === 'test/opt-in/real-codex.integration.ts') return 'agent-eval';
  if (normalized === 'test/opt-in/live-wecom.integration.ts') return 'live';
  return undefined;
}

async function checkAcceptanceMap(
  violations: string[],
): Promise<AcceptanceSummary> {
  const acceptanceDocument = await fs.readFile(
    path.join(projectRoot, 'docs/acceptance.md'),
    'utf8',
  );
  const acceptanceMap = parseAcceptanceMap(
    JSON.parse(
      await fs.readFile(path.join(projectRoot, 'test/acceptance-map.json'), 'utf8'),
    ) as unknown,
  );
  const documentedIds = [
    ...acceptanceDocument.matchAll(acceptanceIdPattern),
  ]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
  const mappedIds = acceptanceMap.entries.map((entry) => entry.id);
  const allowedClassifications = new Set<AcceptanceClassification>([
    'deterministic',
    'agent-eval',
    'manual',
  ]);
  const summary: AcceptanceSummary = {
    totalIds: documentedIds.length,
    verified: 0,
    planned: 0,
    manual: 0,
  };

  for (const id of new Set(documentedIds)) {
    if (!mappedIds.includes(id)) violations.push(`acceptance map is missing ${id}`);
  }
  for (const id of new Set(mappedIds)) {
    if (!documentedIds.includes(id)) violations.push(`acceptance map has unknown ${id}`);
  }
  for (const id of mappedIds) {
    if (mappedIds.indexOf(id) !== mappedIds.lastIndexOf(id)) {
      violations.push(`acceptance map contains duplicate ${id}`);
    }
  }

  for (const entry of acceptanceMap.entries) {
    if (entry.checks.length === 0) {
      violations.push(`acceptance ${entry.id} has no checks`);
      continue;
    }
    for (const check of entry.checks) {
      if (
        !allowedClassifications.has(
          check.classification as AcceptanceClassification,
        )
      ) {
        violations.push(
          `acceptance ${entry.id} has invalid classification ${check.classification}`,
        );
      }
      if (!(check.suite in acceptanceMap.suites)) {
        violations.push(`acceptance ${entry.id} has unknown suite ${check.suite}`);
      }
      if (!String(check.test ?? '').trim()) {
        violations.push(`acceptance ${entry.id} has an unnamed check`);
      }
      const status = evidenceStatus(acceptanceMap, check);
      if (!status) {
        violations.push(
          `acceptance ${entry.id} has invalid evidence status ${check.status ?? acceptanceMap.status}`,
        );
        continue;
      }
      summary[status] += 1;

      if (status === 'manual') continue;
      const relativeFile = String(check.file ?? '').trim();
      if (!relativeFile) {
        violations.push(
          `acceptance ${entry.id} ${check.classification} check has no test file`,
        );
        continue;
      }
      const expectedSuite = suiteForTestFile(relativeFile);
      if (!expectedSuite) {
        violations.push(`acceptance ${entry.id} has an unclassified test path ${relativeFile}`);
      } else if (check.suite !== expectedSuite) {
        violations.push(
          `acceptance ${entry.id} maps ${relativeFile} to ${check.suite}, expected ${expectedSuite}`,
        );
      }
      if (status === 'planned') {
        if (
          process.env.REQUIRE_VERIFIED_ACCEPTANCE === '1' ||
          (
            process.env.REQUIRE_DETERMINISTIC_ACCEPTANCE === '1' &&
            check.classification === 'deterministic'
          )
        ) {
          violations.push(`acceptance ${entry.id} is still planned`);
        }
        continue;
      }

      const testPath = path.resolve(projectRoot, relativeFile);
      const projectRelativePath = path.relative(projectRoot, testPath);
      if (
        projectRelativePath === '..' ||
        projectRelativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(projectRelativePath)
      ) {
        violations.push(`acceptance ${entry.id} test file escapes the project root`);
        continue;
      }
      let source: string;
      try {
        source = await fs.readFile(testPath, 'utf8');
      } catch (error) {
        violations.push(
          `acceptance ${entry.id} verified file is unavailable: ${relativeFile} (${errorCode(error) ?? 'read_error'})`,
        );
        continue;
      }
      if (!declaredTestNames(source).has(String(check.test))) {
        violations.push(
          `acceptance ${entry.id} verified test name is absent from ${relativeFile}`,
        );
      }
    }
  }

  return summary;
}

export async function checkRepository(): Promise<void> {
  const allDiscoveredTests = await filesBelow('test', (name) =>
    testFilePattern.test(name),
  );
  const deterministicFiles: string[] = [];
  const violations: string[] = [];
  const acceptance = await checkAcceptanceMap(violations);

  for (const filePath of allDiscoveredTests) {
    const relativePath = path.relative(projectRoot, filePath);
    if (relativePath.startsWith(`${optInDirectory}${path.sep}`)) continue;
    const belongsToDeterministicSuite = deterministicDirectories.some(
      (directory) => relativePath.startsWith(`${directory}${path.sep}`),
    );
    if (!belongsToDeterministicSuite) {
      violations.push(
        `${relativePath} is outside the deterministic suite directories`,
      );
    }
    deterministicFiles.push(filePath);
  }

  for (const filePath of deterministicFiles) {
    const source = await fs.readFile(filePath, 'utf8');
    for (const finding of findForbiddenMarkers(source)) {
      violations.push(
        `${path.relative(projectRoot, filePath)}:${finding.line} ` +
          `${finding.label} (${finding.marker})`,
      );
    }
  }

  const optInFiles = await filesBelow(optInDirectory, (name) =>
    sourceFilePattern.test(name),
  );
  for (const filePath of optInFiles) {
    if (!optInFilePattern.test(path.basename(filePath))) {
      violations.push(
        `${path.relative(projectRoot, filePath)} is opt-in but does not end in .integration.ts`,
      );
    }
  }

  if (violations.length) {
    throw new Error(
      `Deterministic test policy failed:\n- ${violations.join('\n- ')}`,
    );
  }

  process.stdout.write(
    `marker policy ok: ${deterministicFiles.length} deterministic test file(s), ` +
      `${optInFiles.length} opt-in file(s); acceptance checks ` +
      `verified=${acceptance.verified} planned=${acceptance.planned} ` +
      `manual=${acceptance.manual} across ${acceptance.totalIds} ID(s)\n`,
  );
}

function selfTest(): void {
  assert.equal(findForbiddenMarkers("test.skip('disabled', () => {});").length, 1);
  assert.equal(
    findForbiddenMarkers("test('x', { todo: 'later' }, () => {});").length,
    1,
  );
  assert.equal(findForbiddenMarkers("describe.only('focused', () => {});").length, 1);
  assert.equal(
    findForbiddenMarkers(
      "// test.skip('comment')\nconst text = \"test.only('string')\";\n",
    ).length,
    0,
  );
  assert.deepEqual(
    [...declaredTestNames("test('real test', () => {});")],
    ['real test'],
  );
  process.stdout.write('marker policy self-test ok\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) selfTest();
  else await checkRepository();
}
