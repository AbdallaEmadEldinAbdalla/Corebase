'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { can } from '@steadhold/types';
import { useProject, useOrgs, useMe, usePauseProject, useDeleteProject } from '../../../../lib/queries.ts';
import { ConfirmDialog } from '../../../../components/ConfirmDialog.tsx';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { useToast } from '../../../../components/Toasts.tsx';

/**
 * Project settings.
 *
 * The IA asks this page for three things — project name, pause/resume, and a
 * danger zone. Two of them exist; the third does not, and the page says so
 * instead of rendering a field that cannot save (gate question 19).
 *
 * **Pause had no UI anywhere.** Resume did — the grid's inline button and D-131's
 * auto-resume — so the platform could stop a project only by waiting seven days
 * for the idle sweeper. That asymmetry is the reason this page exists now rather
 * than after the API-blocked screens.
 *
 * **Pausing is not confirmed, and that is deliberate.** D-431 makes every
 * *destructive* action confirm, and the value of that rule is entirely in what a
 * dialog comes to mean: if a reversible action also asks, the dialog stops
 * signalling "this one is different". Pausing destroys nothing, and opening the
 * project undoes it. So it is a direct button that says what it does, and the
 * dialog is spent on the one action here that cannot be taken back by clicking.
 */
export default function ProjectSettingsPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const project = useProject(ref);
  const orgs = useOrgs();
  const me = useMe();
  const router = useRouter();
  const toast = useToast();

  const p = project.data?.project;
  const orgSlug = orgs.data?.orgs.find((o) => o.id === p?.org_id)?.slug;
  /** The role in *this project's* org, which is not necessarily the active one. */
  const myRole = me.data?.memberships.find((m) => m.org_id === p?.org_id)?.role;

  const pause = usePauseProject(ref, p?.org_id);
  const del = useDeleteProject(ref, p?.org_id);
  const [confirming, setConfirming] = useState(false);

  /**
   * `me` is part of the loading gate, not just `project`. Both capability checks
   * read `myRole`, and an absent role is indistinguishable from a role without the
   * capability — so a page that rendered before `me` arrived told the user they
   * lacked permission and hid the danger zone, which is an unresolved request
   * presented as a verdict (Q18).
   */
  if (project.isPending || me.isPending) {
    /**
     * Two sections and a facts grid, because that is what arrives — a single
     * generic card would resolve into three and the page would jump (Q16).
     * The danger zone is not skeletoned: whether it renders at all depends on a
     * role, and drawing a placeholder for it would promise a section a member
     * never gets.
     */
    return (
      <div className="wrap wrap--narrow">
        <div className="head"><div><h1 className="head__title">Settings</h1></div></div>
        {['General', 'Availability'].map((label) => (
          <section className="section" key={label}>
            <div className="section__head"><h2 className="section__title">{label}</h2></div>
            <div className="card"><div className="card__body" aria-busy="true">
              <div className="facts">
                {[0, 1, 2, 3].map((i) => (
                  <div className="sh-skeleton" key={i} style={{ height: 16, width: i % 2 ? '70%' : 90 }} />
                ))}
              </div>
            </div></div>
          </section>
        ))}
      </div>
    );
  }

  if (project.error || !p) {
    return (
      <div className="wrap">
        <div className="head"><div><h1 className="head__title">Settings</h1></div></div>
        <ErrorSurface error={project.error} title="This project could not be loaded" />
      </div>
    );
  }

  const canPause = myRole !== undefined && can(myRole, 'project.lifecycle');
  const canDelete = myRole !== undefined && can(myRole, 'project.delete');
  /** Only a running project can be paused; the API answers anything else with 409. */
  const pausable = p.status === 'ready';

  return (
    <div className="wrap wrap--narrow">
      <div className="head">
        <div>
          <h1 className="head__title">Settings</h1>
          <p className="head__sub">What this project is, and how to stop it.</p>
        </div>
      </div>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">General</h2>
          <p className="section__note">
            The reference is permanent — it is in every connection string and key.
          </p>
        </div>
        <div className="card">
          <div className="card__body">
            <dl className="facts">
              <dt className="facts__k">Name</dt>
              <dd className="facts__v">{p.name}</dd>
              <dt className="facts__k">Reference</dt>
{/* A bare `<code>`: `.facts__v code` styles it (shell.css). `.sh-code` is
                  the code *block* container — dark ink background in both themes with
                  its own `pre` colour — so on an inline element the text inherited the
                  page colour and the row rendered as a black bar in light mode, and as
                  nothing at all in dark, where the background happens to match. */}
              <dd className="facts__v"><code>{p.ref}</code></dd>
              <dt className="facts__k">Environment</dt>
              <dd className="facts__v">{p.environment}</dd>
              <dt className="facts__k">Created</dt>
              <dd className="facts__v">{new Date(p.created_at).toLocaleString()}</dd>
            </dl>
          </div>
          <div className="card__foot">
            Renaming a project is not built — the platform API has no route for it.
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Availability</h2>
          <p className="section__note">
            A paused project keeps its data, its volume and its keys.
          </p>
        </div>
        <div className="card">
          <div className="card__body">
            <p style={{ margin: 0, font: 'var(--sh-body-m)' }}>
              Pausing stops the database and the data API. Nothing is deleted, and
              nothing needs to be restored: opening any page of the project starts
              it again, usually in a few seconds.
            </p>
            <div className="sh-row" style={{ marginTop: 'var(--sh-space-16)' }}>
              <button type="button" className="sh-btn sh-btn--secondary"
                disabled={!canPause || !pausable || pause.isPending}
                onClick={() => pause.mutate(undefined, {
                  onSuccess: () => toast.show({
                    tone: 'success', title: 'Pausing this project',
                    detail: 'Opening any page of it starts it again.',
                  }),
                  onError: (err) => toast.apiError('Could not pause this project', err),
                })}>
                {pause.isPending ? 'Pausing…' : 'Pause this project'}
              </button>
            </div>
          </div>
          {!canPause ? (
            <div className="card__foot">Pausing and resuming need the member role or above.</div>
          ) : !pausable ? (
            <div className="card__foot">
              {/* One element, not loose prose: `.card__foot` is a flex row with a
                  12px gap, so an inline `<strong>` becomes its own flex item and
                  the sentence renders "is  paused  ." with the period adrift.
                  Every foot before this one was a bare string, which is why the
                  trap was invisible. */}
              <span>Only a running project can be paused. This one is <strong>{p.status}</strong>.</span>
            </div>
          ) : null}
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
                Deleting stops this project and starts a recovery window. The
                database, its volume and a final backup are kept until the window
                closes, and then destroyed permanently. The exact deadline is set by
                this deployment and is shown as soon as the deletion starts.
              </p>
              <p className="sh-help" style={{ marginTop: 'var(--sh-space-12)' }}>
                There is no button that brings it back. Recovery inside the window is
                a support request, because nothing in the platform API restores a
                deleted project yet.
              </p>
              <div className="sh-row" style={{ marginTop: 'var(--sh-space-16)' }}>
                <button type="button" className="sh-btn sh-btn--danger"
                  disabled={del.isPending}
                  onClick={() => setConfirming(true)}>
                  {del.isPending ? 'Deleting…' : 'Delete this project'}
                </button>
              </div>
              {del.error ? (
                <div style={{ marginTop: 'var(--sh-space-16)' }}>
                  <ErrorSurface error={del.error} title="This project was not deleted" />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={`Delete ${p.name}?`}
        confirmLabel="Delete this project"
        tone="danger"
        requireText={p.name}
        pending={del.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => del.mutate(undefined, {
          onSuccess: (r) => {
            setConfirming(false);
            /**
             * The deadline comes from the response rather than being computed as
             * "now + 7 days": the window is set by the saga, and a date the UI
             * derived on its own is a second authority for it (D-434).
             */
            const until = r.project.restorable_until;
            toast.show({
              tone: 'success',
              title: `${p.name} is being deleted`,
              ...(until ? { detail: `Recoverable by support until ${new Date(until).toLocaleString()}.` } : {}),
            });
            router.replace(orgSlug ? `/org/${orgSlug}` : '/');
          },
          onError: () => setConfirming(false),
        })}
      >
        <p style={{ margin: 0 }}>
          The database stops now. It and a final backup are kept until this
          deployment's recovery window closes, and are then destroyed permanently.
        </p>
        <p className="sh-help" style={{ marginTop: 'var(--sh-space-12)' }}>
          Recovery inside that window is a support request — there is no self-serve
          undo. You will be given the exact deadline.
        </p>
      </ConfirmDialog>
    </div>
  );
}
