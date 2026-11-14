// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // End-to-end tests launch Chromium several times per test.
    testTimeout: 60_000,
  },
});
