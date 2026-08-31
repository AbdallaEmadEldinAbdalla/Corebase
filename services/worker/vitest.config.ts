import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every integration suite in this package truncates the same staging control
    // database and competes for the same host ports on the data node, so running
    // test files in parallel makes them corrupt each other's fixtures. The
    // symptom is a test failing for a reason that has nothing to do with the code
    // it covers, which is worse than the lost wall-clock.
    fileParallelism: false,
  },
});
