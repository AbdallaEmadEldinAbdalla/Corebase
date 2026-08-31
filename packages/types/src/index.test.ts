import { describe, it, expect } from 'vitest';
import { ProjectRef, CreateProjectRequest, JobPayload } from './index.js';

describe('ProjectRef (D-056)', () => {
  it('accepts a 20-char base32 ref starting with a letter', () => {
    expect(ProjectRef.safeParse('kxqwrtplmzensfba234').success).toBe(false); // 19 chars
    expect(ProjectRef.safeParse('kxqwrtplmzensfba2345').success).toBe(true);
  });
  it('rejects refs starting with a digit (must be a valid DNS label)', () => {
    expect(ProjectRef.safeParse('2xqwrtplmzensfba2345').success).toBe(false);
  });
  it('rejects base32-illegal characters (0, 1, 8, 9)', () => {
    expect(ProjectRef.safeParse('kxqwrtplmzensfba2340').success).toBe(false);
  });
});

describe('CreateProjectRequest', () => {
  it('defaults region and plan', () => {
    const p = CreateProjectRequest.parse({ name: 'my-app' });
    expect(p.region).toBe('eu-central');
    expect(p.plan).toBe('free');
  });
  it('rejects uppercase and underscores in names', () => {
    expect(CreateProjectRequest.safeParse({ name: 'My_App' }).success).toBe(false);
  });
});

describe('JobPayload', () => {
  it('discriminates on kind', () => {
    const j = JobPayload.parse({
      kind: 'provision_project',
      project_id: '00000000-0000-4000-8000-000000000000',
      idempotency_key: 'k1',
    });
    expect(j.kind).toBe('provision_project');
  });
});
