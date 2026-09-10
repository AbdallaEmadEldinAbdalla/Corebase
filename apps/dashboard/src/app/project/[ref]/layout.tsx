'use client';

import { use, type ReactNode } from 'react';
import { AppShell, NavItem, useSection } from '../../../components/AppShell.tsx';
import { useProject, useOrgs, useMe } from '../../../lib/queries.ts';
import { can } from '@steadhold/types';
import { useAutoResume, ResumeBanner } from '../../../components/PausedProject.tsx';

/**
 * Project chrome: every section here is real, and one of them is conditional.
 *
 * Overview, the table editor, SQL, Auth users, Connect, API keys, Usage and
 * Settings are what the control plane can answer today. The rest of the IA's
 * sidebar — storage, logs, backups — has no endpoints behind it and does not
 * appear until it does (§7's honesty rule, gate question 20).
 *
 * ## Auth users is hidden from a member, not greyed out
 *
 * `authuser.read` is an admin capability (D-478), so a member opening that page
 * gets a 403. Hiding the item is the pattern this codebase already settled: the
 * project settings page hides its danger zone rather than disabling it, and the
 * members page hides the invite form the same way. A disabled item with a
 * tooltip advertises a capability the reader cannot use and puts the wall inside
 * the nav rather than out of sight.
 *
 * `me` is therefore part of what the nav waits on. An absent role and a role
 * without the capability are indistinguishable, so rendering before `/me`
 * arrives would flash the item away — the settings page has the same trap
 * documented on it, where it presented an unresolved request as a verdict (Q18).
 * Here the item simply does not appear until the answer is known, which is one
 * item arriving late rather than one retracted.
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
  const me = useMe();
  const path = useSection();
  const orgSlug = orgs.data?.orgs.find((o) => o.id === project.data?.project.org_id)?.slug;
  const p = project.data?.project;
  const myRole = me.data?.memberships.find((m) => m.org_id === p?.org_id)?.role;
  const mayReadUsers = myRole !== undefined && can(myRole, 'authuser.read');

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
        <NavItem href={`/project/${ref}/sql`} current={path.includes('/sql')} icon="sql">SQL</NavItem>
        {mayReadUsers ? (
          <NavItem href={`/project/${ref}/auth/users`}
                   current={path.includes('/auth')} icon="auth">Auth users</NavItem>
        ) : null}
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
