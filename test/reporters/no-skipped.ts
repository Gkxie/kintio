import type { TestModule } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

const DETERMINISTIC_PROJECTS = new Set([
  'unit',
  'integration',
  'recovery',
  'security',
]);

export function skippedDeterministicTests(
  modules: ReadonlyArray<TestModule>,
): string[] {
  return modules.flatMap((module) =>
    DETERMINISTIC_PROJECTS.has(module.project.name)
      ? [...module.children.allTests('skipped')].map((test) => test.fullName)
      : []
  );
}

export class NoSkippedReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const skipped = skippedDeterministicTests(modules);
    if (skipped.length) {
      throw new Error(
        `Deterministic tests must not be skipped:\n${skipped.join('\n')}`,
      );
    }
  }
}
