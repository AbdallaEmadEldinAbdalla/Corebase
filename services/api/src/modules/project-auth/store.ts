import type { Client } from 'pg';

/**
 * The queries the project-auth module runs against a *project's* `auth` schema
 * (P4b).
 *
 * Not to be confused with `modules/auth/store.ts`, which is the **control
 * plane's** user store — the people who log in to the Corebase dashboard. These
 * are the end users of a customer's application, they live in the customer's own
 * database, and the two must never share code or a connection. The separate
 * directory is the reminder: I overwrote the control-plane store once while
 * writing this file.
 *
 * Every query here runs as `corebase_auth` on a physically separate database
 * (D-009), which is where tenant separation actually comes from — there is no
 * cross-project table to leak through, so no query needs a `project_id` predicate
 * and none has one. Wanting one means the connection is wrong, not the query.
 */

export interface AuthUser {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  banned_until: Date | null;
  raw_user_meta_data: Record<string, unknown>;
  raw_app_meta_data: Record<string, unknown>;
  created_at: Date;
  last_sign_in_at: Date | null;
}

const USER_COLUMNS = `id, email, encrypted_password, email_confirmed_at, banned_until,
                      raw_user_meta_data, raw_app_meta_data, created_at, last_sign_in_at`;

/**
 * Find a user by email, case-insensitively, excluding soft-deleted rows.
 *
 * `lower(email)` matches the partial unique index exactly, which keeps this an
 * index scan — a login path that sequentially scans `auth.users` is one that gets
 * slower as the customer succeeds.
 */
export async function findUserByEmail(
  client: Client, email: string,
): Promise<AuthUser | undefined> {
  const { rows } = await client.query<AuthUser>(
    `SELECT ${USER_COLUMNS} FROM auth.users
      WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [email]);
  return rows[0];
}

export interface CreateUserArgs {
  email: string;
  passwordHash: string;
  /** Set when the project autoconfirms, so the user is usable immediately. */
  emailConfirmed: boolean;
  userMetadata?: Record<string, unknown> | undefined;
}

/**
 * Create a user, or report that the address is taken.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index rather than
 * check-then-insert: two simultaneous signups with one address would both pass a
 * check and one would fail on the constraint, turning a race into a 500. Returning
 * `undefined` also lets the caller answer identically whether the address was taken
 * a week ago or a millisecond ago, which the enumeration-safe response needs anyway.
 */
export async function createUser(
  client: Client, a: CreateUserArgs,
): Promise<AuthUser | undefined> {
  const { rows } = await client.query<AuthUser>(
    `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN now() ELSE NULL END, $4::jsonb)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [a.email, a.passwordHash, a.emailConfirmed, JSON.stringify(a.userMetadata ?? {})]);
  return rows[0];
}

/** Replace a hash after a successful verify against weaker parameters (D-313). */
export async function updatePasswordHash(
  client: Client, userId: string, hash: string,
): Promise<void> {
  await client.query(
    `UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1`,
    [userId, hash]);
}

export async function markSignedIn(client: Client, userId: string): Promise<void> {
  await client.query(
    `UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1`,
    [userId]);
}

/**
 * Open a session and its first refresh token, in one transaction.
 *
 * One transaction, because a session with no refresh token is a login that hands
 * back a token the client cannot renew: it works for an hour and then fails in a
 * way nobody can reproduce.
 */
export async function openSession(
  client: Client,
  a: {
    userId: string; refreshHash: Buffer;
    userAgent?: string | undefined; ip?: string | undefined;
  },
): Promise<{ sessionId: string; refreshTokenId: string }> {
  await client.query('BEGIN');
  try {
    const { rows: s } = await client.query<{ id: string }>(
      `INSERT INTO auth.sessions (user_id, user_agent, ip, last_refreshed_at)
       VALUES ($1, $2, $3::inet, now()) RETURNING id`,
      [a.userId, a.userAgent ?? null, a.ip ?? null]);
    const sessionId = s[0]!.id;
    const { rows: t } = await client.query<{ id: string }>(
      `INSERT INTO auth.refresh_tokens (token_hash, user_id, session_id, parent_id)
       VALUES ($1, $2, $3, NULL) RETURNING id::text AS id`,
      [a.refreshHash, a.userId, sessionId]);
    await client.query('COMMIT');
    return { sessionId, refreshTokenId: t[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Append to the project's own auth audit log.
 *
 * In the *project's* database rather than the control plane's, for the same reason
 * the users are (D-004, D-314): these are records about the customer's users, so
 * they belong to the customer and leave with a `pg_dump`.
 *
 * Never throws. An audit write that fails must not turn a successful login into an
 * error — the platform's own observability is the backstop for a database that has
 * stopped accepting writes, and failing the login would be the *second* thing to go
 * wrong rather than a mitigation of the first.
 */
export async function writeAuthAudit(
  client: Client,
  a: {
    action: string; userId?: string | undefined; ip?: string | undefined;
    userAgent?: string | undefined; payload?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO auth.audit_log_entries (actor_user_id, action, ip, user_agent, payload)
       VALUES ($1, $2, $3::inet, $4, $5::jsonb)`,
      [a.userId ?? null, a.action, a.ip ?? null, a.userAgent ?? null,
       JSON.stringify(a.payload ?? {})]);
  } catch {
    /* deliberately swallowed — see above */
  }
}

/**
 * The public user object the API returns.
 *
 * An allowlist rather than a denylist, and the difference matters: a column added
 * to `auth.users` later is invisible here until somebody decides otherwise,
 * instead of appearing in an API response because nobody remembered to hide it.
 * `encrypted_password` is the column that makes that worth being strict about.
 */
export const publicUser = (u: AuthUser) => ({
  id: u.id,
  email: u.email,
  email_confirmed_at: u.email_confirmed_at?.toISOString() ?? null,
  user_metadata: u.raw_user_meta_data,
  app_metadata: u.raw_app_meta_data,
  created_at: u.created_at.toISOString(),
  last_sign_in_at: u.last_sign_in_at?.toISOString() ?? null,
});

// ── one-time tokens (P4c, flows §2, §6, §7) ─────────────────────────────────

/**
 * The token types `auth.one_time_tokens` accepts. The CHECK constraint carries
 * the same list, so a typo here is a constraint violation rather than a row that
 * quietly never matches anything.
 */
export type TokenType =
  | 'confirmation' | 'recovery' | 'email_change_current' | 'email_change_new'
  | 'magic_link';

/** Flow lifetimes, from flows §"Token lifetimes". */
export const TOKEN_TTL_SECONDS: Record<TokenType, number> = {
  confirmation: 24 * 3600,
  // One hour, not twenty-four: a recovery token is a password reset in an inbox,
  // so the window in which a stolen or forwarded mail is useful should be as
  // short as a real person needs to click a link.
  recovery: 3600,
  email_change_current: 24 * 3600,
  email_change_new: 24 * 3600,
  magic_link: 900,
};

/**
 * Issue a one-time token, replacing any previous one of the same type.
 *
 * The upsert is what makes `/resend` safe rather than a way to accumulate live
 * links: the `UNIQUE (user_id, token_type)` constraint means the newest token
 * *replaces* the previous one, so an old link stops working the moment a new one
 * is issued. Ten resends leave one valid token, not ten.
 *
 * Only the hash is stored. A dump of this table is therefore not a set of usable
 * links — which matters more here than for passwords, because these tokens are
 * bearer credentials with no second factor at all.
 */
export async function issueOneTimeToken(
  client: Client,
  a: { userId: string; type: TokenType; hash: Buffer; relatesTo?: string | undefined },
): Promise<{ expiresAt: Date }> {
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO auth.one_time_tokens (user_id, token_type, token_hash, relates_to, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))
     ON CONFLICT (user_id, token_type) DO UPDATE
        SET token_hash = excluded.token_hash,
            relates_to = excluded.relates_to,
            created_at = now(),
            expires_at = excluded.expires_at,
            -- Cleared, or a replacement token inherits the previous one's spent
            -- state and the new link is dead on arrival.
            used_at    = NULL
     RETURNING expires_at`,
    [a.userId, a.type, a.hash, a.relatesTo ?? null, TOKEN_TTL_SECONDS[a.type]]);
  return { expiresAt: rows[0]!.expires_at };
}

export interface ConsumedToken {
  id: string;
  userId: string;
  relatesTo: string | null;
}

/**
 * Spend a one-time token: exists, unused, unexpired, all in one statement.
 *
 * One statement rather than select-then-update, and that is the whole point. Two
 * clicks on the same link arrive concurrently often enough to matter — mail
 * clients prefetch, users double-click, scanners follow links — and a
 * check-then-act would let both pass the check and both issue a session, which is
 * exactly the replay the single-use property exists to prevent. The `used_at IS
 * NULL` predicate lives inside the UPDATE, so the database decides the race and
 * exactly one caller gets a row back.
 *
 * The three failure reasons are deliberately indistinguishable to the caller
 * (unknown / spent / expired all return `undefined`): telling them apart is an
 * oracle for whether an address is registered and whether a link was already
 * used.
 */
export async function consumeOneTimeToken(
  client: Client, type: TokenType, hash: Buffer,
): Promise<ConsumedToken | undefined> {
  const { rows } = await client.query<{ id: string; user_id: string; relates_to: string | null }>(
    `UPDATE auth.one_time_tokens t
        SET used_at = now()
      WHERE t.token_type = $1
        AND t.token_hash = $2
        AND t.used_at IS NULL
        AND t.expires_at > now()
        -- A token belonging to a deleted user is not a valid token. Without this
        -- the join is the only thing stopping a tombstoned account from being
        -- confirmed back into a working session.
        AND EXISTS (SELECT 1 FROM auth.users u
                     WHERE u.id = t.user_id AND u.deleted_at IS NULL)
      RETURNING t.id::text AS id, t.user_id, t.relates_to`,
    [type, hash]);
  return rows[0]
    ? { id: rows[0].id, userId: rows[0].user_id, relatesTo: rows[0].relates_to }
    : undefined;
}

/** Mark an address confirmed. Idempotent: a second confirmation is not an error. */
export async function markEmailConfirmed(client: Client, userId: string): Promise<void> {
  await client.query(
    `UPDATE auth.users
        SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
      WHERE id = $1`, [userId]);
}

/** The user behind a consumed token, for minting a session straight afterwards. */
export async function findUserById(
  client: Client, id: string,
): Promise<AuthUser | undefined> {
  const { rows } = await client.query<AuthUser>(
    `SELECT ${USER_COLUMNS} FROM auth.users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0];
}
