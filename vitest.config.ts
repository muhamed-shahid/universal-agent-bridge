import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Tests must never depend on the developer's real environment or credentials.
    env: {
      UAB_HOME: '',
      UAB_CONFIG: '',
      UAB_LOG_LEVEL: '',
    },
  },
});
