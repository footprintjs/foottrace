import { coverageConfigDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8', include: ['src/lib/**/*.ts'],
      exclude: [...coverageConfigDefaults.exclude, 'src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
