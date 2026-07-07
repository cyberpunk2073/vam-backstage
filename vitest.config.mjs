import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Console output from the code under test is noisy. By default we only surface
// logs for FAILING tests, so a green run renders as a clean checkbox tree.
// Set VITEST_LOGS=1 to see logs from passing tests too (for debugging).
const silent = process.env.VITEST_LOGS === '1' ? false : 'passed-only'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.js'],
    silent,
  },
})
