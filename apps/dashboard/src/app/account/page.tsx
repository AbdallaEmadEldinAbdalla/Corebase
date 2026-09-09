'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '../../components/AppShell.tsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { CopyButton } from '../../components/Copy.tsx';
import { ErrorSurface, FieldError } from '../../components/ErrorSurface.tsx';
import { Select } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toasts.tsx';
import { useReturnFocus } from '../../lib/return-focus.ts';
import { useMe, useTokens, useCreateToken, useRevokeToken } from '../../lib/queries.ts';
import { ApiError, type AccessToken, type NewAccessToken } from '../../lib/api.ts';

/**
 * The account page.
 *
 * The IA asks for four sections — profile, password, personal access tokens,
 * active sessions — and exactly one of them has an API behind it. There is no
 * route that updates a display name, changes a password, or lists sessions, so
 * those are stated as absent rather than rendered as controls that cannot work.
 * The same call project settings makes about renaming.
 *
 * **Tokens have no scopes here, and that is the honest choice.** The column
 * exists and D-062 lists scoping as future work: `principal.ts` carries `scopes`
 * into the resolved principal and *nothing authorizes against them*, so a token
 * created with `scopes: ['read']` has full access to the account. A scope picker
 * would therefore be a control that applies no restriction — which is exactly the
 * failure gate question 19 exists to catch, in its most dangerous possible form,
 * on a credential.
 *
 * Silence would be worse than the statement, though, which is why the page says
 * it outright. Anyone who has used a personal access token elsewhere arrives
 * expecting scopes; left unmentioned, they will assume a token is narrow when it
 * is total. Saying so is also actionable — it is the argument for a short expiry.
 *
 * `.wrap`, not `.wrap--narrow`, even though this reads like a settings form.
 * `.wrap--narrow` is 620px and `.personcard`'s container query collapses to one
 * column at 620px, so the narrow column would pin every token card to its
 * stacked layout at every window size — a breakpoint that can never be on the
 * other side of itself.
 */
export default function AccountPage() {
  const me = useMe();

  return (
    <AppShell>
      <div className="wrap">
        <div className="head">
          <div>
            <h1 className="head__title">Account</h1>
            <p className="head__sub">Who you are, and the tokens that act as you.</p>
          </div>
        </div>

        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Profile</h2>
          </div>
          <div className="card">
            <div className="card__body">
              {me.isPending ? (
                <div className="facts" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => (
                    <div className="sh-skeleton" key={i}
                      style={{ height: 16, width: i % 2 ? '60%' : 90 }} />
                  ))}
                </div>
              ) : (
                <dl className="facts">
                  <dt className="facts__k">Email</dt>
                  <dd className="facts__v">{me.data?.user?.email ?? '—'}</dd>
                  <dt className="facts__k">Name</dt>
                  <dd className="facts__v">{me.data?.user?.display_name ?? 'Not set'}</dd>
                  <dt className="facts__k">Email verified</dt>
                  <dd className="facts__v">{me.data?.user?.email_verified ? 'Yes' : 'No'}</dd>
                  <dt className="facts__k">Organizations</dt>
                  <dd className="facts__v">{me.data?.memberships.length ?? 0}</dd>
                </dl>
              )}
            </div>
            <div className="card__foot">
              <span>
                Changing your name, changing your password and signing other
                sessions out are <strong>not built</strong> — the platform API has no
                route for any of the three. This page asks for them and will have
                them when there is something behind them.
              </span>
            </div>
          </div>
        </section>

        <TokensSection />
      </div>
    </AppShell>
  );
}

function TokensSection() {
  const tokens = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const toast = useToast();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  /** The secret. Held here and nowhere else — see `useCreateToken`. */
  const [issued, setIssued] = useState<NewAccessToken | null>(null);
  const [confirming, setConfirming] = useState<AccessToken | null>(null);

  const rows = tokens.data?.tokens ?? [];

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Access tokens</h2>
        <p className="section__note">
          How the CLI and your scripts sign in as you.
        </p>
      </div>

      <div className="card">
        <div className="card__body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || create.isPending) return;
              create.mutate(
                { name: name.trim(),
                  ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }) },
                {
                  onSuccess: (t) => { setIssued(t); setName(''); },
                  onError: (err) => toast.apiError('Could not create the token', err),
                });
            }}>
            {/* The row holds label-and-control pairs only. The help line lives
                *below* it, which is not a stylistic preference: `.sh-field` is a
                flex column, so a help line inside one field makes that field 22px
                taller than its neighbour, and `align-items: flex-end` then lines
                up the field boxes rather than the controls — measured at 22px of
                offset, the input's top at 562 against the select's and the
                button's at 584. The invite form gets away with the same markup
                only because it has no help text. Below the row, the sentence also
                gets the full width instead of one column's 330px. */}
            <div className="sh-row" style={{ gap: 'var(--sh-space-12)', alignItems: 'flex-end' }}>
              {/* `minWidth: 220`, not `0`. `.sh-row` already sets `flex-wrap:
                  wrap`, and `min-width: 0` defeats it: with no min-content floor
                  the name field shrinks toward nothing instead of pushing the
                  select onto a second line, so at 375px the two labels drew on
                  top of each other ("NaExpires"), the input became a sliver, and
                  the document scrolled sideways at 389px against a 375px client.
                  Copied from the invite form, which has never been looked at this
                  narrow. A floor is what makes wrapping happen. */}
              <div className="sh-field" style={{ flex: 1, minWidth: 220 }}>
                <label className="sh-label" htmlFor="token-name">Name</label>
                <input id="token-name" className="sh-input" type="text" required maxLength={120}
                  value={name} onChange={(e) => setName(e.target.value)}
                  aria-describedby="token-name-help"
                  placeholder="laptop, ci, deploy-bot" />
              </div>
              <div className="sh-field">
                <label className="sh-label" htmlFor="token-expiry">Expires</label>
                {/* The API takes 1–365 days or nothing at all. These are the useful
                    points on that range rather than a free number field: nobody has
                    an opinion about 137 days. */}
                <Select id="token-expiry" label="When the token expires" value={expiry}
                  options={[
                    { value: '30', label: 'in 30 days' },
                    { value: '90', label: 'in 90 days' },
                    { value: '365', label: 'in a year' },
                    { value: 'never', label: 'never' },
                  ]}
                  onChange={setExpiry} />
              </div>
              <button className="sh-btn" type="submit"
                disabled={create.isPending || !name.trim()}>
                {create.isPending ? 'Creating…' : 'Create token'}
              </button>
            </div>
            {/* Error *replaces* help rather than stacking with it — §5 rule 3. */}
            <div id="token-name-help" style={{ marginTop: 6 }}>
              {create.error instanceof ApiError
                ? <FieldError>{create.error.message}</FieldError>
                : <span className="sh-help">
                    What it is for, so you revoke the right one later.
                  </span>}
            </div>
          </form>

        </div>
        <div className="card__foot">
          {/* One `<span>` around the whole sentence on purpose: `.card__foot` is a
              flex row with a 12px gap, so a bare inline `<strong>` becomes its own
              flex item and opens a gap mid-sentence. */}
          <span>
            A token has <strong>full access to your account</strong> — every
            organization and project you can reach. Narrowing one to less than that
            is not built, so its expiry is the only limit it has.
          </span>
        </div>
      </div>

      {tokens.error ? (
        <ErrorSurface error={tokens.error} onRetry={() => void tokens.refetch()}
          title="Could not load your tokens" />
      ) : tokens.isPending ? (
        /* The same three-part shape a real card has, so the page does not reflow
           when the data lands. */
        <div className="personcards" aria-busy="true">
          {[0, 1].map((i) => (
            <div className="personcard" key={i}>
              <div className="personcard__id">
                <div className="sh-skeleton" style={{ width: 120, height: 18 }} />
                <div className="sh-skeleton" style={{ width: 96, height: 13, marginTop: 6 }} />
              </div>
              <div className="personcard__facts">
                <div className="sh-skeleton" style={{ width: 130, height: 16 }} />
                <div className="sh-skeleton" style={{ width: 110, height: 16 }} />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">No tokens yet</div>
          <div className="sh-empty__text">
            The CLI signs in with one of these. Create one above when you need it —
            if you never do, there is nothing here to clean up.
          </div>
        </div></div>
      ) : (
        /**
         * Cards, not a table.
         *
         * §4's threshold argues for a table at this many comparable attributes,
         * and the shipped answer to that argument is `.personcards`: the members
         * table was removed for squeezing its columns, and the projects list went
         * the same way. This list is the same subject — a named thing, a couple of
         * facts, one action — so it gets the same treatment rather than a fourth
         * opinion about it.
         *
         * The deciding detail is smaller than the standard, though: `.tablewrap`
         * sets `cursor: pointer` on every `tbody tr`, because in this app a table
         * row goes somewhere. A token row goes nowhere — there is no token detail
         * view and there will not be one, since the only readable field is the
         * prefix already on the card. Reusing the table would have shipped a
         * pointer cursor over nine tenths of a row that does not click.
         */
        <div className="personcards">
          {rows.map((t) => (
            <div className="personcard" key={t.id}>
              <div className="personcard__id">
                <div className="personcard__name">{t.name}</div>
                {/* The prefix sits where the email does on a member card: it is
                    the identifier, and it is what the revoke dialog names. */}
                <div className="personcard__email" style={{ font: 'var(--sh-code)' }}>
                  {t.prefix}
                </div>
              </div>
              <div className="personcard__facts">
                <span className="sh-help" style={{ whiteSpace: 'nowrap' }}>
                  {t.last_used_at
                    ? `Last used ${new Date(t.last_used_at).toLocaleDateString()}`
                    /* Said differently from a date on purpose: a token that has
                       never been used is the one you can revoke without first
                       working out what breaks. */
                    : 'Never used'}
                </span>
                <span className="sh-help" style={{ whiteSpace: 'nowrap' }}>
                  {t.expires_at
                    ? `Expires ${new Date(t.expires_at).toLocaleDateString()}`
                    : 'No expiry'}
                </span>
              </div>
              <div className="personcard__actions">
                {/* One action, so a button and not a `⋯` menu — D-430: a menu
                    earns its extra click at two things, and for one it is a lid. */}
                <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                  disabled={revoke.isPending}
                  onClick={() => setConfirming(t)}>
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <IssuedToken token={issued} onDismiss={() => setIssued(null)} />

      {/**
        * Confirmed, but without a typed name.
        *
        * `requireText` is calibrated for deleting a project — the one act here
        * that destroys data — and revoking a token destroys none: it stops a
        * credential working, and the form above mints another. That puts it in the
        * same class as revoking an invitation, which is confirmed exactly this way
        * (D-431). The dialog captures the focus to return to by itself, so there
        * is no `capture()` at this call site to forget.
        */}
      <ConfirmDialog
        open={confirming !== null}
        title="Revoke this token?"
        confirmLabel="Revoke token"
        pending={revoke.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const t = confirming;
          if (!t) return;
          revoke.mutate(t.id, {
            onSuccess: () => {
              setConfirming(null);
              toast.show({ tone: 'success', title: `${t.name} revoked`,
                           detail: 'Anything still using it stops working now.' });
            },
            onError: (err) => { setConfirming(null); toast.apiError('Could not revoke it', err); },
          });
        }}>
        <strong>{confirming?.name}</strong> (<code style={{ font: 'var(--sh-code)' }}>
        {confirming?.prefix}</code>) stops working immediately — a CLI, a script, a
        CI job, anything holding it. This cannot be undone, but you can create a new
        token to replace it.
      </ConfirmDialog>
    </section>
  );
}

/**
 * The secret, shown exactly once, in a dialog of its own.
 *
 * It began as a banner inside the card, modelled on the invitation's. A banner is
 * right for the invitation because the token there is one of several things the
 * result carries and the page keeps working around it. This is not that: it is the
 * only moment the secret exists on screen, and once it is gone the platform cannot
 * produce it again. A layer is the honest weight for that — it takes the focus,
 * it stops the page moving underneath, and it has to be dismissed deliberately.
 *
 * Three deliberate choices about dismissal:
 *
 *  - **No scrim button.** Every other dialog here has one, because clicking away
 *    from a confirmation means "no" and costs nothing. Clicking away from this one
 *    destroys the only copy of a credential, and a stray click outside a box is
 *    the easiest accident there is. The scrim is inert; the two ways out are both
 *    named.
 *  - **Escape still works.** It is advertised in the shortcut sheet as closing the
 *    topmost layer, and a layer that swallows it teaches the user that Escape is
 *    unreliable — a worse outcome than this one dismissal, and pressing Escape is
 *    a deliberate act in a way that a click at the edge of the screen is not.
 *  - **Copy takes the focus**, not the dismiss button. It is what the person came
 *    here to do, and it puts the return key on the safe action rather than the one
 *    that closes the box.
 *
 * The sentence is the API's own `warning` field rather than a paraphrase, which is
 * the rule `InviteToken` established: if the platform ever gains a way to re-read
 * a token, that field changes and this stops claiming otherwise.
 */
function IssuedToken({ token, onDismiss }: {
  token: NewAccessToken | null;
  onDismiss: () => void;
}) {
  const open = token !== null;
  const copy = useRef<HTMLDivElement>(null);
  const { capture, restore } = useReturnFocus();

  /**
   * `[open]` alone, and the capture inside the dialog rather than at the call
   * site — both for the reasons `ConfirmDialog` documents. The create button is
   * what had focus when this opened, and it is still there afterwards, so it is a
   * real return target.
   */
  useEffect(() => {
    if (!open) return;
    capture();
    copy.current?.querySelector('button')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  useEffect(() => { if (!open) restore(); }, [open, restore]);

  if (!token) return null;

  return (
    <div className="sh-modal">
      {/* Inert, and marked so — see the note above about clicking away. */}
      <div className="sh-scrim" aria-hidden="true" />
      {/* No width of its own. The first version asked for 520px because the
          secret is 44 characters, and at a 514px pane it hung off the right edge —
          `max-width: 100%` could not save a box wider than the room. `.sh-dialog`
          is 420px everywhere in this app and the design system is not up for
          reinvention per screen (D-179); the secret wraps instead, which is what
          `pre-wrap` below is for. */}
      <div className="sh-dialog" role="dialog" aria-modal="true" tabIndex={-1}
           aria-label={`${token.name} created`}>
        <div className="sh-dialog__title">{token.name} created</div>
        <div className="sh-dialog__text">{token.warning}</div>

        {/* `.sh-code` is the code *block* container, which is right here: this is a
            block, on its own line, and the value is the subject of the dialog.
            The `<pre>` is not optional — `.sh-code` paints the dark code surface
            but the text colour lives on `.sh-code pre`, so bare text inside it
            inherits the page's ink and comes out dark-on-dark in the light theme.
            `anywhere` because a 44-character secret has no break opportunities and
            would otherwise run past the dialog. */}
        <div className="sh-code" style={{ marginTop: 'var(--sh-space-16)', maxWidth: '100%' }}>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{token.token}</pre>
        </div>

        <div className="sh-dialog__footer" ref={copy}>
          <CopyButton value={token.token} what="access token" size="md" />
          <button type="button" className="sh-btn sh-btn--secondary" onClick={onDismiss}>
            I have stored it
          </button>
        </div>
      </div>
    </div>
  );
}
