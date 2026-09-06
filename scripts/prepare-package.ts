import fs from 'node:fs/promises';

const VERSION_HEADING = /^## (\d+\.\d+\.\d+)(?: - \d{4}-\d{2}-\d{2})?$/gmu;

export function publishedChangelog(source: string, version: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('# Changelog\n')) {
    throw new Error('CHANGELOG.md must start with "# Changelog"');
  }
  const headings = [...normalized.matchAll(VERSION_HEADING)];
  const first = headings[0];
  if (
    !first
    || first.index === undefined
    || first[1] !== version
    || headings.filter((heading) => heading[1] === version).length !== 1
  ) {
    throw new Error(`CHANGELOG.md must list ${version} as its newest released version`);
  }
  return `# Changelog\n\n${normalized.slice(first.index).trimEnd()}\n`;
}

export async function preparePackage(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    version?: string;
  };
  if (!manifest.version) throw new Error('package.json has no version');
  const changelog = 'CHANGELOG.md';
  await Promise.all([
    fs.writeFile(
      changelog,
      publishedChangelog(await fs.readFile(changelog, 'utf8'), manifest.version),
    ),
    fs.rm('README.zh-CN.md'),
  ]);
}

if (process.argv[1]?.endsWith('prepare-package.ts')) await preparePackage();
