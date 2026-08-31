import { ApiError } from './errors.ts';
import { ERROR_CODES } from '@corebase/types';

/**
 * Cursor pagination (D-039): `?limit=` and `?cursor=`, an opaque cursor carrying
 * `(created_at, id)`, and no offset pagination anywhere.
 *
 * The reason it is keyset and not offset is not elegance. `OFFSET 2000` makes the
 * database walk 2000 rows it will discard, and — worse for a list a customer is
 * scrolling — a row inserted or deleted mid-scroll shifts every later page, so
 * items are silently skipped or shown twice. A keyset cursor anchors to a row, so
 * concurrent writes cannot make the reader lose their place.
 *
 * The cursor is opaque on purpose: base64 of a JSON pair is trivially decodable
 * and that is fine, but declaring it opaque means the shape can change without a
 * client depending on it.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface Cursor {
  created_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED,
      'The cursor is not readable. Pass a `next_cursor` from a previous response, or omit it.');
  }
  const c = parsed as Partial<Cursor>;
  if (typeof c.created_at !== 'string' || typeof c.id !== 'string') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED,
      'The cursor is missing its fields. Pass a `next_cursor` from a previous response.');
  }
  if (Number.isNaN(Date.parse(c.created_at))) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED, 'The cursor carries an invalid timestamp.');
  }
  return { created_at: c.created_at, id: c.id };
}

export interface PageRequest {
  limit: number;
  cursor?: Cursor;
}

/** Parse and clamp the query parameters, rejecting nonsense rather than guessing. */
export function parsePageRequest(query: Record<string, unknown>): PageRequest {
  const raw = query['limit'];
  let limit = DEFAULT_LIMIT;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED,
        `limit must be a positive integer (max ${MAX_LIMIT}).`);
    }
    // Clamped, not rejected: asking for more than the maximum is a reasonable
    // thing for a client to do once, and a 400 teaches nothing a cap does not.
    limit = Math.min(n, MAX_LIMIT);
  }
  const cursor = typeof query['cursor'] === 'string' && query['cursor']
    ? decodeCursor(query['cursor']) : undefined;
  return { limit, ...(cursor ? { cursor } : {}) };
}

export interface Page<T> {
  items: T[];
  pagination: { next_cursor: string | null; has_more: boolean };
}

/**
 * Turn `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `has_more` becomes a fact rather than an
 * estimate: a count query would be a second, racing question, and "is there
 * another page" is exactly answerable by asking for one more row than you intend
 * to return.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    pagination: {
      next_cursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
      has_more: hasMore,
    },
  };
}
