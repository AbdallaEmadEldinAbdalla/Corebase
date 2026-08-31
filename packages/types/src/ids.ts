/**
 * Ids are prefixed in transport and bare uuids at rest (platform API §"ids are
 * `usr_/org_/prj_`-prefixed uuids in transport for greppability").
 *
 * The prefix earns its keep in a support conversation: a `prj_` in a log line, a
 * stack trace or a customer email is unambiguous, where a bare uuid could be any
 * of eight things. It stays out of the database because a prefix in a column is a
 * prefix you have to strip in every join.
 *
 * The encoding therefore belongs at the API boundary and nowhere else — the store
 * and the worker deal in uuids, and a prefixed id reaching either of them is a
 * bug this module's decoder is meant to catch loudly.
 */

export const ID_PREFIX = {
  user: 'usr',
  organization: 'org',
  project: 'prj',
  job: 'job',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidIdError extends Error {}

/** uuid → `prj_<uuid>`. Throws on anything that is not a bare uuid. */
export function encodeId(kind: IdKind, uuid: string): string {
  if (!UUID.test(uuid)) {
    throw new InvalidIdError(`cannot encode "${uuid}" as a ${kind} id: not a uuid`);
  }
  return `${ID_PREFIX[kind]}_${uuid.toLowerCase()}`;
}

/**
 * `prj_<uuid>` → uuid. Accepts a bare uuid too, because a client that read an id
 * out of a database dump should not get a 400 for being more precise than the
 * API asked; a *wrong* prefix is still an error, since `org_…` where a project
 * belongs is a real mix-up worth reporting rather than silently accepting.
 */
export function decodeId(kind: IdKind, value: string): string {
  const expected = ID_PREFIX[kind];
  if (UUID.test(value)) return value.toLowerCase();
  const match = /^([a-z]+)_(.+)$/.exec(value);
  if (!match) throw new InvalidIdError(`"${value}" is not a valid ${kind} id`);
  const [, prefix, rest] = match;
  if (prefix !== expected) {
    throw new InvalidIdError(
      `"${value}" is a ${prefix}_ id where a ${expected}_ id was expected`);
  }
  if (!UUID.test(rest!)) throw new InvalidIdError(`"${value}" has a ${expected}_ prefix but no uuid`);
  return rest!.toLowerCase();
}

/** For optional fields: null and undefined pass through untouched. */
export function encodeIdMaybe(kind: IdKind, uuid: string | null | undefined): string | undefined {
  return uuid ? encodeId(kind, uuid) : undefined;
}
