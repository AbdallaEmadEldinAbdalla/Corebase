'use client';

import { use, type ReactNode } from 'react';
import { AppShell, NavItem, useSection } from '../../../components/AppShell.tsx';
import { useProject, useOrgs } from '../../../lib/queries.ts';

/**
 * Project chrome: three sections, all of which are real.
 *
 * Overview, Connect and API keys are exactly what the control plane can answer
 * today. The IA's full sidebar — table editor, SQL editor, auth, storage, logs,
 * backups, settings — is Phase 2 and beyond, and none of it appears here until it
 * works (§7's honesty rule and gate question 20).
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

  return (
    <AppShell projectRef={ref} {...(orgSlug ? { orgSlug } : {})} nav={
      <>
        <div className="nav__label">Project</div>
        <NavItem href={`/project/${ref}`} current={path === `/project/${ref}`} icon="overview">Overview</NavItem>
        <NavItem href={`/project/${ref}/connect`} current={path.endsWith('/connect')} icon="connect">Connect</NavItem>
        <NavItem href={`/project/${ref}/keys`} current={path.endsWith('/keys')} icon="keys">API keys</NavItem>
        <div className="nav__foot">
          <div className="nav__hint">
            <span>Shortcuts</span><span className="kbd">?</span>
          </div>
        </div>
      </>
    }>
      {children}
    </AppShell>
  );
}
