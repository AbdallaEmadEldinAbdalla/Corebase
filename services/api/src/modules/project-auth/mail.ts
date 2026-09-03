/**
 * The seam between a flow that owes an email and the thing that sends it (P4c).
 *
 * ## Why this is an interface and not a sender
 *
 * The pipeline — templates, per-project caps, suppression lists, bounce handling
 * — is P4d and is genuinely large (email infrastructure §"caps", D-116). What
 * P4c needs from it is only the boundary: a flow decides an email is owed, names
 * which one and with what variables, and hands it over. Building that boundary
 * now is what keeps the flows from being rewritten when the sender lands.
 *
 * ## The row of record is the token, not the queue
 *
 * D-018's rule is that Redis is a delivery mechanism and never the source of
 * truth. For provisioning the row of record is `provisioning_jobs`; here it is
 * the `auth.one_time_tokens` row in the project's own database, which is why the
 * delivery id **is** the token id (email infrastructure §pipeline). If Redis
 * loses the job, the token still exists and is still unsent — recoverable. If the
 * queue were the record, a Redis flush would be a user who never gets their
 * verification mail and no trace of the fact anywhere.
 *
 * A consequence worth stating plainly: until P4d there is no consumer, so an
 * enqueued job waits. That is the honest state of a half-built pipeline — the
 * mail is owed and nothing sends it — and it is visible in Redis rather than
 * silently dropped on the floor.
 */

export type AuthEmail =
  | 'confirmation'
  | 'recovery'
  /**
   * Sent when a signup names an address that already has a confirmed account.
   * The HTTP response cannot say the address is taken (flows §1), so this mail is
   * the only way the real owner learns somebody tried — and it goes to an address
   * whose owner already has an account, so it discloses nothing new to whoever
   * triggered it.
   */
  | 'account_exists_notice';

export interface AuthEmailJob {
  /** The delivery id, and the reason it is the token id — see above. */
  deliveryId: string;
  projectId: string;
  projectRef: string;
  email: AuthEmail;
  to: string;
  /**
   * Interpolated into a Corebase-controlled template. Never HTML, never a URL
   * the client chose: `action_url` is built here from the *validated* redirect
   * (D-116 — fixed templates are what stop this being a phishing kit).
   */
  variables: Record<string, string>;
}

export interface AuthMailer {
  /**
   * Hand over an owed email. **Must not throw** — an enumeration-safe flow has
   * already committed to returning 200, and a send failure that becomes a 500
   * both breaks the response-shape contract and tells the caller their address
   * was interesting.
   */
  enqueue(job: AuthEmailJob): Promise<void>;
}

/**
 * Records jobs and sends nothing. The default until P4d.
 *
 * It keeps the last few jobs in memory purely so `/health`-style introspection
 * and tests can see that a flow really did hand one over. Bounded, because an
 * unbounded buffer in a long-running process is a leak, and this one would be fed
 * by an unauthenticated endpoint.
 */
export function createNullMailer(limit = 100): AuthMailer & { jobs: AuthEmailJob[] } {
  const jobs: AuthEmailJob[] = [];
  return {
    jobs,
    async enqueue(job) {
      jobs.push(job);
      if (jobs.length > limit) jobs.splice(0, jobs.length - limit);
    },
  };
}
