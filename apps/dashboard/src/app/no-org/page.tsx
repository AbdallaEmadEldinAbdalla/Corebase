'use client';

import { AppShell } from '../../components/AppShell.tsx';

/**
 * A signed-in account with no organization. A real state — an invite that was
 * never accepted, or an org that was deleted — and it gets a page rather than a
 * redirect loop back to login, which is what "you are not signed in" would be
 * telling the user, untruthfully.
 *
 * Creating an org from here needs `POST /v1/orgs`, which exists. It is not
 * offered yet because the shell's scope is login → switch → list → create
 * project → overview; an org-creation flow with a slug rule and a danger zone is
 * its own task, and a half-built one here would be the worse outcome.
 */
export default function NoOrgPage() {
  return (
    <AppShell>
      <main className="page">
        <div className="page__inner">
          <div className="cb-empty">
            <div className="cb-empty__icon" aria-hidden="true">·</div>
            <div className="cb-empty__title">No organizations yet</div>
            <div className="cb-empty__text">
              Your account is not a member of any organization. If you were invited,
              open the invitation link you were sent to accept it.
            </div>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
