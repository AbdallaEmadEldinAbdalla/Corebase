import { describe, it, expect } from 'vitest';
import { hashToken, TOKEN_PREFIX } from './tokens.ts';

describe('PAT format', () => {
  it('hashes with SHA-256, hex-encoded', () => {
    // Not a KDF, on purpose: a PAT is 30 bytes of CSPRNG, so there is no
    // dictionary to attack — a memory-hard hash here would only add 100ms to
    // every authenticated request.
    expect(hashToken('shp_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('shp_abc')).toBe(hashToken('shp_abc'));
    expect(hashToken('shp_abc')).not.toBe(hashToken('shp_abd'));
  });

  it('uses the documented prefix', () => {
    expect(TOKEN_PREFIX).toBe('shp_');
  });
});
