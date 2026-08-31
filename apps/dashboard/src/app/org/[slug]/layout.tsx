'use client';

import { use, useEffect, type ReactNode } from 'react';
import { AppShell, NavItem, useSection } from '../../../components/AppShell.tsx';
import { useOrgBySlug } from '../../../lib/queries.ts';
import { rememberOrg } from '../../../lib/last-org.ts';

/**
 * Org chrome. A layout and not a per-page wrapper so the sidebar and breadcrumb
 * survive navigation between org pages (UX standard §1).
 *
 * The sidebar holds **Projects only**, because that is the only org-level page that
 * exists. Members, billing, settings and the audit viewer are all planned and none
 * are built, and a greyed-out nav item for an unbuilt feature is a promise the
 * product has not made (§7, and the IA's own no-teaser rule).
 */
export default function OrgLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { org } = useOrgBySlug(slug);
  const path = useSection();

  useEffect(() => { if (org) rememberOrg(org.slug); }, [org]);

  return (
    <AppShell orgSlug={slug} nav={
      <>
        <div className="nav__label">{org?.name ?? 'Organization'}</div>
        <NavItem href={`/org/${slug}`} current={path === `/org/${slug}`} icon="projects">Projects</NavItem>
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
