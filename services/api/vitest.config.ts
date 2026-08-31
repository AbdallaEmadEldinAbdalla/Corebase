import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same reason as the worker's config: shared staging database, so suites must
  // not run concurrently.
  test: { fileParallelism: false },
});
