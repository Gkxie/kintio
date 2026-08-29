import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TestModule } from 'vitest/node';

import {
  NoSkippedReporter,
  skippedDeterministicTests,
} from '../reporters/no-skipped.ts';

function moduleWith(
  project: string,
  skipped: readonly string[],
): TestModule {
  return {
    project: { name: project },
    children: {
      *allTests(state?: string) {
        if (state === 'skipped') {
          for (const fullName of skipped) yield { fullName };
        }
      },
    },
  } as unknown as TestModule;
}

test('skip reporter fails deterministic projects but permits opt-in filtering', () => {
  const modules = [
    moduleWith('unit', ['unit > skipped behavior']),
    moduleWith('agent-eval', ['agent-eval > filtered rubric']),
  ];
  assert.deepEqual(skippedDeterministicTests(modules), [
    'unit > skipped behavior',
  ]);
  assert.throws(
    () => new NoSkippedReporter().onTestRunEnd(modules),
    /unit > skipped behavior/u,
  );
  assert.doesNotThrow(() => new NoSkippedReporter().onTestRunEnd([
    moduleWith('agent-eval', ['agent-eval > filtered rubric']),
  ]));
});
