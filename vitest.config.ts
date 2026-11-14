import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // bin.ts is the process entry point (argv/exit wiring); every decision it
      // delegates to lives in cli.ts, which is covered.
      exclude: ['src/bin.ts', 'src/providers/types.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      reporter: ['text', 'text-summary'],
    },
  },
});
