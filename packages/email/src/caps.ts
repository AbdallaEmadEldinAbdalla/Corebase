/**
 * Per-project send caps (D-116, email infrastructure §abuse containment).
 *
 * ## What these are defending
 *
 * Not our bill. The threat is that `/signup` and `/recover` let any anonymous
 * visitor cause Steadhold to email an arbitrary address, and V1 sends every
 * project's mail from one domain — so one attacker with a free project can use us
 * as a bulk mailer or mail-bomb a victim, and the reputation damage lands on every
 * project on the platform. These caps are the blast radius.
 *
 * ## Why they are separate from the request limits
 *
 * The endpoint limits in flows §rate-limits bound *requests*, per project and per
 * address. These bound *sends*, per project. The two are not redundant: five
 * projects each staying politely under their request limit still add up to one
 * inbox getting mail-bombed, and a project whose users legitimately hit the
 * endpoint limits has still sent nothing.
 */

export interface EmailCaps {
  perHour: number;
  perDay: number;
  /** Distinct recipients per day — the bulk-mailer signal specifically. */
  distinctRecipientsPerDay: number;
  /** To one address, per hour. The mail-bomb signal. */
  perRecipientPerHour: number;
  /** To one address, per day. */
  perRecipientPerDay: number;
}

export const CAPS: Record<string, EmailCaps> = {
  free: {
    perHour: 30, perDay: 200, distinctRecipientsPerDay: 100,
    perRecipientPerHour: 4, perRecipientPerDay: 10,
  },
  pro: {
    perHour: 200, perDay: 2000, distinctRecipientsPerDay: 1000,
    perRecipientPerHour: 8, perRecipientPerDay: 40,
  },
  team: {
    perHour: 500, perDay: 10_000, distinctRecipientsPerDay: 5000,
    perRecipientPerHour: 8, perRecipientPerDay: 40,
  },
};

/**
 * The caps for a plan, halved for a project under 24 hours old on Free.
 *
 * The new-project throttle is the doc's, and it is the cheapest useful control
 * here: abuse arrives on brand-new free projects, because that is the account an
 * attacker is willing to lose. A project that has existed for a day and sends
 * steadily is a different risk from one created ten minutes ago.
 *
 * An unknown plan gets Free's caps rather than no caps. Fail-closed: a plan name
 * that does not match is a bug, and the version of that bug where a project sends
 * without limit is the one that costs a sending domain.
 */
export function capsFor(plan: string, projectAgeMs?: number): EmailCaps {
  const base = CAPS[plan] ?? CAPS['free']!;
  const young = plan === 'free' && projectAgeMs !== undefined && projectAgeMs < 24 * 3600 * 1000;
  if (!young) return base;
  return {
    perHour: Math.ceil(base.perHour / 2),
    perDay: Math.ceil(base.perDay / 2),
    distinctRecipientsPerDay: Math.ceil(base.distinctRecipientsPerDay / 2),
    // Not halved: 4/hour to one address is already the floor a real person needs
    // (sign up, mistype, resend, reset), and halving it to 2 would make a
    // legitimate first five minutes hit the cap.
    perRecipientPerHour: base.perRecipientPerHour,
    perRecipientPerDay: base.perRecipientPerDay,
  };
}
