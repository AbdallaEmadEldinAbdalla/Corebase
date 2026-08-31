'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMe, useOrgs } from '../lib/queries.ts';
import { api, clearCsrfToken } from '../lib/api.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

/**
 * The chrome every signed-in page sits inside: brand, org switcher, user, theme.
 *
 * The switcher is hand-written rather than pulled from a component library, and
 * the keyboard behaviour is the reason it is worth the lines: Escape closes and
 * returns focus to the trigger, arrow keys move through the list, and a click
 * outside dismisses. A dropdown that can only be opened with a mouse fails the
 * accessibility floor (design system §7) no matter how it looks.
 */
export function OrgSwitcher({ currentSlug }: { currentSlug?: string }) {
  const { data } = useOrgs();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const orgs = data?.orgs ?? [];
  const current = orgs.find((o) => o.slug === currentSlug) ?? orgs[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!current) return null;

  return (
    <div className="switcher-wrap" ref={wrap}>
      <button ref={trigger} type="button" className="cb-switcher"
              aria-haspopup="menu" aria-expanded={open}
              onClick={() => setOpen((v) => !v)}>
        <span className="cb-switcher__avatar" aria-hidden="true" />
        <div style={{ textAlign: 'left' }}>
          <div className="cb-switcher__name">{current.name}</div>
          <div className="cb-switcher__org">
            {current.role} · {current.project_count} project{current.project_count === 1 ? '' : 's'}
          </div>
        </div>
        <span className="switcher-caret" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="cb-menu" role="menu">
          {orgs.map((o) => (
            <Link key={o.id} role="menuitem" href={`/org/${o.slug}`}
                  className={`cb-menu__item${o.slug === current.slug ? ' is-active' : ''}`}
                  onClick={() => setOpen(false)}>
              <span className="cb-status__dot cb-status__dot--success" aria-hidden="true" />
              {o.name}
            </Link>
          ))}
          {/* No "+ New project" here, even though the board's switcher has one.
              That board is the *project* switcher, which lives inside a project;
              this is the org switcher, and the IA gives it exactly one job —
              swapping [slug]. Creating a project is the projects page's primary
              action, and having it in two places would make neither the obvious
              one. */}
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ children, orgSlug }: { children: ReactNode; orgSlug?: string }) {
  const { data: me } = useMe();
  const router = useRouter();

  const logout = async () => {
    // Clear locally even if the call fails: a client that thinks it is still
    // signed in after the user asked to leave is the worse of the two outcomes.
    try { await api.logout(); } finally {
      clearCsrfToken();
      router.replace('/login');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <Link className="topbar__brand" href="/">
          <span className="topbar__mark" aria-hidden="true" />
          Corebase
        </Link>
        <OrgSwitcher {...(orgSlug ? { currentSlug: orgSlug } : {})} />
        <span className="topbar__spacer" />
        {me?.user ? <span className="topbar__user">{me.user.email}</span> : null}
        <ThemeToggle />
        <button type="button" className="cb-btn cb-btn--ghost cb-btn--sm" onClick={logout}>
          Sign out
        </button>
      </header>
      {children}
    </div>
  );
}
