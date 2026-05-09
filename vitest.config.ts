import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace SDK dependency to built output. The subpath alias
      // ('/audit') must be listed first so vitest matches it before the root
      // alias falls back to treating "/audit" as a path under index.js.
      '@lifestreamdynamics/vault-sdk/audit': resolve(__dirname, '../sdk/dist/audit.js'),
      '@lifestreamdynamics/vault-sdk': resolve(__dirname, '../sdk/dist/index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/**/*.test.ts',
        'src/__tests__/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
