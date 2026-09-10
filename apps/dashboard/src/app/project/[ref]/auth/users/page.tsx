'use client';

import { use, useMemo, useState } from 'react';
import { can } from '@steadhold/types';
import {
  useMe, useProject, useAuthUsers, useUpdateAuthUser, useDeleteAuthUser,
} from '../../../../../lib/queries.ts';
import type { AuthUser } from '../../../../../lib/api.ts';
import { ErrorSurface } from '../../../../../components/ErrorSurface.tsx';
import { ConfirmDialog } from '../../../../../components/ConfirmDialog.tsx';
import { Menu, MenuItem } from '../../../../../components/Menu.tsx';
import { useToast } from '../../../../../components/Toasts.tsx';

/**
 * The customer's own end users (P7s) — `auth.users`, not organization members.
 *
 * ## Why this is a page and not a table-editor view
 *
 * `auth.users` is the one table the console cannot read:
 * `has_table_privilege('developer', 'auth.users', 'SELECT')` is false, so a
 * developer typing `select * from auth.users` in the SQL editor gets a
 * permission error. The rows come from `/v1/projects/:ref/auth/users`, which
 * connects as the auth role server-side (D-478) — the same reason the console
 * itself is an endpoint rather than a connection string in the browser.
 *
 * ## A table, and the subject test
 *
 * §4's threshold is more than six items or more than three comparable
 * attributes, and this has five and no ceiling. The "cards for identity" clause
 * is about *recognising which one*, and a developer arriving here from a support
 * ticket already knows which one — they hold the address and need to find it,
 * which is search plus comparison. Cards would also make four thousand users
 * unreadable.
 *
 * ## Two empty states, deliberately
 *
 * "Your app has no users yet" and "nothing matches `foo`" are different facts,
 * and conflating them would tell a developer with four thousand users that they
 * have none the moment they mistype a search. The first also cannot carry the
 * action §6 asks for — a developer does not create an end user from here, their
 * *app* does — so it points at the keys page instead of growing a button that
 * would have to lie.
 */
const NOT_ANALYZED = -1;

export default function AuthUsersPage(
  { params }: { params: Promise<{ ref: string }> },
) {
  const { ref } = use(params);
  const me = useMe();
  const project = useProject(ref);
  const toast = useToast();

  const [search, setSearch] = useState('');
  /** Applied search, so a keystroke does not fire a request per character. */
  const [applied, setApplied] = useState('');
  /**
   * The keyset cursor stack, not a page number.
   *
   * Keyset paging can only go forward, so "back" is popping a stack of the
   * cursors already used rather than subtracting one from an index. The empty
   * string is page one, which is what `useAuthUsers` treats as no cursor.
   */
  const [cursors, setCursors] = useState<string[]>(['']);
  const cursor = cursors[cursors.length - 1] ?? '';

  const [detail, setDetail] = useState<AuthUser | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: 'delete' | 'ban' | 'signout'; user: AuthUser } | null>(null);

  const p = project.data?.project;
  const myRole = me.data?.memberships.find((m) => m.org_id === p?.org_id)?.role;
  const mayManage = myRole !== undefined && can(myRole, 'authuser.manage');

  const list = useAuthUsers(ref, { ...(applied ? { q: applied } : {}), cursor });
  const update = useUpdateAuthUser(ref);
  const remove = useDeleteAuthUser(ref);

  const users = list.data?.users ?? [];
  const firstIndex = useMemo(
    () => (cursors.length - 1) * 50 + 1, [cursors.length]);

  /**
   * `me` is in the loading gate with the rows, and for the reason the project
   * settings page documents: an absent role and a role without the capability
   * look the same, so a page that renders first shows a member's row menu to an
   * admin for one frame — an unresolved request presented as a verdict (Q18).
   */
  if (list.isPending || me.isPending) {
    return (
      <div className="deck__main" aria-busy="true">
        <div className="deckhead">
          <div className="sh-skeleton" style={{ width: 160, height: 18 }} />
        </div>
        <div className="deckbar">
          <div className="sh-skeleton" style={{ width: 220, height: 26 }} />
        </div>
        <div className="deckgrid">
          {/* Rows, not a block: the shape that arrives is a list of people, and a
              single grey rectangle resolving into eleven rows is the jump §6
              exists to prevent. */}
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="sh-skeleton"
                 style={{ height: 26, margin: '4px 12px' }} />
          ))}
        </div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="deck__main">
        <div className="deckhead"><span className="deckhead__name">Users</span></div>
        <div className="deckgrid">
          <ErrorSurface error={list.error} onRetry={() => void list.refetch()}
                        title="Could not read this project's users" />
        </div>
      </div>
    );
  }

  const total = list.data?.estimated_total ?? null;
  const searching = applied.length > 0;

  const act = (
    user: AuthUser,
    change: { ban_until?: string | null; email_confirm?: boolean; sign_out?: boolean },
    done: string,
    inverse?: () => void,
  ) => {
    update.mutate({ id: user.id, change }, {
      onSuccess: () => {
        setConfirm(null);
        toast.show({
          tone: 'success', title: done,
          ...(inverse ? { action: { label: 'Undo', run: inverse } } : {}),
        });
      },
      onError: (err) => { setConfirm(null); toast.apiError('Could not do that', err); },
    });
  };

  return (
    <div className="deck__main">
      <div className="deckhead">
        <span className="deckhead__name">Users</span>
        <span className="dtable__tag" title="Your application's own end users">
          auth.users
        </span>
        <span className="deckhead__spacer" />
      </div>

      <div className="deckbar">
        {/* A form, so Return submits and the browser offers a clear button —
            and so the search is *applied* on intent rather than per keystroke.
            Debouncing would fire a request for every prefix of what someone
            types, and each one is a substring scan on the customer's table. */}
        <form className="usersearch"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied(search.trim());
                setCursors(['']);
              }}>
          <input className="sh-input usersearch__input" type="search"
                 value={search} placeholder="Find by email address"
                 aria-label="Find a user by email address"
                 onChange={(e) => setSearch(e.target.value)} />
          <button type="submit" className="tbtn">Search</button>
          {searching ? (
            <button type="button" className="tbtn"
                    onClick={() => { setSearch(''); setApplied(''); setCursors(['']); }}>
              Clear
            </button>
          ) : null}
        </form>
        <span className="deckbar__spacer" />
        {/* `isFetching` rather than `isPending`: with `keepPreviousData` the old
            page stays on screen, so this is the only thing that says a newer one
            is on its way. */}
        {list.isFetching ? <span className="dtable__muted">Loading…</span> : null}
        <button type="button" className="tbtn" onClick={() => void list.refetch()}>
          Refresh
        </button>
      </div>

      <div className="deckgrid">
        {users.length === 0 ? (
          <div className="emptywrap"><div className="sh-empty">
            <div className="sh-empty__title">
              {searching ? 'No user matches that' : 'No users yet'}
            </div>
            <div className="sh-empty__text">
              {searching ? (
                <>
                  Nothing in <code style={{ font: 'var(--sh-code)' }}>auth.users</code>{' '}
                  has an address containing{' '}
                  <strong>{applied}</strong>. The search matches any part of an
                  address, so a fragment is enough — but a deleted user is gone
                  from it.
                </>
              ) : (
                <>
                  Users appear here when someone signs up through your app. They
                  are created by your application against the auth API, not from
                  this page — the <a href={`/project/${ref}/keys`}>API keys</a>{' '}
                  page has the URL and the anon key to point it at.
                </>
              )}
            </div>
          </div></div>
        ) : (
          <table className="dtable dtable--dense">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th>Signed up</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <Row key={u.id} user={u} mayManage={mayManage}
                     onOpen={() => setDetail(u)}
                     onConfirmEmail={() => act(u, { email_confirm: true },
                       `${u.email ?? 'That user'}'s address is confirmed`)}
                     onUnban={() => act(u, { ban_until: null },
                       `${u.email ?? 'That user'} is no longer banned`)}
                     onAsk={(kind) => setConfirm({ kind, user: u })} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="deckfoot">
        <button type="button" className="pgbtn" aria-label="Previous page"
                disabled={cursors.length === 1}
                onClick={() => setCursors((c) => c.slice(0, -1))}>
          <span aria-hidden="true">&lsaquo;</span>
        </button>
        <span>Page {cursors.length}</span>
        <button type="button" className="pgbtn" aria-label="Next page"
                disabled={!list.data?.has_more || !list.data?.next_cursor}
                onClick={() => setCursors((c) => [...c, list.data!.next_cursor!])}>
          <span aria-hidden="true">&rsaquo;</span>
        </button>
        <span className="deckfoot__spacer" />
        <span>
          {/**
            * "1–50 of ~4,200" — the tilde is doing the work, because the
            * denominator is `reltuples` and not a count (D-466's argument, one
            * table over). A search gets no denominator at all: the table's total
            * beside a filtered numerator would be two different questions in one
            * sentence.
            */}
          {users.length > 0
            ? `${firstIndex.toLocaleString()}–${(firstIndex + users.length - 1).toLocaleString()}`
            : '0'}
          {searching
            ? ' matching'
            : total === null ? ''
            : total === NOT_ANALYZED
              ? ' — total not counted yet'
              : ` of ~${total.toLocaleString()}`}
        </span>
      </div>

      {detail ? (
        <UserDetail user={detail} onClose={() => setDetail(null)} />
      ) : null}

      <ConfirmDialog open={confirm?.kind === 'ban'}
        title="Ban this user?"
        confirmLabel="Ban and sign out"
        pending={update.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && act(
          confirm.user,
          // A far-future date rather than a nullable "banned" flag, because that
          // is the column's shape: `banned_until` is a timestamp, and a ban with
          // no end is one that ends a long way away.
          { ban_until: '2099-01-01T00:00:00.000Z' },
          `${confirm.user.email ?? 'That user'} is banned`,
        )}>
        <strong>{confirm?.user.email}</strong> will not be able to sign in, and
        every session they have open is revoked now. Their data is untouched and
        you can lift this in one click.
      </ConfirmDialog>

      <ConfirmDialog open={confirm?.kind === 'signout'}
        title="Sign this user out everywhere?"
        confirmLabel="Sign out everywhere"
        tone="default"
        pending={update.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && act(
          confirm.user, { sign_out: true },
          `${confirm.user.email ?? 'That user'} signed out everywhere`,
        )}>
        Every refresh token <strong>{confirm?.user.email}</strong> holds stops
        working, so every device signs out at its next refresh. An access token
        already issued keeps working until it expires — up to an hour, and less
        if you have shortened it.
      </ConfirmDialog>

      <ConfirmDialog open={confirm?.kind === 'delete'}
        title="Delete this user?"
        confirmLabel="Delete this user"
        pending={remove.isPending}
        {...(confirm?.user.email ? { requireText: confirm.user.email } : {})}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && remove.mutate(confirm.user.id, {
          onSuccess: () => {
            const email = confirm.user.email ?? 'The user';
            setConfirm(null);
            setDetail(null);
            // No Undo offered, because there is none: `softDeleteUser` leaves a
            // tombstone and no endpoint reverses it. A toast with an inverse
            // that does not exist is the worst kind of reassurance.
            toast.show({ tone: 'success', title: `${email} deleted` });
          },
          onError: (err) => { setConfirm(null); toast.apiError('Could not delete', err); },
        })}>
        <strong>{confirm?.user.email}</strong> will no longer be able to sign in,
        and their address is freed for a new signup. <strong>There is no
        undo</strong> — this is not the seven-day recovery a deleted project
        gets.
        <br /><br />
        Rows in <em>your</em> tables that reference this user are left exactly as
        they are: what should happen to them is your schema&rsquo;s decision, not
        ours. Type the address to confirm.
      </ConfirmDialog>
    </div>
  );
}

/**
 * One user.
 *
 * Hoisted to module scope rather than declared inside the page: a component
 * defined in a render gets a new type identity every time, which remounts it —
 * and a remounting row loses focus mid-keystroke, which is a bug this repository
 * has already shipped once.
 */
function Row({ user, mayManage, onOpen, onConfirmEmail, onUnban, onAsk }: {
  user: AuthUser;
  mayManage: boolean;
  onOpen: () => void;
  onConfirmEmail: () => void;
  onUnban: () => void;
  onAsk: (kind: 'delete' | 'ban' | 'signout') => void;
}) {
  const banned = user.banned_until !== null && Date.parse(user.banned_until) > Date.now();
  const confirmed = user.email_confirmed_at !== null;

  return (
    <tr>
      <td title={user.email ?? ''}>
        {/* A button, not a link: opening the detail is a reveal-in-place, and a
            link would promise a URL this page cannot yet give (OQ-180). */}
        <button type="button" className="sh-linkbtn" onClick={onOpen}>
          {user.email ?? <span className="grid__null">no address</span>}
        </button>
      </td>
      <td>
        {/* Never colour alone (D-180): each state is a dot *and* a word. Two
            badges rather than one merged status, because a banned user can also
            be unconfirmed and a single label would have to pick. */}
        {banned ? (
          <span className="sh-badge sh-badge--error">
            <span className="sh-dot" />Banned
          </span>
        ) : confirmed ? (
          <span className="sh-badge sh-badge--success">
            <span className="sh-dot" />Confirmed
          </span>
        ) : (
          <span className="sh-badge sh-badge--warning">
            <span className="sh-dot" />Unconfirmed
          </span>
        )}
      </td>
      <td className="dtable__muted">
        {user.last_sign_in_at ? when(user.last_sign_in_at) : 'never'}
      </td>
      <td className="dtable__muted">{when(user.created_at)}</td>
      <td style={{ textAlign: 'right' }}>
        {mayManage ? (
          <Menu label={`Actions for ${user.email ?? 'this user'}`} align="right"
                trigger={({ toggle, ref: r, open }) => (
                  <button ref={r} type="button" className="tbtn"
                          aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                    Manage
                  </button>
                )}>
            {(close) => (
              <>
                <MenuItem onSelect={() => { close(); onOpen(); }}>
                  View details
                </MenuItem>
                {!confirmed ? (
                  <MenuItem onSelect={() => { close(); onConfirmEmail(); }}>
                    Confirm email address
                  </MenuItem>
                ) : null}
                <MenuItem onSelect={() => { close(); onAsk('signout'); }}>
                  Sign out everywhere…
                </MenuItem>
                <div className="sh-menu__sep" />
                {banned ? (
                  <MenuItem onSelect={() => { close(); onUnban(); }}>
                    Lift the ban
                  </MenuItem>
                ) : (
                  <MenuItem tone="danger" onSelect={() => { close(); onAsk('ban'); }}>
                    Ban…
                  </MenuItem>
                )}
                <MenuItem tone="danger" onSelect={() => { close(); onAsk('delete'); }}>
                  Delete…
                </MenuItem>
              </>
            )}
          </Menu>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The detail disclosure: ids and the two metadata objects.
 *
 * A panel rather than a dialog, and rather than a route. §3's subject test says
 * inspecting one row is not a subject change, and §3's next line says a panel
 * that blocks the page to show read-only text is a dialog that forgot it had
 * nothing to ask. So it sits in flow above the rows, the same mechanism the
 * table editor's structure and policy panels use.
 *
 * The metadata is here rather than in the table because it is arbitrary JSON of
 * arbitrary size: a column for it would be either useless at 200px or the widest
 * thing on the page.
 */
function UserDetail({ user, onClose }: { user: AuthUser; onClose: () => void }) {
  return (
    <div className="deckpanel">
      <div className="deckpanel__head">
        <span className="deckpanel__title">{user.email ?? 'This user'}</span>
        <button type="button" className="tbtn" onClick={onClose}>Close</button>
      </div>
      <div className="deckpanel__body">
        {/* `.facts__k` / `.facts__v` as direct children — `.facts` is a
            two-column grid and a row wrapper would collapse it to one column. */}
        <div className="facts">
          <div className="facts__k">User id</div>
          <div className="facts__v">
            <code style={{ font: 'var(--sh-code)' }}>{user.id}</code>
          </div>
          <div className="facts__k">Email confirmed</div>
          <div className="facts__v">
            {user.email_confirmed_at ? when(user.email_confirmed_at) : 'not confirmed'}
          </div>
          <div className="facts__k">Banned until</div>
          <div className="facts__v">
            {user.banned_until ? when(user.banned_until) : 'not banned'}
          </div>
          <div className="facts__k">Signed up</div>
          <div className="facts__v">{when(user.created_at)}</div>
          <div className="facts__k">Last sign-in</div>
          <div className="facts__v">
            {user.last_sign_in_at ? when(user.last_sign_in_at) : 'never'}
          </div>
        </div>

        {/* Both halves, labelled by who writes them — the distinction is the
            whole reason there are two, and a page showing one "metadata" blob
            would hide that the app can write only one of them. */}
        <Json title="user_metadata"
              hint="Your app writes this, and the user can change it through the auth API."
              value={user.user_metadata} />
        <Json title="app_metadata"
              hint="Your server writes this. The user cannot change it, so this is where a role or a plan belongs."
              value={user.app_metadata} />
      </div>
    </div>
  );
}

function Json({ title, hint, value }: {
  title: string; hint: string; value: Record<string, unknown>;
}) {
  const empty = Object.keys(value ?? {}).length === 0;
  return (
    <div style={{ marginTop: 'var(--sh-space-16)' }}>
      <div className="sh-label">{title}</div>
      <p className="sh-help" style={{ marginTop: 2 }}>{hint}</p>
      {empty ? (
        <p className="sqlres__none">Empty.</p>
      ) : (
        <div className="sh-code"><pre>{JSON.stringify(value, null, 2)}</pre></div>
      )}
    </div>
  );
}

/**
 * A timestamp a person can read, with the exact value on hover.
 *
 * Relative alone loses the information a support ticket needs ("was this before
 * or after the incident"), and absolute alone makes scanning a column of
 * addresses harder than it should be. The title attribute is the compromise the
 * grid already uses.
 */
function when(iso: string) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={d.toISOString()}>
      {d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
    </time>
  );
}
