'use client';

import { use, useState } from 'react';
import { can, canAssignRole, canActOn, type Role } from '@steadhold/types';
import { useOrgBySlug, useMe, useMembers, useInvites, useSetMemberRole,
         useRemoveMember, useInvite, useRevokeInvite } from '../../../../lib/queries.ts';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { Select, Menu, MenuItem } from '../../../../components/Menu.tsx';
import { ConfirmDialog } from '../../../../components/ConfirmDialog.tsx';
import { useReturnFocus } from '../../../../lib/return-focus.ts';
import { CopyButton } from '../../../../components/Copy.tsx';
import { useToast } from '../../../../components/Toasts.tsx';

/**
 * Organization members and invitations.
 *
 * Two things here are decisions rather than layout.
 *
 * **Affordances come from the shared capability matrix** (`@steadhold/types`,
 * D-428), not from a copy of it. A member does not see an Invite form that exists
 * only to return 403, and an admin does not see "owner" in a role select they are
 * not allowed to assign — `canAssignRole` says so, and it is the same function the
 * API enforces with. The API stays the authority: every mutation can still fail,
 * and when it does the error carries its code and `request_id` (D-032).
 *
 * **An invite is not an email.** The platform returns a one-time token and
 * `delivery: 'not_emailed_yet'`, because the sender is a later phase — its own
 * response carries a `warning` saying to pass the token on by hand. So this page
 * shows the token once, makes it copyable, and says plainly that nothing was sent.
 * A confirmation reading "Invitation sent" would be describing something that did
 * not happen, which is the failure gate question 19 exists to catch.
 */
const ROLES: Role[] = ['owner', 'admin', 'member'];

export default function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { org } = useOrgBySlug(slug);
  const me = useMe();
  const orgId = org?.id;
  const members = useMembers(orgId);
  const invites = useInvites(orgId);

  /** My role *in this org* — not a global one; the shell switches orgs. */
  const myRole = me.data?.memberships.find((m) => m.org_id === orgId)?.role;
  const myUserId = me.data?.user?.id;
  const ownerCount = (members.data?.members ?? []).filter((m) => m.role === 'owner').length;

  if (members.error) {
    return <ErrorSurface error={members.error} onRetry={() => void members.refetch()}
                         title="Could not load members" />;
  }

  return (
    <div className="page">
      <header className="pagehead">
        <h1 className="pagetitle">Members</h1>
        <p className="pagesub">
          Who can see and change things in {org?.name ?? 'this organization'}.
        </p>
      </header>

      {myRole && can(myRole, 'member.invite')
        ? <InviteForm orgId={orgId!} myRole={myRole} />
        : null}

      <People orgId={orgId} myRole={myRole} myUserId={myUserId}
              members={members} invites={invites} />
    </div>
  );
}

function InviteForm({ orgId, myRole }: { orgId: string; myRole: Role }) {
  const invite = useInvite(orgId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  /**
   * You cannot *invite* an owner.
   *
   * An organization has one owner and any number of admins, so `owner` is not a
   * role you hand out at the door — it is a transfer, which is a different act with
   * a different question attached ("and who stops being the owner?"). Offering it
   * in an invite made a one-of-a-kind role look like a tier.
   *
   * `canAssignRole` still filters what is left, because an admin may not invite
   * peers above themselves; this narrows the *menu*, not the permission model. The
   * API is unchanged and still accepts `owner` — promoting someone is done from
   * their row, where the org's current owner is visible in the same list.
   */
  const assignable = ROLES
    .filter((r) => r !== 'owner')
    .filter((r) => canAssignRole(myRole, r));

  return (
    <section className="section">
      <h2 className="sectiontitle">Invite someone</h2>
      <form className="sh-row" style={{ gap: 'var(--sh-space-12)', alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') });
        }}>
        <div className="sh-field" style={{ flex: 1, minWidth: 0 }}>
          <label className="sh-label" htmlFor="invite-email">Email</label>
          <input id="invite-email" className="sh-input" type="email" required
            value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="them@example.com" />
        </div>
        <div className="sh-field">
          <label className="sh-label" htmlFor="invite-role">Role</label>
          <Select id="invite-role" label="Role for the invitee" value={role}
            options={assignable.map((r) => ({ value: r, label: r }))}
            onChange={setRole} />
        </div>
        <button className="sh-btn" type="submit" disabled={invite.isPending || !email.trim()}>
          {invite.isPending ? 'Creating…' : 'Create invite'}
        </button>
      </form>

      {invite.error
        ? <ErrorSurface error={invite.error} title="Could not create the invite" />
        : null}

      {invite.data ? <InviteToken data={invite.data} /> : null}
    </section>
  );
}

/**
 * The token, shown exactly once.
 *
 * A warning banner rather than a success toast, because the operation half
 * succeeded and the part the user cares about — the invitee finding out — has not
 * happened. The API's own response says `delivery: 'not_emailed_yet'` and carries a
 * `warning`; this renders that rather than paraphrasing it, so if the sender ships
 * and the field changes, the page stops saying it.
 */
function InviteToken({ data }: {
  data: { invite: { email: string; role: string; expires_at: string };
          token: string; delivery: string; warning: string };
}) {
  const emailed = data.delivery !== 'not_emailed_yet';
  return (
    <div className={`sh-banner ${emailed ? 'sh-banner--success' : 'sh-banner--warning'}`}
         role="status" style={{ marginTop: 'var(--sh-space-16)' }}>
      <div className="sh-banner__body">
        <div className="sh-banner__title">
          Invite created for {data.invite.email} — {emailed ? 'and emailed' : 'not emailed'}
        </div>
        <div className="sh-banner__text">{data.warning}</div>
        <div className="sh-row sh-row--tight" style={{ marginTop: 'var(--sh-space-12)' }}>
          <code style={{ font: 'var(--sh-code)', overflowWrap: 'anywhere' }}>{data.token}</code>
          <CopyButton value={data.token} what="invite token" />
        </div>
        <div className="sh-help" style={{ marginTop: 'var(--sh-space-8)' }}>
          They accept it at <code style={{ font: 'var(--sh-code)' }}>/accept-invite/{data.token}</code> —
          expires {new Date(data.invite.expires_at).toLocaleString()}.
        </div>
      </div>
    </div>
  );
}

/**
 * One list, because there is one question: who has access to this organization.
 *
 * It used to be two tables — People, then Pending invitations — with different
 * columns for the same subject. An invitation is not a different kind of thing; it
 * is a person in a pending state, and splitting them duplicated the columns, gave
 * the page a second empty state that should not exist, and made "who is in my org"
 * a question you answered by reading two places and adding up.
 *
 * **Role is text, not a control.** A live `<select>` per person made the list read
 * as a form, and role is a badge you read; changing it is an action in the `⋯`
 * menu, the same idiom the projects list uses.
 *
 * **There is no table here, and that is deliberate.** This was a table, and it
 * could not hold its own content: a display name sits beside an email address, an
 * email is one unbreakable token, and three attempts to make four columns
 * negotiate that space produced three different defects — the name squeezed to
 * 43px and wrapping, the joined date folding under the status dot, and then a
 * table wider than a `.tablewrap` that D-432 forbids clipping. Inner horizontal
 * scroll was the remaining option and D-432 rules it out for the same reason: the
 * row menu is absolutely positioned and a clipping ancestor erases it.
 *
 * So the table is gone rather than toggled. A card has no columns to negotiate:
 * the name owns a line and never yields, the email sits beneath it where its
 * length costs nothing, role and status are facts on one line, actions go last.
 * §4 prefers a table for comparison and this list is not one people compare —
 * it answers "who has access", one person at a time. (D-447, D-449.)
 */
type Row =
  | { kind: 'member'; id: string; email: string; name: string | null; role: Role; joined: string }
  | { kind: 'invite'; id: string; email: string; role: Role; expires: string };

const RANK: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

function People({ orgId, myRole, myUserId, members, invites }: {
  orgId: string | undefined;
  myRole: Role | undefined;
  myUserId: string | undefined;
  members: ReturnType<typeof useMembers>;
  invites: ReturnType<typeof useInvites>;
}) {
  const rows: Row[] = [
    ...(members.data?.members ?? []).map((m): Row => ({
      kind: 'member', id: m.user_id, email: m.email, name: m.display_name,
      role: m.role, joined: m.joined_at,
    })),
    ...(invites.data?.invites ?? []).map((i): Row => ({
      kind: 'invite', id: i.id, email: i.email, role: i.role, expires: i.expires_at,
    })),
  ].sort((a, b) =>
    // Members before invitations, then by seniority, then alphabetically — a
    // stable order, so a role change does not make rows jump.
    (a.kind === b.kind ? 0 : a.kind === 'member' ? -1 : 1)
    || RANK[a.role] - RANK[b.role]
    || a.email.localeCompare(b.email));

  const owners = rows.filter((r) => r.kind === 'member' && r.role === 'owner').length;
  const pending = rows.filter((r) => r.kind === 'invite').length;

  if (members.isPending) return <PeopleSkeleton />;

  return (
    <section className="section">
      <h2 className="sectiontitle">
        People ({members.data?.members.length ?? 0})
        {pending ? <span className="sh-help"> · {pending} invited</span> : null}
      </h2>
      <div className="personcards">
        {rows.map((r) => (
          <PersonCard key={`${r.kind}:${r.id}`} row={r} orgId={orgId!} myRole={myRole}
                      isMe={r.kind === 'member' && r.id === myUserId}
                      ownerCount={owners} />
        ))}
      </div>
    </section>
  );
}

function PeopleSkeleton() {
  return (
    <section className="section">
      <h2 className="sectiontitle">People</h2>
      <div className="personcards" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div className="personcard" key={i}>
            <div className="personcard__id">
              <div className="sh-skeleton" style={{ width: 140, height: 18 }} />
              <div className="sh-skeleton" style={{ width: 200, height: 13, marginTop: 6 }} />
            </div>
            <div className="personcard__facts">
              <div className="sh-skeleton" style={{ width: 52, height: 20 }} />
              <div className="sh-skeleton" style={{ width: 150, height: 16 }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** An invitation past its expiry. Presentation, so each view computes it. */
const isExpired = (row: Row) =>
  row.kind === 'invite' && new Date(row.expires).getTime() < Date.now();

/**
 * Everything a person's row or card can *do*, in one place.
 *
 * Extracted when the card view arrived. The capability flags, the `⋯` menu, the
 * single button an invitation gets and both confirmation dialogs are the parts
 * with rules attached — D-430's "a menu earns its keep at two actions or more",
 * D-431's "every destructive action confirms", `canActOn`, and the last-owner
 * invariant. Duplicating those per view is how one view quietly loses a rule the
 * other keeps. The views differ in how they present *identity*, which is
 * presentation; they share this, which is behaviour.
 */
function PersonActions({ row, orgId, myRole, ownerCount }: {
  row: Row; orgId: string; myRole: Role | undefined; ownerCount: number;
}) {
  const setRole = useSetMemberRole(orgId);
  const remove = useRemoveMember(orgId);
  const revoke = useRevokeInvite(orgId);
  const toast = useToast();
  /** Which destructive action is awaiting confirmation, if any. */
  const [confirm, setConfirm] = useState<null | 'remove' | 'revoke'>(null);
  // Captured at the click that opens the dialog, not inside it — see the hook.
  const { capture } = useReturnFocus();
  const ask = (what: 'remove' | 'revoke') => { capture(); setConfirm(what); };

  /** The store's first invariant: an org always has at least one owner. */
  const lastOwner = row.kind === 'member' && row.role === 'owner' && ownerCount === 1;
  const mayManage = Boolean(myRole && canActOn(myRole, row.role));
  const mayChangeRole = Boolean(myRole && can(myRole, 'member.role.change')) && mayManage && !lastOwner;
  const mayRemove = Boolean(myRole && can(myRole, 'member.remove')) && mayManage && !lastOwner;
  const mayRevoke = Boolean(myRole && can(myRole, 'member.invite'));

  const busy = setRole.isPending || remove.isPending || revoke.isPending;

  return (
    <>
      {/**
          * An invitation has exactly one action, so it is a button and not a menu:
          * a menu earns its extra click when it holds two or more things, and for
          * one it is just a lid. Members keep the `⋯` because they have several —
          * the role changes and the removal — which is also the idiom the projects
          * table uses, so the two lists behave alike where they can.
          *
          * Both destructive actions go through a confirmation dialog. Revoking an
          * invitation is reversible by inviting again, and it is still confirmed:
          * the rule is about the *class* of action, because a user who learns that
          * some deletes ask and others do not has to read every button carefully,
          * which is the opposite of what a confirmation is for.
          */}
        {row.kind === 'invite' ? (
          mayRevoke ? (
            <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
              disabled={busy} onClick={() => ask('revoke')}>
              {revoke.isPending ? 'Revoking…' : 'Revoke'}
            </button>
          ) : null
        ) : (mayChangeRole || mayRemove) ? (
          <Menu label={`Actions for ${row.email}`} align="right"
            trigger={({ open, toggle, ref }) => (
              <button ref={ref} type="button" className="rowbtn" disabled={busy}
                aria-haspopup="menu" aria-expanded={open} onClick={toggle}
                aria-label={`Actions for ${row.email}`}>⋯</button>
            )}>
            {(close) => (
              <>
                {mayChangeRole
                  ? ROLES.filter((r) => canAssignRole(myRole!, r)).map((r) => (
                      <MenuItem key={r} active={r === row.role}
                        onSelect={() => {
                          if (r !== row.role) {
                            setRole.mutate({ userId: row.id, role: r }, {
                              onSuccess: () => toast.show({
                                tone: 'success', title: `${row.email} is now ${r}` }),
                              onError: (err) => toast.apiError('Could not change the role', err),
                            });
                          }
                          close();
                        }}>
                        Make {r}
                        {r === row.role
                          ? <span className="sh-menu__check" aria-hidden="true">✓</span>
                          : null}
                      </MenuItem>
                    ))
                  : null}
                {mayRemove ? (
                  <>
                    <div className="sh-menu__sep" />
                    <MenuItem tone="danger"
                      onSelect={() => { close(); ask('remove'); }}>
                      Remove from organization
                    </MenuItem>
                  </>
                ) : null}
              </>
            )}
          </Menu>
        ) : lastOwner ? (
          <span className="sh-help" style={{ whiteSpace: 'nowrap' }}>Last owner</span>
        ) : null}

        <ConfirmDialog open={confirm === 'revoke'}
          title="Revoke this invitation?"
          confirmLabel="Revoke invitation"
          pending={revoke.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => revoke.mutate(row.id, {
            onSuccess: () => {
              setConfirm(null);
              toast.show({ tone: 'success', title: `Invitation to ${row.email} revoked` });
            },
            onError: (err) => { setConfirm(null); toast.apiError('Could not revoke it', err); },
          })}>
          <strong>{row.email}</strong> will no longer be able to join with the link
          they were sent. You can invite them again at any time.
        </ConfirmDialog>

        <ConfirmDialog open={confirm === 'remove'}
          title="Remove this person?"
          confirmLabel="Remove from organization"
          pending={remove.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove.mutate(row.id, {
            onSuccess: () => {
              setConfirm(null);
              toast.show({ tone: 'success', title: `${row.email} removed`,
                           detail: 'Invite them again to restore access.' });
            },
            onError: (err) => { setConfirm(null); toast.apiError('Could not remove them', err); },
          })}>
          <strong>{row.email}</strong> loses access to this organization and every
          project in it. Their projects and data are not deleted. Inviting them
          again restores access.
        </ConfirmDialog>
    </>
  );
}

/**
 * A person as a **card**, which is the default view.
 *
 * The table was the default and it could not hold this content in the width it
 * gets. Three attempts to make four columns negotiate a display name beside an
 * unbreakable email address produced three different defects: the name squeezed
 * to 43px and wrapping onto two lines, "· joined 08/09/2026" folding under the
 * status dot, and then — once the cells were told not to wrap — a table wider
 * than the container it may not clip (D-432).
 *
 * A card has no columns to negotiate, so the class of problem is gone rather than
 * moved. The name gets its own line and never yields; the email sits beneath it
 * where its length is nobody's problem; role and status are facts on one line;
 * actions sit at the bottom. The table remains available behind the view toggle,
 * for the case §4 actually wants a table for — comparing many rows.
 */
function PersonCard({ row, orgId, myRole, isMe, ownerCount }: {
  row: Row; orgId: string; myRole: Role | undefined; isMe: boolean; ownerCount: number;
}) {
  const expired = isExpired(row);
  const name = row.kind === 'member' ? (row.name ?? row.email) : row.email;
  const secondary = row.kind === 'member' && row.name ? row.email : null;

  return (
    <div className="personcard">
      <div className="personcard__id">
        <div className="sh-row sh-row--tight">
          <span className="personcard__name">{name}</span>
          {isMe ? <span className="sh-badge sh-badge--accent">You</span> : null}
        </div>
        {secondary ? <div className="personcard__email">{secondary}</div> : null}
      </div>

      <div className="personcard__facts">
        <span className="sh-badge">{row.role}</span>
        {row.kind === 'member' ? (
          <span className="sh-status">
            <span className="sh-status__dot sh-status__dot--success" />
            Active
            <span className="sh-help"> · joined {new Date(row.joined).toLocaleDateString()}</span>
          </span>
        ) : expired ? (
          <span className="sh-badge sh-badge--warning">Invitation expired</span>
        ) : (
          <span className="sh-status">
            <span className="sh-status__dot sh-status__dot--muted" />
            Invited
            <span className="sh-help"> · expires {new Date(row.expires).toLocaleDateString()}</span>
          </span>
        )}
      </div>

      <div className="personcard__actions">
        <PersonActions row={row} orgId={orgId} myRole={myRole} ownerCount={ownerCount} />
      </div>
    </div>
  );
}

