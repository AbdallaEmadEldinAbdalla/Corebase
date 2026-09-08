'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { can } from '@steadhold/types';
import { useOrgBySlug, useMe, useRenameOrg, useDeleteOrg } from '../../../../lib/queries.ts';
import { ConfirmDialog } from '../../../../components/ConfirmDialog.tsx';
import { ErrorSurface, FieldError } from '../../../../components/ErrorSurface.tsx';
import { ApiError } from '../../../../lib/api.ts';
import { useToast } from '../../../../components/Toasts.tsx';

/**
 * Organization settings.
 *
 * The IA asks for "org name/slug, danger zone". Only one of those two is
 * editable: the platform API renames the **name** and has no route for the slug,
 * which is correct rather than missing — the slug is in every URL anyone has
 * bookmarked, pasted into a ticket or hard-coded into a script. So it is shown as
 * a permanent fact and labelled one.
 *
 * **Deleting an organization is not like deleting a project.** A project gets a
 * recovery window (D-038); an organization is `DELETE FROM organizations`, and the
 * only thing that outlives it is the audit trail, which has no foreign key
 * precisely so those rows survive. The dialog says so in those terms, because a
 * user who has just learned that projects are recoverable for seven days will
 * reasonably assume this is too.
 *
 * **The blocking condition is stated before it is hit.** The API refuses with a
 * 409 while the org still holds projects, and its predicate is `status <>
 * 'deleted'` — so a project inside its *own* recovery window still counts, while
 * the projects grid deliberately hides it (D-430). Without saying that, the
 * honest sequence is: delete every project, see an empty grid, try to delete the
 * org, and be told it "still has 1 project(s)". The count here comes from
 * `project_count` on the org itself, which is computed with that same predicate —
 * one authority, not a second opinion.
 */
export default function OrgSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { org, isPending, error } = useOrgBySlug(slug);
  const me = useMe();
  const router = useRouter();
  const toast = useToast();

  const orgId = org?.id;
  const myRole = me.data?.memberships.find((m) => m.org_id === orgId)?.role;

  const rename = useRenameOrg(orgId ?? '');
  const del = useDeleteOrg(orgId ?? '');
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);

  /** Seed the field once the org arrives, and re-seed if it changes elsewhere. */
  useEffect(() => { if (org) setName(org.name); }, [org?.name, org?.id]);

  if (isPending || me.isPending) {
    return (
      <div className="wrap wrap--narrow">
        <Head />
        {/* General only. Whether a danger zone renders at all depends on a role
            that is still loading, so drawing one would promise an admin a section
            they never receive — under-draw rather than over-promise. */}
        <section className="section">
          <div className="section__head"><h2 className="section__title">General</h2></div>
          <div className="card"><div className="card__body" aria-busy="true">
            <div className="sh-skeleton" style={{ width: 90, height: 14 }} />
            <div className="sh-skeleton" style={{ width: '100%', height: 38, marginTop: 8 }} />
            <div className="facts" style={{ marginTop: 'var(--sh-space-24)' }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <div className="sh-skeleton" key={i}
                  style={{ height: 16, width: i % 2 ? '55%' : 80 }} />
              ))}
            </div>
          </div></div>
        </section>
      </div>
    );
  }

  if (error || !org) {
    return (
      <div className="wrap wrap--narrow">
        <Head />
        <ErrorSurface error={error} title="This organization could not be loaded" />
      </div>
    );
  }

  const canRename = myRole !== undefined && can(myRole, 'org.update');
  const canDelete = myRole !== undefined && can(myRole, 'org.delete');
  const holdsProjects = org.project_count > 0;
  const dirty = name.trim() !== org.name && name.trim().length > 0;

  return (
    <div className="wrap wrap--narrow">
      <Head />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">General</h2>
          <p className="section__note">
            The name is what people see. The slug is what URLs use.
          </p>
        </div>
        <div className="card">
          <div className="card__body">
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!dirty || rename.isPending) return;
              const before = org.name;
              rename.mutate(name.trim(), {
                onSuccess: (r) => toast.show({
                  tone: 'success', title: `Renamed to ${r.org.name}`,
                  // Q14 asks for the inverse where one exists, and a rename's
                  // inverse is exact: the previous name, captured at submit.
                  action: {
                    label: 'Undo',
                    run: () => rename.mutate(before, {
                      onSuccess: () => toast.show({
                        tone: 'success', title: `Back to ${before}` }),
                      onError: (err) => toast.apiError('Could not undo the rename', err),
                    }),
                  },
                }),
                onError: (err) => toast.apiError('Could not rename this organization', err),
              });
            }}>
              <div className="sh-field">
                <label className="sh-label" htmlFor="org-name">Name</label>
                <input id="org-name" className="sh-input" type="text" value={name}
                  disabled={!canRename || rename.isPending}
                  onChange={(e) => setName(e.target.value)} />
                {/* At the field, because the failure is about this value —
                    typically a name that is too short or already taken. The
                    toast carries the code and `request_id` (Q17); this carries
                    the sentence to the place it applies to. */}
                {rename.error instanceof ApiError
                  ? <FieldError>{rename.error.message}</FieldError>
                  : null}
              </div>
              {canRename ? (
                <div className="sh-row" style={{ marginTop: 'var(--sh-space-16)' }}>
                  <button type="submit" className="sh-btn"
                    disabled={!dirty || rename.isPending}>
                    {rename.isPending ? 'Saving…' : 'Save'}
                  </button>
                  {dirty && !rename.isPending ? (
                    <button type="button" className="sh-btn sh-btn--ghost"
                      onClick={() => setName(org.name)}>Cancel</button>
                  ) : null}
                </div>
              ) : null}
            </form>

            <dl className="facts" style={{ marginTop: 'var(--sh-space-24)' }}>
              <dt className="facts__k">Slug</dt>
              <dd className="facts__v"><code>{org.slug}</code></dd>
              <dt className="facts__k">Created</dt>
              <dd className="facts__v">{new Date(org.created_at).toLocaleString()}</dd>
              <dt className="facts__k">Members</dt>
              <dd className="facts__v">{org.member_count}</dd>
              <dt className="facts__k">Projects</dt>
              <dd className="facts__v">{org.project_count}</dd>
            </dl>
          </div>
          <div className="card__foot">
            <span>
              {canRename
                ? 'The slug is permanent — it is in every connection string, URL and bookmark. The platform API has no route to change it.'
                : 'Renaming an organization needs the admin role or above.'}
            </span>
          </div>
        </div>
      </section>

      {canDelete ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Danger zone</h2>
          </div>
          <div className="card card--danger">
            <div className="card__body">
              <p style={{ margin: 0, font: 'var(--sh-body-m)' }}>
                Deleting this organization removes it and every membership in it,
                permanently and at once. Unlike a project, there is no recovery
                window — only the audit trail survives.
              </p>
              {holdsProjects ? (
                <p className="sh-help" style={{ marginTop: 'var(--sh-space-12)' }}>
                  {/* Phrased so the sentence agrees at any count — "holds 1
                      project, which have to go first" was the first version. */}
                  Every project has to go first, and this organization still holds{' '}
                  <strong>{org.project_count}</strong>. A project you have already
                  deleted still counts until its own seven-day recovery window
                  closes, even though the projects list no longer shows it.
                </p>
              ) : null}
              {holdsProjects ? (
                <p style={{ marginTop: 'var(--sh-space-12)' }}>
                  {/* §7: never a dead end. The blocker is elsewhere, so the page
                      points at it rather than only naming it. */}
                  <Link href={`/org/${slug}`} className="sh-btn sh-btn--ghost sh-btn--sm">
                    Go to projects
                  </Link>
                </p>
              ) : null}
              <div className="sh-row" style={{ marginTop: 'var(--sh-space-16)' }}>
                <button type="button" className="sh-btn sh-btn--danger"
                  disabled={holdsProjects || del.isPending}
                  onClick={() => setConfirming(true)}>
                  {del.isPending ? 'Deleting…' : 'Delete this organization'}
                </button>
              </div>
              {del.error ? (
                <div style={{ marginTop: 'var(--sh-space-16)' }}>
                  <ErrorSurface error={del.error} title="This organization was not deleted" />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={`Delete ${org.name}?`}
        confirmLabel="Delete this organization"
        tone="danger"
        requireText={org.name}
        pending={del.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => del.mutate(undefined, {
          onSuccess: () => {
            setConfirming(false);
            toast.show({ tone: 'success', title: `${org.name} deleted` });
            // `/` decides where to land: another organization, or `/no-org`. The
            // page cannot know which, and guessing would be a 404 either way.
            router.replace('/');
          },
          onError: () => setConfirming(false),
        })}
      >
        <p style={{ margin: 0 }}>
          This removes the organization and every membership in it. It cannot be
          undone and there is no recovery window.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function Head() {
  return (
    <div className="head">
      <div>
        <h1 className="head__title">Settings</h1>
        <p className="head__sub">What this organization is called, and how to close it.</p>
      </div>
    </div>
  );
}
