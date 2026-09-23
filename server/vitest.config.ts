import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loads throwaway configuration so unit tests need no database.
    setupFiles: ['src/test-setup.ts'],
  },
})
