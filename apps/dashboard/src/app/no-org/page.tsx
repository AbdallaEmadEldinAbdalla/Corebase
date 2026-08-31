'use client';

import Link from 'next/link';
import { AppShell } from '../../components/AppShell.tsx';

/**
 * A signed-in account with no organization: an account created moments ago, an
 * invite never accepted, or an org that was deleted.
 *
 * It carries the action that resolves it. The first version of this page only
 * *explained* the state, which made it a dead end — the endpoint had existed since
 * P1d with no screen, so the only way out of a fresh account was curl. An empty
 * state without its action is a dead end (UX standard §6), and this was the
 * clearest one in the product.
 */
export default function NoOrgPage() {
  return (
    <AppShell>
      <div className="wrap">
          <div className="emptywrap"><div className="cb-empty">
            <div className="cb-empty__icon" aria-hidden="true">·</div>
            <div className="cb-empty__title">No organizations yet</div>
            <div className="cb-empty__text">
              Organizations own projects. Create one to get started, or open the
              invitation link you were sent if someone added you to theirs.
            </div>
            <Link className="cb-btn" href="/new-org">New organization</Link>
          </div></div>
      </div>
    </AppShell>
  );
}
