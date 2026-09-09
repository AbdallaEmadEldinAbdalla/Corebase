'use client';

import { use, type ReactNode } from 'react';
import { AppShell, NavItem, useSection } from '../../../components/AppShell.tsx';
import { useProject, useOrgs } from '../../../lib/queries.ts';
import { useAutoResume, ResumeBanner } from '../../../components/PausedProject.tsx';

/**
 * Project chrome: five sections, all of which are real.
 *
 * Overview, Connect, API keys, Usage and Settings are exactly what the control
 * plane can answer today. The rest of the IA's sidebar — table editor, SQL editor, auth,
 * storage, logs, backups — has no endpoints behind it, and none of it appears here
 * until it works (§7's honesty rule and gate question 20).
 *
 * Settings sits last because that is the IA's order and because it is the only
 * section that is mostly about *stopping* the project rather than using it.
 */
export default function ProjectLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ ref: string }>;
}) {
  const { ref } = use(params);
  const project = useProject(ref);
  const orgs = useOrgs();
  const path = useSection();
  const orgSlug = orgs.data?.orgs.find((o) => o.id === project.data?.project.org_id)?.slug;
  const p = project.data?.project;

  /**
   * D-131: opening any page of a paused project *is* the intent to resume, so it
   * is fired here in the layout rather than on the overview — a user may deep-link
   * straight to Connect or API keys, and those pages are just as blocked by a
   * database that is not running.
   */
  const resume = useAutoResume(ref, p?.status, p?.org_id);

  return (
    <AppShell projectRef={ref} {...(orgSlug ? { orgSlug } : {})} nav={
      <>
        <div className="nav__label">Project</div>
        <NavItem href={`/project/${ref}`} current={path === `/project/${ref}`} icon="overview">Overview</NavItem>
        <NavItem href={`/project/${ref}/table-editor`}
                 current={path.includes('/table-editor')} icon="table-editor">Table editor</NavItem>
        <NavItem href={`/project/${ref}/connect`} current={path.endsWith('/connect')} icon="connect">Connect</NavItem>
        <NavItem href={`/project/${ref}/keys`} current={path.endsWith('/keys')} icon="keys">API keys</NavItem>
        <NavItem href={`/project/${ref}/usage`} current={path.endsWith('/usage')} icon="usage">Usage</NavItem>
        <NavItem href={`/project/${ref}/settings`} current={path.endsWith('/settings')} icon="settings">Settings</NavItem>
        <div className="nav__foot">
          <div className="nav__hint">
            <span>Shortcuts</span><span className="kbd">?</span>
          </div>
        </div>
      </>
    }>
      <div className="bannerslot"><ResumeBanner
        status={p?.status}
        plan={p?.plan}
        error={resume.error}
        standing={resume.standing}
        onResume={() => resume.mutate()}
        onRetry={() => resume.mutate()}
      /></div>
      {children}
    </AppShell>
  );
}
