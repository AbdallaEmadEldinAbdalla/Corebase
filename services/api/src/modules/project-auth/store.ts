import type { Client } from 'pg';

/**
 * The queries the project-auth module runs against a *project's* `auth` schema
 * (P4b).
 *
 * Not to be confused with `modules/auth/store.ts`, which is the **control
 * plane's** user store — the people who log in to the Steadhold dashboard. These
 * are the end users of a customer's application, they live in the customer's own
 * database, and the two must never share code or a connection. The separate
 * directory is the reminder: I overwrote the control-plane store once while
 * writing this file.
 *
 * Every query here runs as `steadhold_auth` on a physically separate database
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
  /**
   * `null` for a user with no password — an imported account awaiting a reset, or
   * one that will only ever sign in through a provider. Only the admin surface
   * can create one; signup always sets a hash. The login path already refuses a
   * NULL hash *after* spending a decoy verify, so such an account is
   * indistinguishable from a wrong password rather than from a missing user.
   */
  passwordHash: string | null;
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

// ── refresh rotation and sessions (P4e, D-112/D-113) ────────────────────────

export interface RefreshRow {
  id: string;
  userId: string;
  sessionId: string;
  usedAt: Date | null;
  revoked: boolean;
  sessionRevokedAt: Date | null;
  lastRefreshedAt: Date | null;
  sessionCreatedAt: Date;
}

/**
 * Find a presented refresh token, with everything needed to judge it.
 *
 * One query, joined to the session, because every one of the protocol's early
 * exits needs both rows and a second round trip between them is a window in which
 * the session can be revoked underneath us.
 */
export async function findRefreshToken(
  client: Client, hash: Buffer,
): Promise<RefreshRow | undefined> {
  const { rows } = await client.query<{
    id: string; user_id: string; session_id: string; used_at: Date | null;
    revoked: boolean; session_revoked_at: Date | null;
    last_refreshed_at: Date | null; session_created_at: Date;
  }>(
    `SELECT r.id::text AS id, r.user_id, r.session_id, r.used_at, r.revoked,
            s.revoked_at AS session_revoked_at, s.last_refreshed_at,
            s.created_at AS session_created_at
       FROM auth.refresh_tokens r
       JOIN auth.sessions s ON s.id = r.session_id
      WHERE r.token_hash = $1`, [hash]);
  const r = rows[0];
  return r ? {
    id: r.id, userId: r.user_id, sessionId: r.session_id, usedAt: r.used_at,
    revoked: r.revoked, sessionRevokedAt: r.session_revoked_at,
    lastRefreshedAt: r.last_refreshed_at, sessionCreatedAt: r.session_created_at,
  } : undefined;
}

/**
 * Spend a token and mint its child, atomically.
 *
 * `used_at IS NULL` is inside the UPDATE, so two concurrent refreshes with the
 * same token cannot both succeed — the loser gets no row back and falls into the
 * already-spent branch, where the grace window turns it into an idempotent replay
 * rather than a false theft signal. Doing the check as its own SELECT would let
 * both mint a child, which produces two live lineages from one token: the exact
 * state reuse detection exists to make impossible.
 */
export async function rotateRefreshToken(
  client: Client, a: { tokenId: string; sessionId: string; userId: string; childHash: Buffer },
): Promise<{ childId: string } | undefined> {
  await client.query('BEGIN');
  try {
    const { rows: spent } = await client.query<{ id: string }>(
      `UPDATE auth.refresh_tokens SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND revoked = false
        RETURNING id::text AS id`, [a.tokenId]);
    if (!spent[0]) { await client.query('ROLLBACK'); return undefined; }

    const { rows: child } = await client.query<{ id: string }>(
      `INSERT INTO auth.refresh_tokens (token_hash, user_id, session_id, parent_id)
       VALUES ($1, $2, $3, $4::bigint) RETURNING id::text AS id`,
      [a.childHash, a.userId, a.sessionId, a.tokenId]);
    await client.query(
      `UPDATE auth.sessions SET last_refreshed_at = now() WHERE id = $1`, [a.sessionId]);
    await client.query('COMMIT');
    return { childId: child[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * The child a spent token already produced, for the grace-window replay.
 *
 * Returns the child's *hash*, and that is the whole problem with replaying a
 * refresh: we store only digests, so the plaintext of an already-issued child
 * cannot be recovered to hand back a second time. Hence `graceRotate` below.
 */
export async function findChildToken(
  client: Client, parentId: string,
): Promise<{ id: string; usedAt: Date | null; revoked: boolean } | undefined> {
  const { rows } = await client.query<{ id: string; used_at: Date | null; revoked: boolean }>(
    `SELECT id::text AS id, used_at, revoked FROM auth.refresh_tokens
      WHERE parent_id = $1::bigint ORDER BY id LIMIT 1`, [parentId]);
  return rows[0] ? { id: rows[0].id, usedAt: rows[0].used_at, revoked: rows[0].revoked } : undefined;
}

/**
 * Replace the unspent child of a spent token with a fresh one, inside the grace
 * window.
 *
 * The doc says to "return the already-issued child", and that is impossible as
 * written: the child's plaintext was handed to the client and only its sha256 was
 * kept, so it cannot be handed to anyone a second time. What is achievable — and
 * what actually delivers the property the grace window exists for — is to issue a
 * *replacement* child under the same parent and kill the one that was never
 * successfully delivered.
 *
 * The observable behaviour is the one the doc wants: a client that retried because
 * the first response was lost gets a working token instead of a forced logout, and
 * no second lineage is created. What differs is that the first child's plaintext
 * stops working — which is correct, because the only party who might hold it is
 * whoever received a response the retrying client did not.
 *
 * `revoked = true` on the old child rather than deletion, so the lineage stays
 * legible: a family walk after a later theft signal must still see that this link
 * existed.
 */
export async function graceRotate(
  client: Client,
  a: { parentId: string; oldChildId: string; sessionId: string; userId: string; childHash: Buffer },
): Promise<{ childId: string } | undefined> {
  await client.query('BEGIN');
  try {
    // Conditional on the old child still being unspent: if it has been used in
    // the meantime, this is no longer a lost-response retry — it is a real replay
    // and the caller must fall through to the theft path.
    const { rows: killed } = await client.query<{ id: string }>(
      `UPDATE auth.refresh_tokens SET revoked = true
        WHERE id = $1::bigint AND used_at IS NULL AND revoked = false
        RETURNING id::text AS id`, [a.oldChildId]);
    if (!killed[0]) { await client.query('ROLLBACK'); return undefined; }

    const { rows: child } = await client.query<{ id: string }>(
      `INSERT INTO auth.refresh_tokens (token_hash, user_id, session_id, parent_id)
       VALUES ($1, $2, $3, $4::bigint) RETURNING id::text AS id`,
      [a.childHash, a.userId, a.sessionId, a.parentId]);
    await client.query(
      `UPDATE auth.sessions SET last_refreshed_at = now() WHERE id = $1`, [a.sessionId]);
    await client.query('COMMIT');
    return { childId: child[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Kill a session and every token in its lineage.
 *
 * Used for the theft signal and for logout, and it is the same operation for both
 * because "this session is over" has one meaning. The token update is not
 * decoration: a session row alone would leave the family's tokens looking valid to
 * any code path that forgets to join the session — and one such path is all it
 * takes for a revoked session to keep refreshing.
 */
export async function revokeSessionFamily(
  client: Client, sessionId: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
      [sessionId]);
    await client.query(
      `UPDATE auth.refresh_tokens SET revoked = true
        WHERE session_id = $1 AND revoked = false`, [sessionId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Revoke a user's sessions: this one, all of them, or all but this one.
 *
 * Returns how many were revoked, which is what makes `?scope=global` reportable
 * and what a test can assert on.
 */
export async function revokeUserSessions(
  client: Client, userId: string,
  scope: 'local' | 'global' | 'others', currentSessionId: string,
): Promise<number> {
  const predicate = scope === 'local' ? 'AND s.id = $2'
    : scope === 'others' ? 'AND s.id <> $2'
    : '';
  // The parameter list follows the predicate, not the other way round. `global`
  // names no `$2`, and sending one anyway is a bind error — "bind message
  // supplies 2 parameters, but prepared statement requires 1" — which surfaced
  // as a 500 from `?scope=global` while `local` and `others` worked, because
  // those two reference it. Passing an unused parameter is not harmless in
  // Postgres the way it is in some drivers.
  const params = predicate ? [userId, currentSessionId] : [userId];
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE auth.sessions s SET revoked_at = now()
        WHERE s.user_id = $1 AND s.revoked_at IS NULL ${predicate}
        RETURNING s.id`, params);
    if (rows.length) {
      await client.query(
        `UPDATE auth.refresh_tokens SET revoked = true
          WHERE session_id = ANY($1::uuid[]) AND revoked = false`,
        [rows.map((r) => r.id)]);
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export interface SessionRow {
  id: string;
  createdAt: Date;
  lastRefreshedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

/** A user's live sessions, newest first. Revoked ones are gone, not listed dead. */
export async function listSessions(
  client: Client, userId: string,
): Promise<SessionRow[]> {
  const { rows } = await client.query<{
    id: string; created_at: Date; last_refreshed_at: Date | null;
    user_agent: string | null; ip: string | null;
  }>(
    `SELECT id, created_at, last_refreshed_at, user_agent, host(ip) AS ip
       FROM auth.sessions
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY COALESCE(last_refreshed_at, created_at) DESC`, [userId]);
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, lastRefreshedAt: r.last_refreshed_at,
    userAgent: r.user_agent, ip: r.ip,
  }));
}

/**
 * Is this session still usable by its bearer?
 *
 * The user id is part of the predicate, not just the session id. A bearer token
 * naming a session that belongs to somebody else is either a bug or an attack, and
 * either way it must not resolve — checking only the session id would let a forged
 * `sub` claim operate on a session it does not own.
 */
export async function liveSession(
  client: Client, sessionId: string, userId: string,
): Promise<{ id: string } | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT s.id FROM auth.sessions s
       JOIN auth.users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
        AND u.deleted_at IS NULL`, [sessionId, userId]);
  return rows[0];
}

/** Revoke one session by id, but only if it belongs to this user. */
export async function revokeOwnSession(
  client: Client, sessionId: string, userId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE auth.sessions SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [sessionId, userId]);
  if (!rows[0]) return false;
  await client.query(
    `UPDATE auth.refresh_tokens SET revoked = true WHERE session_id = $1`, [sessionId]);
  return true;
}

// ── /user (P4f, flows §7, §8, §9) ───────────────────────────────────────────

/**
 * Merge into `raw_user_meta_data`.
 *
 * `||` rather than a replacement, so a client that sends `{locale: 'fr'}` does not
 * wipe the avatar URL it did not mention — which is what every client would
 * accidentally do at some point otherwise, and the loss is silent.
 *
 * `raw_app_meta_data` is deliberately untouchable here. It is the
 * service_role-writable half, and the entire reason the two columns exist
 * separately is that this endpoint is user-writable: a user who can write
 * `app_metadata` can grant themselves whatever a policy reads from it.
 */
export async function updateUserMetadata(
  client: Client, userId: string, patch: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE auth.users
        SET raw_user_meta_data = raw_user_meta_data || $2::jsonb, updated_at = now()
      WHERE id = $1`, [userId, JSON.stringify(patch)]);
}

/**
 * Apply a completed email change.
 *
 * `email_confirmed_at = now()` because the new address has just proved itself by
 * consuming a token sent to it. Leaving the old confirmation timestamp would
 * assert that an address we have never mailed is confirmed.
 *
 * Returns false when the address was taken in the meantime, which is a real race:
 * two users can request a change to the same address and both get their tokens.
 * The partial unique index decides it, and the loser is told rather than 500ing.
 */
export async function applyEmailChange(
  client: Client, userId: string, newEmail: string,
): Promise<boolean> {
  try {
    const { rowCount } = await client.query(
      `UPDATE auth.users
          SET email = $2, email_confirmed_at = now(), updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`, [userId, newEmail]);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    // 23505 is unique_violation. Distinguished from every other error, because
    // "that address is already in use" is actionable and a 500 is not.
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

/**
 * The sibling token of an email change, and whether it has been spent.
 *
 * Flow 9's rule — the change applies only when *both* addresses have confirmed —
 * is a question about a token other than the one just presented, so it needs its
 * own lookup. `used_at IS NOT NULL` on the sibling is the whole condition.
 */
export async function siblingConsumed(
  client: Client, userId: string, type: TokenType,
): Promise<boolean> {
  const { rows } = await client.query<{ used: boolean }>(
    `SELECT (used_at IS NOT NULL) AS used FROM auth.one_time_tokens
      WHERE user_id = $1 AND token_type = $2`, [userId, type]);
  return rows[0]?.used ?? false;
}

/** The proposed address for a pending change, from either token's `relates_to`. */
export async function pendingEmailChange(
  client: Client, userId: string,
): Promise<string | undefined> {
  const { rows } = await client.query<{ relates_to: string | null }>(
    `SELECT relates_to FROM auth.one_time_tokens
      WHERE user_id = $1 AND token_type IN ('email_change_current','email_change_new')
        AND relates_to IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows[0]?.relates_to ?? undefined;
}

/** Drop both email-change tokens, once the change is applied or abandoned. */
export async function clearEmailChangeTokens(
  client: Client, userId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM auth.one_time_tokens
      WHERE user_id = $1 AND token_type IN ('email_change_current','email_change_new')`,
    [userId]);
}

/**
 * Look a one-time token up across several types.
 *
 * An email-change link says `type=email_change`, and which of the two token types
 * it is depends on which address it was sent to — the link cannot say, because the
 * token is opaque and the recipient must not be able to tell the two apart. So the
 * lookup is by hash across both, and the type comes back with the row.
 */
export async function consumeEitherToken(
  client: Client, types: readonly TokenType[], hash: Buffer,
): Promise<(ConsumedToken & { type: TokenType }) | undefined> {
  const { rows } = await client.query<{
    id: string; user_id: string; relates_to: string | null; token_type: TokenType;
  }>(
    `UPDATE auth.one_time_tokens t
        SET used_at = now()
      WHERE t.token_type = ANY($1::text[])
        AND t.token_hash = $2
        AND t.used_at IS NULL
        AND t.expires_at > now()
        AND EXISTS (SELECT 1 FROM auth.users u
                     WHERE u.id = t.user_id AND u.deleted_at IS NULL)
      RETURNING t.id::text AS id, t.user_id, t.relates_to, t.token_type`,
    [types, hash]);
  return rows[0]
    ? { id: rows[0].id, userId: rows[0].user_id, relatesTo: rows[0].relates_to,
        type: rows[0].token_type }
    : undefined;
}

// ── /admin/users (P4g, flows §10, D-114) ────────────────────────────────────

/**
 * A page of users, newest first, keyset-paginated on `(created_at, id)`.
 *
 * Soft-deleted rows are excluded. A tombstone carries no email, no password and
 * no metadata (see `softDeleteUser`), so listing them would show a developer a
 * page of `deleted+<uuid>@invalid` rows with nothing to act on — and the
 * developer's own tables are where a deleted user's history actually lives.
 */
export async function listUsers(
  client: Client, a: { limit: number; cursor?: { created_at: string; id: string } | undefined },
): Promise<AuthUser[]> {
  // `limit + 1`, so `has_more` is a fact rather than a second racing count.
  const { rows } = a.cursor
    ? await client.query<AuthUser>(
        `SELECT ${USER_COLUMNS} FROM auth.users
          WHERE deleted_at IS NULL
            AND (created_at, id) < ($2::timestamptz, $3::uuid)
          ORDER BY created_at DESC, id DESC LIMIT $1`,
        [a.limit + 1, a.cursor.created_at, a.cursor.id])
    : await client.query<AuthUser>(
        `SELECT ${USER_COLUMNS} FROM auth.users
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT $1`, [a.limit + 1]);
  return rows;
}

export interface AdminUpdate {
  /** Set or clear a ban. `null` unbans. */
  bannedUntil?: Date | null | undefined;
  /** Confirm an address without the user clicking anything. */
  emailConfirm?: boolean | undefined;
  /** A new password, already hashed. */
  passwordHash?: string | undefined;
  /** The service_role-writable half of the metadata. Merged, not replaced. */
  appMetadata?: Record<string, unknown> | undefined;
  /** The user half, so an admin tool can fix a bad value. Merged. */
  userMetadata?: Record<string, unknown> | undefined;
  email?: string | undefined;
}

/**
 * Apply a developer-side update.
 *
 * Built as a dynamic SET list rather than one statement per field, because the
 * alternative is five round trips for one request and a half-applied update if
 * the third fails. Every fragment is a literal in this file and every value is a
 * bound parameter — the list is assembled, never the values.
 *
 * Returns `undefined` when there is no such user, so the route can answer 404
 * rather than reporting a successful update of nothing.
 */
export async function adminUpdateUser(
  client: Client, userId: string, u: AdminUpdate,
): Promise<AuthUser | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$n', `$${params.length}`));
  };

  if (u.bannedUntil !== undefined) add('banned_until = $n::timestamptz', u.bannedUntil);
  if (u.emailConfirm !== undefined) {
    // Confirming is idempotent; *unconfirming* clears the timestamp, which is a
    // legitimate admin action after a support ticket about a wrong address.
    add('email_confirmed_at = CASE WHEN $n::boolean THEN COALESCE(email_confirmed_at, now()) ELSE NULL END',
      u.emailConfirm);
  }
  if (u.passwordHash !== undefined) add('encrypted_password = $n', u.passwordHash);
  if (u.appMetadata !== undefined) {
    add('raw_app_meta_data = raw_app_meta_data || $n::jsonb', JSON.stringify(u.appMetadata));
  }
  if (u.userMetadata !== undefined) {
    add('raw_user_meta_data = raw_user_meta_data || $n::jsonb', JSON.stringify(u.userMetadata));
  }
  if (u.email !== undefined) add('email = $n', u.email);
  if (!sets.length) return findUserById(client, userId);

  const { rows } = await client.query<AuthUser>(
    `UPDATE auth.users SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${USER_COLUMNS}`, params);
  return rows[0];
}

/**
 * Flow 10's soft delete, in one transaction.
 *
 * Soft, not hard, and the tombstone is the point: rows in the customer's own
 * tables reference `auth.users(id)`, and Steadhold does not cascade into app
 * schemas (their FK semantics are theirs). A hard delete would either break those
 * references or require us to decide what happens to a customer's data, and
 * neither is ours to do.
 *
 * What the tombstone keeps is the id and nothing else. `email` becomes
 * `deleted+<id>@invalid` — a syntactically valid address in a reserved TLD that
 * can never receive mail — which frees the real address for re-registration via
 * the partial unique index while keeping the row's identity stable for the
 * developer's foreign keys. Password and metadata are scrubbed, because "deleted"
 * that leaves a password hash and a full profile behind is not deletion in any
 * sense a user would recognise.
 */
export async function softDeleteUser(
  client: Client, userId: string,
): Promise<{ email: string | null } | undefined> {
  await client.query('BEGIN');
  try {
    // Read the address first, in the same transaction, rather than reaching for
    // it from inside `RETURNING`. A subquery there would see the statement's
    // pre-update snapshot and so happens to give the old value — correct today
    // and for a reason nobody reading it would be sure of, which is a poor thing
    // to build a "which address was freed" report on.
    const { rows: before } = await client.query<{ email: string | null }>(
      `SELECT email FROM auth.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [userId]);
    if (!before[0]) { await client.query('ROLLBACK'); return undefined; }

    await client.query(
      `UPDATE auth.users
          SET deleted_at = now(),
              email = 'deleted+' || id::text || '@invalid',
              encrypted_password = NULL,
              raw_user_meta_data = '{}'::jsonb,
              raw_app_meta_data = '{}'::jsonb,
              email_confirmed_at = NULL,
              updated_at = now()
        WHERE id = $1`, [userId]);

    // Sessions and their lineages, then the outstanding links. A deleted user
    // whose recovery token still works is a deleted user who can be signed back
    // in from an inbox.
    await client.query(
      `UPDATE auth.sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await client.query(
      `UPDATE auth.refresh_tokens SET revoked = true
        WHERE user_id = $1 AND revoked = false`, [userId]);
    await client.query(`DELETE FROM auth.one_time_tokens WHERE user_id = $1`, [userId]);
    await client.query('COMMIT');
    return before[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Revoke every session a user has, without touching the account. */
export async function adminSignOutUser(
  client: Client, userId: string,
): Promise<number> {
  return revokeUserSessions(client, userId, 'global',
    // `global` ignores the current-session parameter, so any uuid does — and this
    // caller has no session of its own, which is the whole point of the admin
    // surface: it acts on a user without being one.
    '00000000-0000-0000-0000-000000000000');
}
