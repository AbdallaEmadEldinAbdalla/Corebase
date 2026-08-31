import { describe, it, expect } from 'vitest';
import { QUEUE_PROVISIONING, QUEUE_PREFIX } from './index.ts';

describe('queue naming', () => {
  /**
   * Regression: the queue was originally named 'corebase:provisioning', which
   * BullMQ rejects because ':' is reserved for its own key namespacing. The
   * failure surfaced only in integration tests — and those were skipping
   * silently, so it nearly shipped.
   */
  it('has no colon in the queue name', () => {
    expect(QUEUE_PROVISIONING).not.toContain(':');
  });
  it('namespaces through prefix instead', () => {
    expect(QUEUE_PREFIX).toBe('corebase');
    expect(QUEUE_PREFIX).not.toContain(':');
  });
  it('keeps the names non-empty and lowercase-safe for Redis keys', () => {
    for (const n of [QUEUE_PROVISIONING, QUEUE_PREFIX]) {
      expect(n.length).toBeGreaterThan(0);
      expect(n).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });
});
