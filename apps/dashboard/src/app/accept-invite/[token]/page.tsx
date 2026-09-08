'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMe, useOrgs, useAcceptInvite } from '../../../lib/queries.ts';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { Logo } from '../../../components/Logo.tsx';
import { ThemeToggle } from '../../../components/ThemeToggle.tsx';
import { ApiError, api, clearCsrfToken } from '../../../lib/api.ts';

/**
 * Accepting an organization invitation.
 *
 * A standalone panel rather than a page inside the org shell, because an invitee
 * may belong to no organization at all — there is no shell to put them in yet.
 *
 * **It does not accept on load.** Joining an organization is consequential and a
 * link that mutates state simply by being opened is the wrong shape: it removes
 * the moment where someone notices they are signed in as the wrong person, and it
 * means anything that fetches the URL — a link preview, a scanner in a mail
 * gateway — joins the org on their behalf. So the page states what will happen,
 * says which account it will happen to, and waits.
 *
 * **Being signed out is the common case**, not an error. `useMe` 401s, the global
 * handler in providers.tsx sends the visitor to `/login?next=<here>`, and they
 * come back. That only works because signup now honours `next` too — it used to
 * redirect to `/` and strand the invitation, which was the more likely path since
 * an invitee usually has no account.
 *
 * **The failure message is relayed, not interpreted.** The platform answers one
 * 404 for expired, revoked, already-used and addressed-to-someone-else, because
 * telling them apart would make an invite token an oracle about who is in an
 * organization. Guessing on the client would rebuild that oracle in the browser.
 * The one thing this page adds is which account is signed in — a fact about the
 * reader's own session rather than about the organization.
 *
 * The sentence beside it has to cover every one of those causes without choosing
 * between them, which the first version did not: it named only the wrong-address
 * case, and so misdescribed the reader who had just accepted and reopened the
 * link. "An invitation works once, and only for the address it was sent to" is
 * true of all four, and states how invitations work rather than anything about
 * this token.
 */
export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const me = useMe();
  const orgs = useOrgs();
  const accept = useAcceptInvite();
  const [joined, setJoined] = useState<string | null>(null);

  /**
   * Route on the slug, which only exists after `orgs` refetches — the accept
   * response carries an `org_id`. Waiting for the slug rather than pushing a URL
   * built from the id keeps the destination a real page instead of a 404.
   */
  useEffect(() => {
    if (!joined) return;
    const org = orgs.data?.orgs.find((o) => o.id === joined);
    if (org) router.replace(`/org/${org.slug}`);
  }, [joined, orgs.data, router]);

  const email = me.data?.user?.email;

  if (me.isPending) {
    return (
      <Shell>
        <div className="sh-skeleton" style={{ width: 220, height: 24 }} />
        <div className="sh-skeleton" style={{ width: '100%', height: 40, marginTop: 24 }} />
      </Shell>
    );
  }

  if (joined) {
    return (
      <Shell>
        <h1 className="auth__title">You're in</h1>
        <p className="auth__sub">Taking you to the organization…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="auth__title">Join this organization</h1>
      <p className="auth__sub">
        Accepting adds your account to the organization and gives you the role the
        invitation was created with.
      </p>

      {accept.error ? (
        <div style={{ marginTop: 'var(--sh-space-16)' }}>
          <ErrorSurface error={accept.error} title="This invitation cannot be used" />
          {accept.error instanceof ApiError && accept.error.status === 404 && email ? (
            <p className="sh-help" style={{ marginTop: 'var(--sh-space-12)' }}>
              You are signed in as <strong>{email}</strong>. An invitation works
              once, and only for the address it was sent to — if it was sent to a
              different account, sign in with that one and open the link again.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="sh-row" style={{ marginTop: 'var(--sh-space-20)', gap: 'var(--sh-space-12)' }}>
        <button type="button" className="sh-btn" disabled={accept.isPending}
          onClick={() => accept.mutate(token, {
            onSuccess: (r) => setJoined(r.org_id),
          })}>
          {accept.isPending ? 'Joining…' : 'Accept invitation'}
        </button>
        <button type="button" className="sh-btn sh-btn--ghost" disabled={accept.isPending}
          onClick={async () => {
            // Signing out returns here, so the next account lands on the same
            // invitation instead of the dashboard.
            try { await api.logout(); } finally {
              clearCsrfToken();
              router.replace(`/login?next=${encodeURIComponent(`/accept-invite/${token}`)}`);
            }
          }}>
          Use a different account
        </button>
      </div>

      {email ? (
        <p className="sh-help" style={{ marginTop: 'var(--sh-space-16)' }}>
          Signed in as <strong>{email}</strong>.
        </p>
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <div style={{ position: 'fixed', top: 16, right: 16 }}><ThemeToggle /></div>
      <div className="auth__panel">
        <div className="auth__brand"><Logo size={26} /> Steadhold</div>
        {children}
      </div>
    </div>
  );
}
