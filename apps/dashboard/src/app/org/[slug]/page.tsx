'use client';

import Link from 'next/link';
import { use, useEffect } from 'react';
import { AppShell } from '../../../components/AppShell.tsx';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { ProjectStateBadge } from '../../../components/ProjectState.tsx';
import { useOrgBySlug, useProjects } from '../../../lib/queries.ts';
import { rememberOrg } from '../../../lib/last-org.ts';
import type { Project } from '../../../lib/api.ts';

/**
 * The projects grid — the page people land on and the one the card was drawn for.
 *
 * Two things it does *not* do, both on purpose. It shows no per-project numbers
 * (the board's card has "DB 412 MB · 18.2k req / 24h") because there is no metrics
 * path yet and OQ-149 has not been decided: an invented number on the first page
 * of the product is worse than an honest gap. And a soft-deleted project stays
 * listed with its recovery deadline (D-199, D-205) rather than disappearing,
 * because the seven-day window is only usable if you can see it.
 */
export default function OrgProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { org, isLoading: orgLoading, error: orgError } = useOrgBySlug(slug);
  const projects = useProjects(org?.id);

  useEffect(() => { if (org) rememberOrg(org.slug); }, [org]);

  const rows = projects.data?.projects ?? [];
  const live = rows.filter((p) => !p.deleted_at);
  const recoverable = rows.filter((p) => p.deleted_at);

  return (
    <AppShell orgSlug={slug}>
      <main className="page">
        <div className="page__inner">
          <div className="page__head">
            <div>
              <h1 className="page__title">Projects</h1>
              <p className="page__sub">
                {org ? `${org.name} · you are ${org.role === 'admin' ? 'an' : 'a'} ${org.role}` : ' '}
              </p>
            </div>
            <div className="page__actions">
              {/* One primary action per view (§5 rule 1). */}
              <Link className="cb-btn" href={`/org/${slug}/new`}>New project</Link>
            </div>
          </div>

          {orgError ? <ErrorSurface error={orgError} /> : null}
          {!orgLoading && !org && !orgError ? (
            <div className="cb-empty">
              <div className="cb-empty__title">No such organization</div>
              <div className="cb-empty__text">
                Either it does not exist or you are not a member of it. The API does not
                distinguish the two, and neither does this page.
              </div>
            </div>
          ) : null}

          {projects.error ? (
            <ErrorSurface error={projects.error} onRetry={() => void projects.refetch()} />
          ) : null}

          {projects.isLoading ? (
            <div className="grid-projects" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div className="cb-card" key={i}>
                  <div className="cb-skeleton" style={{ width: '60%', height: 20 }} />
                  <div className="cb-skeleton" style={{ width: '40%', height: 14, marginTop: 8 }} />
                  <div className="cb-skeleton" style={{ width: 90, height: 22, marginTop: 12 }} />
                </div>
              ))}
            </div>
          ) : null}

          {!projects.isLoading && live.length === 0 && !projects.error ? (
            <div className="cb-empty">
              <div className="cb-empty__icon" aria-hidden="true">+</div>
              <div className="cb-empty__title">No projects yet</div>
              <div className="cb-empty__text">Create your first project to get started.</div>
              <Link className="cb-btn" href={`/org/${slug}/new`}>New project</Link>
            </div>
          ) : null}

          {live.length > 0 ? (
            <div className="grid-projects">
              {live.map((p) => <ProjectCard key={p.id} project={p} />)}
            </div>
          ) : null}

          {recoverable.length > 0 ? (
            <section style={{ marginTop: 'var(--cb-space-8)' }}>
              <h2 className="panel__title">Recently deleted</h2>
              <p className="page__sub" style={{ marginBottom: 'var(--cb-space-4)' }}>
                Deleted projects keep their data until the deadline shown. After that
                they are destroyed and cannot be recovered.
              </p>
              <div className="grid-projects">
                {recoverable.map((p) => <ProjectCard key={p.id} project={p} />)}
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const dead = Boolean(project.deleted_at);
  const failed = project.status === 'failed';
  const cls = ['cb-card', failed ? 'cb-card--error' : '', dead ? 'cb-card--muted' : '']
    .filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <div className="cb-card__title">{project.name}</div>
      <div className="cb-card__ref">{project.ref}</div>
      <ProjectStateBadge status={project.status} />
      <div className="cb-card__meta">{project.region} · {project.plan}</div>
      <div className="cb-card__footer">
        {dead ? (
          <span className="muted">
            Recoverable until{' '}
            {project.restorable_until
              ? new Date(project.restorable_until).toLocaleDateString()
              : 'unknown'}
          </span>
        ) : (
          <span className="muted">
            Created {new Date(project.created_at).toLocaleDateString()}
          </span>
        )}
        {dead ? null : (
          <Link className="cb-card__link" href={`/project/${project.ref}`}>Open</Link>
        )}
      </div>
    </div>
  );
}
