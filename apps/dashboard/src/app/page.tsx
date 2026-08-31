'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe, useOrgs } from '../lib/queries.ts';
import { lastOrg } from '../lib/last-org.ts';

/**
 * The entry point resolves where "the dashboard" actually is for this account:
 * the last org they visited, else their first, else login. It renders nothing —
 * a landing page that exists only to redirect should not flash content on the
 * way through.
 */
export default function Home() {
  const router = useRouter();
  const me = useMe();
  const orgs = useOrgs();

  useEffect(() => {
    if (me.isLoading || orgs.isLoading) return;
    if (!me.data?.user) { router.replace('/login'); return; }

    const list = orgs.data?.orgs ?? [];
    if (list.length === 0) {
      // A signed-in account with no organization is a real state — an invite
      // that was never accepted, or an org that was deleted. Landing on /login
      // would be a lie, so it gets its own page.
      router.replace('/no-org');
      return;
    }
    const last = lastOrg();
    const target = list.find((o) => o.slug === last) ?? list[0];
    router.replace(`/org/${target!.slug}`);
  }, [me.isLoading, me.data, orgs.isLoading, orgs.data, router]);

  return null;
}
