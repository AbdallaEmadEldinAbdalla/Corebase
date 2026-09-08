import type { Pool } from 'pg';
import { generateKeypair, sign as signJwt, projectKeyClaims, toJwk, keyLabel } from '@steadhold/jwt';
import { SECRET_NAMES, type SecretStore } from '@steadhold/secrets';
import { createHash } from 'node:crypto';

/**
 * The signing-key rotation runbook, as code (P4h, sessions & tokens
 * §"Signing-key rotation runbook").
 *
 * ## Why this is three operations and not one
 *
 * The runbook's whole value is the **waiting** between its steps, and a single
 * `rotateKey()` would collapse exactly that. Step 2 exists so cached verifiers
 * already hold the new key before anything is signed with it — a verifier that
 * caches JWKS for ten minutes and meets a token signed by a key it fetched
 * eleven minutes ago rejects a perfectly valid token. Step 5 exists because the
 * *same keypair signs the project's anon and service_role keys* (D-029, D-107):
 * user tokens die within an hour, but a customer's deployed frontend holds an
 * anon key for as long as it takes them to ship, so removing the old key early
 * breaks their application rather than their sessions.
 *
 * So: `begin` publishes, `cutOver` switches signing, `retire` un-publishes, and
 * an operator (or a scheduled sweep) decides when each happens. The emergency
 * path is the same three called back to back, which is the runbook's own answer
 * for a confirmed leak — every outstanding token and both API keys die at once,
 * and that is the point.
 *
 * ## What stays where
 *
 * The currently-signing key never moves: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` and
 * `JWT_KID` in `project_secrets`, exactly as P1e left them. Nothing about signing
 * or about an unrotated project changes. `project_signing_keys` holds only the
 * keys a project publishes *without* signing with them.
 */

export interface RotationDeps {
  pool: Pool;
  secrets: SecretStore;
  /** Must match what the project's existing API keys carry, or reminting breaks them. */
  keyIssuer?: ((ref: string) => string) | undefined;
  log?: ((msg: string, extra?: Record<string, unknown>) => void) | undefined;
}

/** The default swap window for the old key — OQ-104's 30 days. */
export const SWAP_WINDOW_DAYS = Number(process.env.SH_KEY_SWAP_DAYS ?? 30);

/** `JWT_PRIVATE_KEY_CBK_2026_09_7F3A` — the per-kid name for a non-signing key. */
export const privateKeyName = (kid: string) =>
  `${SECRET_NAMES.jwtPrivateKey}_${kid.toUpperCase()}`;

export interface PublishedKey {
  kid: string;
  publicKeyPem: string;
  status: 'active' | 'next' | 'retiring';
}

/**
 * Every key a verifier should currently accept, active first.
 *
 * Active first because it is the one that will match most tokens, and because a
 * verifier trying keys in order should try the likely one first. `retired` rows
 * are excluded — that is what retiring a key *means*.
 */
export async function publishedKeys(
  deps: RotationDeps, projectId: string,
): Promise<PublishedKey[]> {
  const [pub, kid] = await Promise.all([
    deps.secrets.get(projectId, SECRET_NAMES.jwtPublicKey),
    deps.secrets.get(projectId, SECRET_NAMES.jwtKid),
  ]);
  const out: PublishedKey[] = [];
  if (pub && kid) out.push({ kid, publicKeyPem: pub, status: 'active' });

  const { rows } = await deps.pool.query<{ kid: string; public_key_pem: string; status: string }>(
    `SELECT kid, public_key_pem, status FROM project_signing_keys
      WHERE project_id = $1 AND status IN ('next', 'retiring')
      ORDER BY published_at`, [projectId]);
  for (const r of rows) {
    out.push({ kid: r.kid, publicKeyPem: r.public_key_pem, status: r.status as 'next' | 'retiring' });
  }
  return out;
}

/** The JWKS document: every published key, in the order above. */
export async function jwksFor(
  deps: RotationDeps, projectId: string,
): Promise<{ keys: Array<Record<string, string | string[]>> }> {
  const keys = await publishedKeys(deps, projectId);
  return { keys: keys.map((k) => toJwk(k.publicKeyPem, k.kid)) };
}

/**
 * Step 1–2 — generate the next key and publish it, without signing anything.
 *
 * Idempotent on the `next` row: calling it twice returns the key already waiting
 * rather than replacing it. A second keypair would orphan the first — published
 * to verifiers that are now caching a key nothing will ever sign with — and an
 * operator who ran the command twice because the first output scrolled away
 * should not have created that.
 */
export async function beginRotation(
  deps: RotationDeps, projectId: string,
): Promise<{ kid: string; created: boolean; publishedAt: Date }> {
  const { rows: existing } = await deps.pool.query<{ kid: string; published_at: Date }>(
    `SELECT kid, published_at FROM project_signing_keys
      WHERE project_id = $1 AND status = 'next'`, [projectId]);
  if (existing[0]) {
    return { kid: existing[0].kid, created: false, publishedAt: existing[0].published_at };
  }

  const pair = generateKeypair();
  // Store-then-publish, the same order as store-then-apply (D-035): the private
  // key must exist before anything advertises that the public half is usable. A
  // published key whose private half was lost is a key that can never be cut
  // over to, and the only way out is to retire it and start again.
  await deps.secrets.put(projectId, privateKeyName(pair.kid), pair.privateKeyPem);
  const { rows } = await deps.pool.query<{ published_at: Date }>(
    `INSERT INTO project_signing_keys (project_id, kid, public_key_pem, status)
     VALUES ($1, $2, $3, 'next') RETURNING published_at`,
    [projectId, pair.kid, pair.publicKeyPem]);
  deps.log?.('signing key published, not yet signing', { kid: pair.kid });
  return { kid: pair.kid, created: true, publishedAt: rows[0]!.published_at };
}

export class RotationError extends Error {}

/**
 * Step 4 — start signing with the published key, and re-mint the API keys.
 *
 * The API-key reminting is not an extra: D-029's anon and service_role keys *are*
 * JWTs under this keypair, so a signing rotation is an API-key rotation whether
 * or not anyone planned for it. Minting the new pair here — while the old pair
 * still verifies against the `retiring` key — is what makes the swap window a
 * window rather than an outage. A customer's deployed frontend keeps working on
 * the old anon key until they ship the new one.
 *
 * `minAgeMs` refuses a cut-over that has not waited out the JWKS cache. The wait
 * is the entire reason the step is separate, so skipping it silently would leave
 * the runbook's most important instruction as a comment.
 */
export async function cutOver(
  deps: RotationDeps, projectId: string,
  opts: { minAgeMs?: number; force?: boolean } = {},
): Promise<{ from: string; to: string; retireAfter: Date }> {
  const { rows: next } = await deps.pool.query<{
    kid: string; public_key_pem: string; published_at: Date;
  }>(`SELECT kid, public_key_pem, published_at FROM project_signing_keys
       WHERE project_id = $1 AND status = 'next'`, [projectId]);
  const incoming = next[0];
  if (!incoming) {
    throw new RotationError(
      'there is no `next` key to cut over to — run beginRotation first, and wait '
      + 'out the JWKS cache before cutting over');
  }

  const minAge = opts.minAgeMs ?? 10 * 60_000;
  const age = Date.now() - incoming.published_at.getTime();
  if (!opts.force && age < minAge) {
    // Named with both numbers, because the operator's next question is "how much
    // longer", and an error that makes them compute that from a timestamp is an
    // error that gets forced past.
    throw new RotationError(
      `the new key has only been published for ${Math.round(age / 1000)}s and `
      + `verifiers may cache JWKS for ${Math.round(minAge / 1000)}s. Wait, or pass `
      + 'force for the emergency path (a confirmed key leak), where every '
      + 'outstanding token dying at once is the intent.');
  }

  const [oldPriv, oldPub, oldKid] = await Promise.all([
    deps.secrets.get(projectId, SECRET_NAMES.jwtPrivateKey),
    deps.secrets.get(projectId, SECRET_NAMES.jwtPublicKey),
    deps.secrets.get(projectId, SECRET_NAMES.jwtKid),
  ]);
  if (!oldPub || !oldKid) {
    throw new RotationError('this project has no active signing key to rotate away from');
  }
  const newPriv = await deps.secrets.get(projectId, privateKeyName(incoming.kid));
  if (!newPriv) {
    throw new RotationError(
      `the private half of ${incoming.kid} is missing, so it cannot start signing. `
      + 'Retire it and run beginRotation again.');
  }

  const { rows: proj } = await deps.pool.query<{ ref: string }>(
    `SELECT ref::text AS ref FROM projects WHERE id = $1`, [projectId]);
  const ref = proj[0]?.ref;
  if (!ref) throw new RotationError('no such project');

  const retireAfter = new Date(Date.now() + SWAP_WINDOW_DAYS * 86_400_000);

  // The old key becomes `retiring` *before* the new one starts signing. The
  // reverse order leaves a window in which tokens signed by the old key verify
  // against nothing published — brief, and long enough to reject a valid token.
  await deps.pool.query(
    `INSERT INTO project_signing_keys
       (project_id, kid, public_key_pem, status, retire_after)
     VALUES ($1, $2, $3, 'retiring', $4)
     ON CONFLICT (project_id, kid) DO UPDATE
        SET status = 'retiring', retire_after = excluded.retire_after`,
    [projectId, oldKid, oldPub, retireAfter]);
  // Keep the old private half under its own name so a retired key is still
  // auditable — the runbook's "keep ciphertext for audit". `JWT_PRIVATE_KEY` is
  // about to be overwritten.
  if (oldPriv) await deps.secrets.put(projectId, privateKeyName(oldKid), oldPriv);

  // `replace`, not `put`. `put` is create-if-absent and these three names all
  // exist, so it is a silent no-op — which produced a rotation where JWKS
  // published both keys, the cut-over reported success, and every token still
  // carried the old kid.
  await deps.secrets.replace(projectId, SECRET_NAMES.jwtPrivateKey, newPriv);
  await deps.secrets.replace(projectId, SECRET_NAMES.jwtPublicKey, incoming.public_key_pem);
  await deps.secrets.replace(projectId, SECRET_NAMES.jwtKid, incoming.kid);
  await deps.pool.query(
    `DELETE FROM project_signing_keys WHERE project_id = $1 AND kid = $2`,
    [projectId, incoming.kid]);

  await remintApiKeys(deps, projectId, ref, newPriv, incoming.kid);
  deps.log?.('signing cut over', { from: oldKid, to: incoming.kid, retire_after: retireAfter });
  return { from: oldKid, to: incoming.kid, retireAfter };
}

/**
 * Mint anon and service_role under the new key, leaving the old rows valid.
 *
 * `project_api_keys` keeps a hash per key for revocation, and the old rows are
 * deliberately *not* revoked here: they verify against the `retiring` public key
 * and must keep working for the whole swap window. `retire` is what kills them,
 * which is why retirement is gated on the API-key window rather than on token
 * expiry.
 */
async function remintApiKeys(
  deps: RotationDeps, projectId: string, ref: string,
  privateKeyPem: string, kid: string,
): Promise<void> {
  const issuer = deps.keyIssuer?.(ref)
    ?? process.env['SH_JWT_ISSUER']
    ?? `https://${ref}.${process.env['SH_PROJECT_DOMAIN'] ?? 'steadhold.app'}`;
  for (const role of ['anon', 'service_role'] as const) {
    const token = signJwt(projectKeyClaims({ ref, role, issuer }), { privateKeyPem, kid });
    const name = role === 'anon' ? SECRET_NAMES.anonKey : SECRET_NAMES.serviceRoleKey;
    // Same reason as above: these names already exist from provisioning.
    await deps.secrets.replace(projectId, name, token);
    const prefix = keyLabel(role, ref);
    await deps.pool.query(
      `INSERT INTO project_api_keys (project_id, kind, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4) ON CONFLICT (key_hash) DO NOTHING`,
      [projectId, role, createHash('sha256').update(token).digest('hex'), prefix]);
  }
}

/**
 * Step 5 — drop a retiring key from JWKS.
 *
 * Every token and API key signed by it stops verifying at this instant, which is
 * the whole effect and the reason it is a separate command with its own gate. The
 * row and its ciphertext stay: an audit six weeks later asking what signed a
 * given token needs the key, and a `retired` row is the only place that answer
 * lives.
 */
export async function retire(
  deps: RotationDeps, projectId: string, kid: string,
  opts: { force?: boolean } = {},
): Promise<{ retired: boolean; reason?: string }> {
  const { rows } = await deps.pool.query<{ retire_after: Date | null; status: string }>(
    `SELECT retire_after, status FROM project_signing_keys
      WHERE project_id = $1 AND kid = $2`, [projectId, kid]);
  const row = rows[0];
  if (!row) return { retired: false, reason: 'no such key for this project' };
  if (row.status === 'retired') return { retired: false, reason: 'already retired' };
  if (row.status === 'next') {
    // Legitimate: abandoning a rotation before cutting over. Nothing was ever
    // signed with it, so there is nothing to break.
    await deps.pool.query(
      `UPDATE project_signing_keys SET status = 'retired', retired_at = now()
        WHERE project_id = $1 AND kid = $2`, [projectId, kid]);
    deps.log?.('abandoned an unused next key', { kid });
    return { retired: true };
  }
  if (!opts.force && row.retire_after && row.retire_after.getTime() > Date.now()) {
    const days = Math.ceil((row.retire_after.getTime() - Date.now()) / 86_400_000);
    return {
      retired: false,
      reason: `the API-key swap window has ${days} day(s) left. Retiring now kills `
        + 'every anon and service_role key minted under this kid, which is a '
        + 'customer\'s deployed frontend, not just their sessions.',
    };
  }
  await deps.pool.query(
    `UPDATE project_signing_keys SET status = 'retired', retired_at = now()
      WHERE project_id = $1 AND kid = $2`, [projectId, kid]);
  deps.log?.('signing key retired — its tokens and API keys are now dead', { kid });
  return { retired: true };
}

/** Keys whose swap window has closed. The input to a scheduled retirement sweep. */
export async function dueForRetirement(
  deps: RotationDeps,
): Promise<Array<{ projectId: string; kid: string }>> {
  const { rows } = await deps.pool.query<{ project_id: string; kid: string }>(
    `SELECT project_id, kid FROM project_signing_keys
      WHERE status = 'retiring' AND retire_after IS NOT NULL AND retire_after <= now()`);
  return rows.map((r) => ({ projectId: r.project_id, kid: r.kid }));
}
