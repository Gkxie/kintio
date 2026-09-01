#!/usr/bin/env node

const currentNode = process.versions.node;
const nodeMajor = Number.parseInt(currentNode.split('.')[0] || '', 10);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
  process.stderr.write(
    `Kintio requires Node.js 24 or newer; current runtime is v${currentNode}.\n` +
    'Install Node.js 24+, then reinstall @kin-tio/cli in that Node environment.\n',
  );
  process.exitCode = 1;
} else {
  await import('../dist/cli.js');
}
