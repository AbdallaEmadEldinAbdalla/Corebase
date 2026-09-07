/**
 * Object-key construction, and the path normalisation in front of it (P6c).
 *
 * **Project isolation in object storage is enforced here and nowhere else.**
 * There is one bucket per region and projects are key prefixes (D-120), so the
 * object store itself draws no boundary between two customers' files — the only
 * thing that does is that this module derives `projects/<ref>/` from the
 * *authenticated* project context and never from anything the client sent.
 *
 * That makes this file the storage equivalent of the gateway's Host resolution:
 * small, boring, and the single point where getting it wrong is a cross-tenant
 * read. It has its own module and its own tests for that reason.
 */

/** The doc's key layout: `projects/<project_ref>/<bucket>/<object_path>`. */
export const objectKey = (ref: string, bucket: string, name: string): string =>
  `projects/${ref}/${bucket}/${name}`;

/** Everything belonging to one project, for the sweep and for deletion. */
export const projectPrefix = (ref: string): string => `projects/${ref}/`;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * Normalise a client-supplied object path, or refuse it.
 *
 * The database has a CHECK constraint covering some of the same ground, and this
 * is not redundant with it: the constraint protects the *table* from a bad row,
 * while this protects the *key* from being assembled at all. An upload writes
 * bytes before it writes the row (D-124), so a path that only the constraint
 * catches would already have put an object somewhere before anything complained.
 *
 * What is refused, and why each one:
 *
 * - `..` or `.` as a whole segment — the traversal that would climb out of the
 *   project's prefix and into a neighbour's.
 * - A leading `/` — makes the assembled key contain `//`, which most stores treat
 *   as a key distinct from the one the row records, so the row and the bytes end
 *   up describing different objects.
 * - Empty segments (`a//b`) — the same divergence, reached differently.
 * - Percent-encoded separators or dots (`%2f`, `%2e`) — the interesting one. A
 *   client sending `a%2f..%2fb` is relying on *something downstream* decoding it
 *   after we have finished checking. Refusing the encoded form outright is the
 *   only version of this check that does not depend on guessing how many decode
 *   passes the path will see before it becomes a key.
 * - Control characters, and a trailing `/` — not attacks, but names that make a
 *   listing ambiguous about whether an entry is a file or a folder.
 *
 * Note what is *allowed*: dots anywhere else (`v1.2/photo..png`), spaces,
 * Unicode. A check that rejected those would be rejecting ordinary filenames,
 * which is a bug wearing security's clothes.
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PathError('An object path is required.');
  }
  if (raw.length > 1024) {
    throw new PathError('An object path may be at most 1024 characters.');
  }
  // Before any decoding: if the raw form carries an encoded separator or dot, the
  // client is asking for a second interpretation pass they will not get. Checked
  // case-insensitively, because `%2F` and `%2f` are the same byte.
  if (/%2e|%2f|%5c/i.test(raw)) {
    throw new PathError(
      'An object path may not contain percent-encoded separators or dots. '
      + 'Send the path as it should be stored.');
  }
  if (raw.startsWith('/')) throw new PathError('An object path may not start with "/".');
  if (raw.endsWith('/')) throw new PathError('An object path may not end with "/".');
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new PathError('An object path may not contain control characters.');
  }
  for (const seg of raw.split('/')) {
    if (seg === '') throw new PathError('An object path may not contain empty segments.');
    if (seg === '.' || seg === '..') {
      throw new PathError('An object path may not contain "." or ".." segments.');
    }
  }
  // Returned unchanged rather than rewritten. A normaliser that *fixed* paths
  // would mean the name the client sent and the name stored could differ, and
  // every later comparison — an upsert, a signed URL, the sweep's anti-join —
  // would have to know which of the two forms it was holding.
  return raw;
}

/**
 * The bucket name, validated before it reaches a key.
 *
 * Buckets arrive from the URL as well as from the create endpoint, and a name
 * arriving that way has not passed the column's CHECK. Since the bucket is a
 * path segment of the assembled key, an unvalidated one is a second way to
 * inject separators.
 */
export function normalizeBucket(raw: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(raw)) {
    throw new PathError('That is not a legal bucket name.');
  }
  return raw;
}
