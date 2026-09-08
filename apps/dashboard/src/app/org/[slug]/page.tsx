'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { ProjectStateBadge } from '../../../components/ProjectState.tsx';
import { Menu, MenuItem } from '../../../components/Menu.tsx';
import { useOrgBySlug, useProjects } from '../../../lib/queries.ts';
import { copyText } from '../../../lib/copy.ts';
import { useToast } from '../../../components/Toasts.tsx';
import { api, type Project } from '../../../lib/api.ts';

/**
 * The projects list.
 *
 * **A table by default** (§4, and the design system's own "dense by default: 52px
 * rows"). The first version of this page used large cards, which is how three
 * projects filled a screen that should hold twenty — and cards make the one thing
 * people actually do here, comparing state across projects, into a scan of separate
 * boxes. Cards remain available because identity matters too, and the choice is
 * remembered per browser rather than reset on every visit.
 *
 * Row actions live in a menu that opens on click and on keyboard, not on hover
 * alone (§2). Copying a connection string does not require opening the project,
 * because that is the most common reason to come here at all.
 */
type View = 'table' | 'cards';
const VIEW_KEY = 'cb.projectsView';

/** "an owner", "an admin", "a member". Testing the word beats listing exceptions. */
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

export default function ProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { org, isLoading: orgLoading, error: orgError } = useOrgBySlug(slug);
  const projects = useProjects(org?.id);
  const [view, setView] = useState<View>('table');

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'cards' || v === 'table') setView(v);
    } catch { /* private mode */ }
  }, []);

  const choose = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };

  const rows = projects.projects;
  const live = rows.filter((p) => !p.deleted_at);
  const recoverable = rows.filter((p) => p.deleted_at);

  return (
    <div className="wrap">
      <div className="head">
        <div>
          <h1 className="head__title">Projects</h1>
          <p className="head__sub">
            {org
              ? `${live.length} ${live.length === 1 ? 'project' : 'projects'} in ${org.name} · you are ${article(org.role)} ${org.role}`
              : ' '}
          </p>
        </div>
        <div className="head__actions">
          {/* Only when there is something to switch between. With an empty list both
              views render the same empty state, so the control was inert while
              looking active — which reads as a broken button, not as a disabled one. */}
          {live.length > 1 ? (
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={view === 'table'} onClick={() => choose('table')}>Table</button>
              <button type="button" aria-pressed={view === 'cards'} onClick={() => choose('cards')}>Cards</button>
            </div>
          ) : null}
          <Link className="sh-btn" href={`/org/${slug}/new`}>New project</Link>
        </div>
      </div>

      {orgError ? <ErrorSurface error={orgError} /> : null}
      {!orgLoading && !org && !orgError ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">No such organization</div>
          <div className="sh-empty__text">
            Either it does not exist or you are not a member. The API does not distinguish
            the two, and neither does this page.
          </div>
        </div></div>
      ) : null}

      {projects.error ? (
        <ErrorSurface error={projects.error} onRetry={() => void projects.refetch()} />
      ) : null}

      {projects.isLoading ? <ListSkeleton view={view} /> : null}

      {!projects.isLoading && !projects.error && live.length === 0 && org ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__icon" aria-hidden="true">+</div>
          <div className="sh-empty__title">No projects yet</div>
          <div className="sh-empty__text">
            A project is a PostgreSQL database with its own credentials and API keys.
            It takes a few seconds to create.
          </div>
          <Link className="sh-btn" href={`/org/${slug}/new`}>New project</Link>
        </div></div>
      ) : null}

      {live.length > 0 ? (
        view === 'table'
          ? <ProjectTable projects={live}
                          hasMore={projects.hasNextPage}
                          loadingMore={projects.isFetchingNextPage}
                          onLoadMore={() => void projects.fetchNextPage()} />
          : (
            <>
              <div className="cards">{live.map((p) => <ProjectCard key={p.id} project={p} />)}</div>
              {projects.hasNextPage ? (
                <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--sh-space-4)' }}>
                  <button type="button" className="sh-btn sh-btn--secondary"
                          disabled={projects.isFetchingNextPage}
                          onClick={() => void projects.fetchNextPage()}>
                    {projects.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              ) : null}
            </>
          )
      ) : null}

      {recoverable.length > 0 ? (
        <section className="section" style={{ marginTop: 'var(--sh-space-8)' }}>
          <div className="section__head">
            <h2 className="section__title">Recently deleted</h2>
            <p className="section__note">
              Data is kept until the deadline shown, then destroyed permanently.
            </p>
          </div>
          <ProjectTable projects={recoverable} deleted />
        </section>
      ) : null}
    </div>
  );
}

function ProjectTable({ projects, deleted, hasMore, loadingMore, onLoadMore }: {
  projects: Project[];
  deleted?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const router = useRouter();
  return (
    <div className="tablewrap">
      <table className="sh-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Ref</th>
            <th scope="col">Status</th>
            <th scope="col">Region</th>
            <th scope="col">{deleted ? 'Recoverable until' : 'Created'}</th>
            <th scope="col"><span className="sh-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}
                onClick={() => { if (!deleted) router.push(`/project/${p.ref}`); }}>
              <td className="sh-table__name">
                {deleted ? p.name : (
                  // A real link, so the row is keyboard-reachable and
                  // middle-click/⌘-click open a new tab like anywhere else.
                  <Link href={`/project/${p.ref}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}>{p.name}</Link>
                )}
              </td>
              <td className="sh-mono">{p.ref}</td>
              <td><ProjectStateBadge status={p.status} /></td>
              <td>{p.region}</td>
              <td>
                {deleted
                  ? (p.restorable_until ? new Date(p.restorable_until).toLocaleDateString() : '—')
                  : new Date(p.created_at).toLocaleDateString()}
              </td>
              <td className="td-actions" onClick={(e) => e.stopPropagation()}>
                <RowActions project={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tablecount">
        {/* Never truncate silently (§4). The count says what is on screen, and it
            only claims to be everything when there is no next page — the first
            version said "Showing 20 of 20" for an organization with 25 projects,
            which is the lie this rule exists to prevent. */}
        <span>
          {hasMore
            ? `Showing the first ${projects.length}`
            : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`}
        </span>
        {hasMore ? (
          <button type="button" className="sh-btn sh-btn--secondary sh-btn--sm"
                  disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RowActions({ project }: { project: Project }) {
  const router = useRouter();
  const toast = useToast();
  const dead = Boolean(project.deleted_at);

  const copyConnection = async () => {
    // Fetched on demand rather than with the list: the list endpoint does not carry
    // connection strings, and asking for every project's credentials to populate a
    // menu nobody opened would be the wrong trade.
    try {
      const detail = await api.project(project.ref);
      const cs = detail.database?.connection_strings?.direct;
      if (!cs) {
        toast.show({ tone: 'error', title: 'No connection string yet',
                     detail: 'It appears once the database is running.' });
        return;
      }
      const ok = await copyText(cs);
      if (ok) toast.copied('Connection string');
    } catch {
      toast.show({ tone: 'error', title: 'Could not read the connection string',
                   detail: 'Open the project to see why.' });
    }
  };

  return (
    <Menu label={`Actions for ${project.name}`} align="right"
          trigger={({ open, toggle, ref }) => (
            <button ref={ref} type="button" className="rowbtn"
                    aria-haspopup="menu" aria-expanded={open} onClick={toggle}
                    aria-label={`Actions for ${project.name}`}>⋯</button>
          )}>
      {(close) => (
        <>
          {dead ? (
            <MenuItem onSelect={close}>
              Nothing to do — restore is not built yet
            </MenuItem>
          ) : (
            <>
              <MenuItem onSelect={() => { router.push(`/project/${project.ref}`); close(); }}>
                Open project
              </MenuItem>
              <MenuItem onSelect={() => { void copyConnection(); close(); }}>
                Copy connection string
              </MenuItem>
              <MenuItem onSelect={async () => {
                const ok = await copyText(project.ref);
                if (ok) toast.copied('Project ref');
                close();
              }}>
                Copy ref
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const failed = project.status === 'failed';
  return (
    <div className={`sh-card${failed ? ' sh-card--error' : ''}`}>
      <div className="sh-card__title">{project.name}</div>
      <div className="sh-card__ref">{project.ref}</div>
      <ProjectStateBadge status={project.status} />
      <div className="sh-card__meta">{project.region} · {project.plan}</div>
      <div className="sh-card__footer">
        <span style={{ color: 'var(--sh-text-muted)' }}>
          {new Date(project.created_at).toLocaleDateString()}
        </span>
        <Link className="sh-card__link" href={`/project/${project.ref}`}>Open</Link>
      </div>
    </div>
  );
}

/**
 * A skeleton in the shape of the content it replaces — the design system says it in
 * those words, and it is why this has two forms. A generic stack of bars in front of
 * a table means the layout jumps into place when data arrives, which costs the user
 * the same attention as a page load.
 */
function ListSkeleton({ view }: { view: View }) {
  if (view === 'cards') {
    return (
      <div className="cards" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div className="sh-card" key={i}>
            <div className="sh-skeleton" style={{ width: '58%', height: 20 }} />
            <div className="sh-skeleton" style={{ width: '42%', height: 13, marginTop: 8 }} />
            <div className="sh-skeleton" style={{ width: 86, height: 22, marginTop: 12, borderRadius: 999 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="tablewrap" aria-busy="true">
      <table className="sh-table">
        <thead>
          <tr>
            <th>Project</th><th>Ref</th><th>Status</th><th>Region</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3].map((i) => (
            <tr key={i}>
              <td><div className="sh-skeleton" style={{ width: 110, height: 14 }} /></td>
              <td><div className="sh-skeleton" style={{ width: 150, height: 12 }} /></td>
              <td><div className="sh-skeleton" style={{ width: 78, height: 22, borderRadius: 999 }} /></td>
              <td><div className="sh-skeleton" style={{ width: 70, height: 14 }} /></td>
              <td><div className="sh-skeleton" style={{ width: 80, height: 14 }} /></td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
