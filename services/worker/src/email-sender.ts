import type { Pool } from 'pg';
import {
  render, EmailSendError,
  type EmailProvider, type TemplateName, type TemplateVariables,
} from '@steadhold/email';
import type { AuthEmailJobData } from '@steadhold/queue';

/**
 * The consumer that turns an owed email into a sent one (P4d).
 *
 * ## What it is responsible for, and what it is not
 *
 * Not caps and not suppression — both are checked at enqueue (see the API's
 * `mailer.ts`), because refusing a burst while it is one Redis round trip is the
 * whole point of having caps. This is: render, send, record, and decide whether a
 * failure is worth another attempt.
 *
 * ## Idempotency lives in the send row, not in the queue
 *
 * BullMQ deduplicates by job id, which covers a *duplicate enqueue*. It does not
 * cover the case that actually produces duplicate mail: a worker that sends
 * successfully and then dies before recording it. BullMQ re-delivers the job, the
 * provider has already accepted the message, and the user gets two. So the row is
 * checked first — a row already `sent` short-circuits — and updated immediately
 * after the provider accepts.
 *
 * The window between those two is real and irreducible without a provider that
 * supports an idempotency key: a crash in it sends twice. What it is not is
 * *silent* — the row's `attempts` shows the retry, so a duplicate is explicable
 * rather than mysterious.
 */

export interface EmailSenderDeps {
  pool: Pool;
  provider: EmailProvider;
  /** `Steadhold Auth <auth@mail.steadhold.app>` in production. */
  from: string;
  fromName?: string | undefined;
  /** Reported when a job has spent its whole retry budget. */
  onDeadLetter?: ((data: AuthEmailJobData, error: string) => void) | undefined;
  metrics?: {
    sent: (template: string) => void;
    failed: (template: string, retryable: boolean) => void;
    deadLettered: (template: string) => void;
  } | undefined;
}

export interface SendOutcome {
  status: 'sent' | 'skipped' | 'failed';
  providerId?: string | undefined;
  error?: string | undefined;
}

/**
 * `"Acme (via Steadhold)"`.
 *
 * The project's name in the friendly-from, because a recipient needs to know
 * whose app is talking — a verification mail from an unrecognised "Steadhold" for
 * an app called Acme reads like phishing, which is both a support burden and a
 * complaint-rate problem. "via Steadhold" rather than plain "Acme" because the
 * envelope address is ours and claiming to *be* Acme while sending from
 * `mail.steadhold.app` is what DMARC alignment checks exist to catch.
 */
export const friendlyFrom = (projectName: string | undefined): string =>
  projectName ? `${projectName} (via Steadhold)` : 'Steadhold Auth';

export function createEmailSender(deps: EmailSenderDeps) {
  return {
    /**
     * Handle one job. Throwing asks BullMQ for a retry; returning does not.
     *
     * The distinction is deliberate and is the only control over the retry
     * budget: a permanent failure that throws burns three attempts over 35
     * minutes and delays every mail behind it, and a transient failure that
     * returns drops somebody's verification mail on a network blip.
     */
    async handle(data: AuthEmailJobData, attemptsMade = 0): Promise<SendOutcome> {
      const attempt = attemptsMade + 1;

      const { rows: existing } = await deps.pool.query<{ status: string }>(
        `SELECT status FROM email_sends WHERE project_id = $1 AND delivery_id = $2`,
        [data.project_id, data.delivery_id]);
      if (existing[0]?.status === 'sent') {
        // A re-delivery after a successful send. Returning rather than throwing:
        // this is the mail already being in the inbox, which is success.
        return { status: 'skipped' };
      }

      const { rows: proj } = await deps.pool.query<{ name: string; ref: string }>(
        `SELECT name, ref::text AS ref FROM projects WHERE id = $1`, [data.project_id]);
      const projectName = proj[0]?.name;

      let rendered;
      try {
        const vars: TemplateVariables = {
          ...(data.variables['action_url'] ? { ConfirmationURL: data.variables['action_url'] } : {}),
          ...(data.variables['token'] ? { Token: data.variables['token'] } : {}),
          ...(data.variables['site_url'] ? { SiteURL: data.variables['site_url'] } : {}),
          ...(data.variables['new_email'] ? { NewEmail: data.variables['new_email'] } : {}),
          Email: data.to,
          ...(projectName ? { ProjectName: projectName } : {}),
        };
        rendered = render(data.template as TemplateName, vars);
      } catch (err) {
        // A template that cannot render will never render. Retrying it three
        // times changes nothing and delays real mail, so it is dead-lettered
        // immediately — and it is a bug in us, not in the project's data.
        const error = `template ${data.template} did not render: ${(err as Error).message}`;
        await fail(deps, data, attempt, error, false);
        return { status: 'failed', error };
      }

      try {
        const result = await deps.provider.send({
          from: deps.from,
          fromName: friendlyFrom(projectName),
          to: data.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tag: data.template,
          // Correlates a delivery or bounce webhook back to the row. The ref is
          // there because a provider's dashboard is where an operator looks
          // first, and a bare uuid tells them nothing.
          metadata: { project_ref: data.project_ref, delivery_id: data.delivery_id },
        });
        await deps.pool.query(
          `UPDATE email_sends SET status = 'sent', attempts = $3, provider_id = $4,
                  error = NULL, updated_at = now()
            WHERE project_id = $1 AND delivery_id = $2`,
          [data.project_id, data.delivery_id, attempt, result.providerId]);
        deps.metrics?.sent(data.template);
        return { status: 'sent', providerId: result.providerId };
      } catch (err) {
        const retryable = err instanceof EmailSendError ? err.retryable : true;
        const error = (err as Error).message;
        await fail(deps, data, attempt, error, retryable);
        // Rethrown only while there is budget left *and* it is worth spending.
        if (retryable && attempt < 3) throw err;
        return { status: 'failed', error };
      }
    },
  };
}

async function fail(
  deps: EmailSenderDeps, data: AuthEmailJobData,
  attempt: number, error: string, retryable: boolean,
): Promise<void> {
  await deps.pool.query(
    `UPDATE email_sends SET status = 'failed', attempts = $3, error = $4, updated_at = now()
      WHERE project_id = $1 AND delivery_id = $2`,
    [data.project_id, data.delivery_id, attempt, error.slice(0, 2000)]);
  deps.metrics?.failed(data.template, retryable);
  if (!retryable || attempt >= 3) {
    // Dead-lettered: three attempts across 35 minutes, or one attempt at
    // something that will never work. Reported rather than logged and forgotten,
    // because the person affected is a user who never got their verification
    // mail and who has no way to tell anyone.
    deps.metrics?.deadLettered(data.template);
    deps.onDeadLetter?.(data, error);
  }
}
