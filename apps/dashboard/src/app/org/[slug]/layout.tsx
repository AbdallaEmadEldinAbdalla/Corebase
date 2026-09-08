'use client';

import { use, useEffect, type ReactNode } from 'react';
import { AppShell, NavItem, useSection } from '../../../components/AppShell.tsx';
import { useOrgBySlug } from '../../../lib/queries.ts';
import { rememberOrg } from '../../../lib/last-org.ts';

/**
 * Org chrome. A layout and not a per-page wrapper so the sidebar and breadcrumb
 * survive navigation between org pages (UX standard §1).
 *
 * The sidebar lists **only pages that exist** — Projects and Members. Billing,
 * settings and the audit viewer are planned and unbuilt, and a greyed-out nav item
 * for an unbuilt feature is a promise the product has not made (§7, and the IA's
 * own no-teaser rule), so they are absent rather than disabled. The nav grows as
 * pages land; gate question 20 is the reason it is written this way round.
 *
 * Members is shown to every role, including a plain member: `member.read` is a
 * member capability, so "who else is in this org" is a question they may ask. What
 * the page *offers* them is narrower, and that is the page's business (D-428).
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
        <NavItem href={`/org/${slug}/members`} current={path.endsWith('/members')} icon="members">Members</NavItem>
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
