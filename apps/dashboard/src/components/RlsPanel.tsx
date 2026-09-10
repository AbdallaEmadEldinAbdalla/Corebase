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
  { table, policies, onEnable, onGrantAnon, onRevokeAnon }: {
    table: IntrospectionTable;
    policies: IntrospectionPolicy[];
    /**
     * The one-click fix, present only when RLS is off and the table is ours to
     * change. Absent rather than disabled: a greyed-out "Fix this" beside a red
     * banner on someone else's table is a dead end that looks like a bug.
     */
    onEnable?: () => void;
    /** Opens the grant flow. Absent when the table is not ours to change. */
    onGrantAnon?: () => void;
    /** Opens the revoke flow. */
    onRevokeAnon?: () => void;
  },
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
        {/* The page's one accent action while this banner is up. §5 rule 1 allows
            one primary action per view, and a table the anon key can read and
            write in full is the most important thing on the screen — so it wins
            it from "Add column" for as long as it is true. */}
        {onEnable ? (
          <button type="button" className="sh-btn sh-btn--sm rls__fix" onClick={onEnable}>
            Enable RLS
          </button>
        ) : null}
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
        {/**
          * The two API roles, said separately — because they behave differently
          * and the earlier single sentence was **false for one of them**.
          *
          * It read "Your API returns only the rows these policies allow", which
          * is true of `authenticated` and wrong about `anon`: D-108 gives `anon`
          * no default table grant, so without one it is refused outright and a
          * `CREATE POLICY … TO anon` changes nothing. Measured on a live project
          * — a table carrying `to anon using (true)` answered `permission denied`
          * until the grant was run, and then returned every row.
          *
          * A developer reading the old sentence writes the policy, tests with
          * their anon key, gets an error, and concludes the policy engine is
          * broken. That is the most expensive kind of wrong sentence: it sends
          * someone to debug the wrong thing.
          */}
        {policies.length === 0
          ? 'Signed-in callers get an empty list from your API. That is the safe '
            + 'default for a new table, not a fault — a policy is what opens it up.'
          : 'Signed-in callers get only the rows these policies allow.'}
        {' '}
        {/* The trap, stated every time there is RLS: the grid is the owner's
            view and the API's is not. */}
        <strong>The rows below are the owner&rsquo;s view</strong> and ignore these
        policies, the same as your connection string does.
      </span>

      {/**
        * Anonymous access, as a **status line with a verb** rather than a switch.
        *
        * D-108 calls this "the dashboard toggle" and a switch is now technically
        * possible — the state arrives in the payload. It is still the wrong
        * control: every mutation in this editor goes through the preview→confirm
        * loop, so a switch that opens a dialog and stays where it was lies about
        * when the change happens, and one that flips first lies about whether it
        * happened at all. A sentence plus a verb claims neither.
        *
        * It lives *here*, beside the policies, because a grant and a policy are
        * two halves of one question — "what can the API see" — and the panel's
        * own sentence was wrong until this was on the same line as it.
        *
        * `null` renders nothing at all, deliberately: it means the database has
        * no `anon` role, which is the `steadhold export` case (D-004), and
        * drawing "off" there would invent a setting that does not exist. Nothing
        * on this panel mentions `anon` in that case.
        */}
      {table.anon_can_select !== null ? (
        <span className="rls__anon">
          {table.anon_can_select ? (
            <>
              <span className="rls__badge rls__badge--warn">anon can read</span>
              <span className="rls__text">
                Anyone with your project&rsquo;s anon key reads this table, filtered
                by the policies above and by nothing else.
                {table.anon_can_write ? (
                  <>
                    {' '}
                    <strong>They can write to it too.</strong>
                  </>
                ) : null}
              </span>
              {onRevokeAnon ? (
                <button type="button" className="sh-linkbtn" onClick={onRevokeAnon}>
                  Remove anonymous access…
                </button>
              ) : null}
            </>
          ) : (
            <>
              <span className="rls__badge rls__badge--muted">anon cannot read</span>
              <span className="rls__text">
                Anonymous callers are refused outright, whatever the policies say —
                a grant sits above RLS, and a new table gives them none.
              </span>
              {onGrantAnon ? (
                <button type="button" className="sh-linkbtn" onClick={onGrantAnon}>
                  Allow anonymous read…
                </button>
              ) : null}
            </>
          )}
        </span>
      ) : null}

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
