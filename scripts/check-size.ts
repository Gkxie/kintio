import fs from 'node:fs';
import path from 'node:path';

// The hardened bubblewrap mount/network boundary is runtime code, not generated
// type overhead. Keep the limit close to the original 5,100 target while
// allowing that security boundary to remain explicit and reviewable.
const MAX_RUNTIME_LINES = 5_200;

function filesBelow(directory: string, extension: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(candidate, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [candidate] : [];
  });
}

function lines(filePath: string): number {
  const source = fs.readFileSync(filePath, 'utf8');
  return source ? source.split(/\r?\n/u).length - 1 : 0;
}

const runtimeFiles = ['dist/index.js', ...filesBelow('dist/src', '.js')];
const runtimeLines = runtimeFiles.reduce((total, file) => total + lines(file), 0);
const sourceFiles = ['index.ts', ...filesBelow('src', '.ts')];
const sourceLines = sourceFiles.reduce((total, file) => total + lines(file), 0);

if (runtimeLines > MAX_RUNTIME_LINES) {
  throw new Error(
    `Unminified runtime is ${runtimeLines} lines; limit is ${MAX_RUNTIME_LINES}`,
  );
}
process.stdout.write(
  `size gate ok: runtime=${runtimeLines}/${MAX_RUNTIME_LINES}, strict-ts-source=${sourceLines}\n`,
);
