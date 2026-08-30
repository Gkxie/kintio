import { defineConfig } from 'vitest/config';

import { NoSkippedReporter } from './test/reporters/no-skipped.ts';

const deterministic = {
  environment: 'node' as const,
  pool: 'forks' as const,
  maxWorkers: 2,
  isolate: true,
  testTimeout: 30_000,
  hookTimeout: 30_000,
  teardownTimeout: 10_000,
  allowOnly: false,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};

export default defineConfig({
  test: {
    ...deterministic,
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions' as const] : []),
      new NoSkippedReporter(),
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'recovery',
          include: ['test/recovery/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'security',
          include: ['test/security/**/*.test.ts'],
        },
      },
      ...(process.env.RUN_REAL_CODEX === '1'
        ? [{
            extends: true as const,
            test: {
              name: 'agent-eval',
              include: ['test/opt-in/real-codex.integration.ts'],
              fileParallelism: false,
              hookTimeout: 30_000,
              ...(process.env.FULL_AGENT_EVAL === '1'
                ? {}
                : {
                    testNamePattern:
                      /^(?!full: ).*/u,
                  }),
            },
          }]
        : []),
      ...(process.env.LIVE_WECOM_ACK === 'SEND_REAL_MESSAGE'
        ? [{
            extends: true as const,
            test: {
              name: 'live',
              include: ['test/opt-in/live-wecom.integration.ts'],
              fileParallelism: false,
              hookTimeout: 30_000,
            },
          }]
        : []),
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['dist/**', 'test/**'],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
      },
    },
  },
});
