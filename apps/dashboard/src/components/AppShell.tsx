'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useMe, useOrgs, useProjects } from '../lib/queries.ts';
import { rememberOrg } from '../lib/last-org.ts';
import { useHotkeys, useMetaLabel } from '../lib/hotkeys.ts';
import { useReturnFocus } from '../lib/return-focus.ts';
import { Menu, MenuItem } from './Menu.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Shortcuts } from './Shortcuts.tsx';
import { ProjectStateBadge } from './ProjectState.tsx';
import { Logo, OrgAvatar, SectionIcon, type SectionName } from './Logo.tsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSidebar } from '../lib/sidebar.ts';

/**
 * The shell: top bar, breadcrumb switchers, sidebar, palette, shortcut sheet.
 *
 * Its whole job is UX standard §1 — context always visible, always switchable from
 * where you are, and chrome that does not re-render when you navigate inside a
 * context. The last part is why this component is used from route *layouts* rather
 * than from each page: App Router keeps a layout mounted across navigations between
 * its children, so moving from Overview to Connect repaints the content region and
 * nothing else. Calling it per-page would remount the sidebar on every click, which
 * is the flash that makes a dashboard read as a website.
 */
export function AppShell({ children, orgSlug, projectRef, nav }: {
  children: ReactNode;
  orgSlug?: string;
  projectRef?: string;
  /** Sidebar entries. Absent means no sidebar — the auth pages and the entry point. */
  nav?: ReactNode;
}) {
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const router = useRouter();

  // Captured here, at the opening event, rather than inside the layer — see
  // lib/return-focus.ts for why an effect inside the layer is too late.
  const metaLabel = useMetaLabel();
  const sidebar = useSidebar();
  const paletteFocus = useReturnFocus();
  const shortcutFocus = useReturnFocus();

  const openPalette = () => { paletteFocus.capture(); setPalette(true); };
  const closePalette = () => { setPalette(false); paletteFocus.restore(); };
  const openShortcuts = () => { shortcutFocus.capture(); setShortcuts(true); };
  const closeShortcuts = () => { setShortcuts(false); shortcutFocus.restore(); };

  useHotkeys({
    meta: { k: () => (palette ? closePalette() : openPalette()) },
    keys: {
      '?': openShortcuts,
      // `[` collapses and expands the sidebar. A bare key rather than
      // `g`-something, because `g` means "go to" and this goes nowhere.
      '[': sidebar.toggle,
    },
    go: {
      p: () => { if (orgSlug) router.push(`/org/${orgSlug}`); },
      m: () => { if (orgSlug) router.push(`/org/${orgSlug}/members`); },
      o: () => { if (projectRef) router.push(`/project/${projectRef}`); },
      c: () => { if (projectRef) router.push(`/project/${projectRef}/connect`); },
      k: () => { if (projectRef) router.push(`/project/${projectRef}/keys`); },
      u: () => { if (projectRef) router.push(`/project/${projectRef}/usage`); },
      /**
       * `g s` is contextual, the way `g p` and `g m` already are: inside a project
       * it means that project's settings, and outside one it means the org's.
       * Both are "settings" to the person pressing it, and giving the org a second
       * letter would make the shortcut sheet longer to say the same thing.
       */
      s: () => {
        if (projectRef) router.push(`/project/${projectRef}/settings`);
        else if (orgSlug) router.push(`/org/${orgSlug}/settings`);
      },
    },
  });

  // The palette offers "Keyboard shortcuts", and it has to close itself before the
  // sheet opens or two layers stack. An event is the smallest coupling that does
  // not push palette state up into every page.
  useEffect(() => {
    window.addEventListener('sh:shortcuts', openShortcuts);
    return () => window.removeEventListener('sh:shortcuts', openShortcuts);
  });

  // Same coupling as the shortcuts sheet above: the palette cannot call into this
  // component, and an event is smaller than pushing sidebar state up into a
  // provider that only two things would read.
  useEffect(() => {
    window.addEventListener('sh:sidebar', sidebar.toggle);
    return () => window.removeEventListener('sh:sidebar', sidebar.toggle);
  }, [sidebar.toggle]);

  return (
    <div className={`shell${nav ? '' : ' shell--noNav'}${
      nav && sidebar.collapsed ? ' shell--railed' : ''}`}>
      <header className="bar">
        <Link href="/" aria-label="Steadhold home"
              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          <Logo size={22} />
        </Link>
        {/* In the bar rather than in the sidebar, so it stays in the same place
            whether the sidebar is 232px or 56px wide — a control that moves when
            you use it is a control you have to find twice. */}
        <Crumbs {...(orgSlug ? { orgSlug } : {})} {...(projectRef ? { projectRef } : {})} />
        <span className="bar__spacer" />
        <button type="button" className="sh-btn sh-btn--secondary sh-btn--sm"
                onClick={openPalette}
                aria-label="Open command palette">
          Search <span className="kbd" style={{ marginLeft: 6 }}>{metaLabel}</span>
        </button>
        <AccountMenu />
      </header>

      {nav ? (
        <nav id="shell-nav" className="nav" aria-label="Sections">
          {nav}
          {/* In the sidebar's footer, under the section list: the control that
              changes this panel belongs to this panel. It is the last child so it
              sits below the layout's own `.nav__foot`, and it survives the rail —
              a collapse with no way back would be a trap. */}
          <div className="nav__rail">
            {/* A nav row, not a button in a box: it is the same width, height and
                hover as the sections above it, and the rail collapses it to an
                icon by the same rule — `.sh-nav-item__label` is what gets hidden,
                so this needs no rail-specific styling of its own. */}
            <button type="button" className="sh-nav-item navtoggle"
                    onClick={sidebar.toggle}
                    aria-expanded={!sidebar.collapsed} aria-controls="shell-nav"
                    title={`${sidebar.collapsed ? 'Expand' : 'Collapse'} sidebar  [`}>
              {sidebar.collapsed
                ? <PanelLeftOpen size={16} strokeWidth={2} aria-hidden="true" />
                : <PanelLeftClose size={16} strokeWidth={2} aria-hidden="true" />}
              <span className="sh-nav-item__label">
                {sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              </span>
            </button>
          </div>
        </nav>
      ) : null}

      <main className="main">{children}</main>

      <CommandPalette open={palette} onClose={closePalette}
                      {...(orgSlug ? { orgSlug } : {})} {...(projectRef ? { projectRef } : {})} />
      <Shortcuts open={shortcuts} onClose={closeShortcuts} />
    </div>
  );
}

/**
 * `org / project` where both segments are switchers.
 *
 * Switching either one from here is the point: needing to go up to a list page
 * first is a detour the user did not ask for (§1).
 */
function Crumbs({ orgSlug, projectRef }: { orgSlug?: string; projectRef?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const orgs = useOrgs();
  const org = orgs.data?.orgs.find((o) => o.slug === orgSlug);
  const projects = useProjects(org?.id);
  const project = projects.projects.find((p) => p.ref === projectRef);

  return (
    <div className="crumbs">
      <Menu label="Switch organization"
            trigger={({ open, toggle, ref }) => (
              <button ref={ref} type="button" className="crumb"
                      aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                {org ? <OrgAvatar name={org.name} size={18} /> : null}
                <span className="crumb__label">
                  {org?.name ?? (orgs.isLoading ? '…' : 'Organizations')}
                </span>
                <span className="crumb__caret" aria-hidden="true">▾</span>
              </button>
            )}>
        {(close) => (
          <>
            {(orgs.data?.orgs ?? []).map((o) => (
              <MenuItem key={o.id} active={o.slug === orgSlug}
                        onSelect={() => { rememberOrg(o.slug); router.push(`/org/${o.slug}`); close(); }}>
                <OrgAvatar name={o.name} size={18} />
                <span>{o.name}</span>
                <span style={{ marginLeft: 'auto', font: 'var(--sh-caption)', color: 'var(--sh-text-muted)' }}>
                  {o.role}
                </span>
              </MenuItem>
            ))}
            <div className="sh-menu__sep" />
            <MenuItem onSelect={() => { router.push('/new-org'); close(); }}>
              + New organization
            </MenuItem>
          </>
        )}
      </Menu>

      {orgSlug ? (
        <>
          <span className="crumbs__sep" aria-hidden="true">/</span>
          <Menu label="Switch project"
                trigger={({ open, toggle, ref }) => (
                  <button ref={ref} type="button" className="crumb"
                          aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                    <span className="crumb__label">
                      {project?.name ?? (projectRef ? projectRef : orgSection(pathname))}
                    </span>
                    <span className="crumb__caret" aria-hidden="true">▾</span>
                  </button>
                )}>
            {(close) => {
              const live = projects.projects.filter((p) => !p.deleted_at);
              return (
                <>
                  {live.length === 0 ? (
                    <MenuItem onSelect={() => { router.push(`/org/${orgSlug}/new`); close(); }}>
                      No projects yet — create one
                    </MenuItem>
                  ) : live.map((p) => (
                    <MenuItem key={p.id} active={p.ref === projectRef}
                              onSelect={() => { router.push(`/project/${p.ref}`); close(); }}>
                      <span>{p.name}</span>
                      <span style={{ marginLeft: 'auto' }}><ProjectStateBadge status={p.status} compact /></span>
                    </MenuItem>
                  ))}
                  <div className="sh-menu__sep" />
                  <MenuItem onSelect={() => { router.push(`/org/${orgSlug}`); close(); }}>
                    All projects
                  </MenuItem>
                  <MenuItem onSelect={() => { router.push(`/org/${orgSlug}/new`); close(); }}>
                    + New project
                  </MenuItem>
                </>
              );
            }}
          </Menu>
        </>
      ) : null}
    </div>
  );
}

function AccountMenu() {
  const me = useMe();
  const router = useRouter();
  const email = me.data?.user?.email;

  return (
    <Menu label="Account" align="right"
          trigger={({ open, toggle, ref }) => (
            <button ref={ref} type="button" className="crumb"
                    aria-haspopup="menu" aria-expanded={open} onClick={toggle}
                    aria-label={email ? `Account: ${email}` : 'Account'}>
              <OrgAvatar name={email ?? '?'} size={22} />
              <span className="crumb__caret" aria-hidden="true">▾</span>
            </button>
          )}>
      {(close) => (
        <>
          {email ? (
            <div style={{ padding: '8px 12px', font: 'var(--sh-body-s)', color: 'var(--sh-text-secondary)' }}>
              {email}
            </div>
          ) : null}
          <div className="sh-menu__sep" />
          <MenuItem onSelect={() => { close(); window.dispatchEvent(new Event('sh:shortcuts')); }}>
            Keyboard shortcuts <span className="palette__hint">?</span>
          </MenuItem>
          <ThemeItems />
          <div className="sh-menu__sep" />
          <MenuItem tone="danger" onSelect={async () => {
            close();
            const { api, clearCsrfToken } = await import('../lib/api.ts');
            try { await api.logout(); } finally { clearCsrfToken(); router.replace('/login'); }
          }}>
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/**
 * Three explicit choices rather than a two-way toggle. "System" is a real answer
 * (D-178: both themes are peers), and a toggle that cycles through three states
 * makes the user press it twice to find out what it does.
 */
function ThemeItems() {
  const [choice, setChoice] = useState<'light' | 'dark' | 'system'>('system');
  useEffect(() => {
    try {
      const s = localStorage.getItem('sh-theme');
      setChoice(s === 'dark' || s === 'light' ? s : 'system');
    } catch { /* private mode */ }
  }, []);

  const apply = (next: 'light' | 'dark' | 'system') => {
    setChoice(next);
    const root = document.documentElement;
    try {
      if (next === 'system') { localStorage.removeItem('sh-theme'); root.removeAttribute('data-theme'); }
      else { localStorage.setItem('sh-theme', next); root.setAttribute('data-theme', next); }
    } catch { /* private mode: still applies for this page */ }
  };

  return (
    <>
      <div className="palette__group">Theme</div>
      {(['light', 'dark', 'system'] as const).map((t) => (
        <MenuItem key={t} active={choice === t} onSelect={() => apply(t)}>
          <span style={{ textTransform: 'capitalize' }}>{t}</span>
          {choice === t ? <span className="sh-menu__check" aria-hidden="true">✓</span> : null}
        </MenuItem>
      ))}
    </>
  );
}

/** A sidebar entry. `aria-current` is what components.css styles, not a class. */
export function NavItem({ href, children, current, icon }: {
  href: string; children: ReactNode; current: boolean;
  /**
   * Required, and a union rather than a `string`. Every nav row gets a glyph —
   * seven identical shapes in a column is a decoration strip, not a scanning aid —
   * and typing it as `string` is what let `icon="usage"` keep compiling after the
   * `usage` icon had been deleted, so the row rendered a blank square instead.
   */
  icon: SectionName;
}) {
  return (
    <Link className="sh-nav-item" href={href} {...(current ? { 'aria-current': 'page' as const } : {})}>
      <SectionIcon name={icon} />
      {/* An element, not a bare text node. The rail hides the label with CSS, and
          CSS cannot select a text node — the first version left "Project",
          "Member" and "Setting" clipped against a 56px rail. */}
      <span className="sh-nav-item__label">{children}</span>
    </Link>
  );
}

/**
 * The org-level section, for the breadcrumb.
 *
 * The IA specifies the breadcrumb as `org / project / section`, and on an
 * org-level page there is no project — so the slot after the org is the section.
 * It used to read the literal word "Projects" whenever no project ref was set,
 * which meant standing on Members while the breadcrumb said Projects.
 *
 * Derived from the path rather than passed in as a prop, because AppShell is
 * called from the *layout* (so the chrome survives navigation between sections,
 * UX standard §1) and a layout does not re-render per child — it cannot know
 * which of its pages is showing.
 *
 * The control stays the project switcher: jumping into a project from an org page
 * is worth keeping. Only its label was lying.
 */
function orgSection(pathname: string): string {
  if (/\/org\/[^/]+\/members$/.test(pathname)) return 'Members';
  if (/\/org\/[^/]+\/new$/.test(pathname)) return 'New project';
  return 'Projects';
}

/** Reads the active section from the path so a nav does not take a prop per page. */
export function useSection(): string {
  const pathname = usePathname();
  return pathname;
}
