import { describe, it, expect } from 'vitest';
import { encodeId, decodeId, encodeIdMaybe, InvalidIdError } from './ids.ts';

const UUID = 'e5f6a7b8-1111-4222-8333-444455556666';

describe('id prefixes in transport', () => {
  it('encodes and decodes round-trip', () => {
    expect(encodeId('project', UUID)).toBe(`prj_${UUID}`);
    expect(decodeId('project', `prj_${UUID}`)).toBe(UUID);
    expect(encodeId('organization', UUID)).toBe(`org_${UUID}`);
    expect(encodeId('user', UUID)).toBe(`usr_${UUID}`);
  });

  it('accepts a bare uuid on input', () => {
    // A client that read an id from a database dump is being more precise than
    // the API asked, not wrong.
    expect(decodeId('project', UUID)).toBe(UUID);
  });

  it('rejects the wrong prefix rather than accepting it', () => {
    // `org_…` where a project belongs is a real mix-up; silently accepting it
    // turns a clear 400 into a confusing 404 later.
    expect(() => decodeId('project', `org_${UUID}`))
      .toThrow(/is a org_ id where a prj_ id was expected/);
  });

  it('rejects a prefix with no uuid behind it', () => {
    expect(() => decodeId('project', 'prj_not-a-uuid')).toThrow(InvalidIdError);
    expect(() => decodeId('project', 'prj_')).toThrow(InvalidIdError);
    expect(() => decodeId('project', 'garbage')).toThrow(InvalidIdError);
  });

  it('refuses to encode something that is not a uuid', () => {
    // Catches a prefixed id being encoded twice, which is how `prj_prj_…`
    // reaches a customer.
    expect(() => encodeId('project', `prj_${UUID}`)).toThrow(/not a uuid/);
    expect(() => encodeId('project', '')).toThrow(InvalidIdError);
  });

  it('normalises case, because uuids are case-insensitive and greps are not', () => {
    expect(encodeId('project', UUID.toUpperCase())).toBe(`prj_${UUID}`);
    expect(decodeId('project', `prj_${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it('passes null and undefined through for optional fields', () => {
    expect(encodeIdMaybe('project', null)).toBeUndefined();
    expect(encodeIdMaybe('project', undefined)).toBeUndefined();
    expect(encodeIdMaybe('project', UUID)).toBe(`prj_${UUID}`);
  });
});
