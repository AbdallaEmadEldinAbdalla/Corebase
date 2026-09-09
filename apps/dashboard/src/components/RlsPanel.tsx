'use client';

import { useState } from 'react';
import type { IntrospectionPolicy, IntrospectionTable } from '../lib/api.ts';

/**
 * A table's row-level security, permanently on the page.
 *
 * Permanent, not behind a tab: the IA is explicit that "RLS status is not buried
 * in settings, it is the second thing you see after the data", because the API's
 * security model *is* RLS (D-036). A page that shows a developer their rows
 * without showing them who else can read those rows is answering the easier
 * question.
 *
 * ## The presentation of "no policies", and why it is not a warning
 *
 * D-083 makes RLS-enabled-with-no-policies the **safe default**: a new table is
 * invisible to `anon` and `authenticated` until its owner says otherwise, so the
 * failure mode is a 403 rather than an accidental public dump. Drawing that as an
 * error would train people to dismiss the one badge that means something, so it
 * is informational and it says what it *does* — "your API returns no rows" — not
 * that something is wrong.
 *
 * ## The trap the spec does not name
 *
 * The grid on this page runs as `developer`, the table's owner, and RLS is
 * `ENABLE`d but deliberately not `FORCE`d (`30-force-rls.sql`), so **the owner
 * sees every row regardless of policy**. A developer looking at a full grid and
 * an empty API has no way to connect the two unless the page says so. That
 * sentence is the most useful thing on this panel and it appears whenever there
 * is any RLS at all, not only when policies are missing.
 */
export function RlsPanel(
  { table, policies }: { table: IntrospectionTable; policies: IntrospectionPolicy[] },
) {
  const [open, setOpen] = useState(false);

  // A view has no RLS of its own — it inherits whatever its underlying tables
  // enforce. Claiming "RLS off" on a view would read as "this is exposed", which
  // is the opposite of what a view over a protected table means.
  if (table.kind !== 'table' && table.kind !== 'partitioned_table') {
    return (
      <div className="rls">
        <span className="rls__badge rls__badge--muted">No RLS of its own</span>
        <span className="rls__text">
          A {table.kind.replace('_', ' ')} is filtered by the policies on the
          tables it reads, not by policies of its own.
        </span>
      </div>
    );
  }

  if (!table.rls_enabled) {
    return (
      <div className="rls rls--warn">
        <span className="rls__badge rls__badge--warn">RLS off</span>
        <span className="rls__text">
          Every role with a grant on this table reads every row — the API included.
          Tables created through Steadhold have RLS enabled at creation
          (D&#8209;083); this one does not, so it was either created before that or
          had it turned off.
        </span>
      </div>
    );
  }

  return (
    <div className="rls">
      <button type="button" className="rls__toggle" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              disabled={policies.length === 0}>
        <span className={`rls__badge${policies.length === 0 ? ' rls__badge--info' : ''}`}>
          RLS · {policies.length === 0
            ? 'no policies'
            : `${policies.length} ${policies.length === 1 ? 'policy' : 'policies'}`}
        </span>
        {policies.length > 0 ? (
          <span className="rls__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        ) : null}
      </button>

      <span className="rls__text">
        {policies.length === 0
          ? 'Your API returns no rows from this table. That is the safe default '
            + 'for a new table, not a fault — a policy is what opens it up.'
          : 'Your API returns only the rows these policies allow.'}
        {' '}
        {/* The trap, stated every time there is RLS: the grid is the owner's
            view and the API's is not. */}
        <strong>The rows below are the owner&rsquo;s view</strong> and ignore these
        policies, the same as your connection string does.
      </span>

      {open && policies.length > 0 ? (
        <div className="rls__list">
          {policies.map((p) => (
            <div className="rls__policy" key={`${p.name}:${p.command}`}>
              <div className="rls__policyhead">
                <code style={{ font: 'var(--sh-code)' }}>{p.name}</code>
                <span className="tablelist__tag">{p.command}</span>
                {!p.permissive ? <span className="tablelist__tag">restrictive</span> : null}
                <span className="rls__roles">{p.roles.join(', ')}</span>
              </div>
              {/* `using` and `check` answer different questions — which rows you
                  may see, and which rows you may write — so a policy with both
                  shows both, labelled. Collapsing them into one expression is how
                  a read policy gets mistaken for a write policy. */}
              {p.using ? (
                <div className="rls__expr"><span>USING</span>
                  <code style={{ font: 'var(--sh-code)' }}>{p.using}</code></div>
              ) : null}
              {p.check ? (
                <div className="rls__expr"><span>WITH CHECK</span>
                  <code style={{ font: 'var(--sh-code)' }}>{p.check}</code></div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
