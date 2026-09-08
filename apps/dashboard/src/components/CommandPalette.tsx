'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useOrgs, useProjects, useMe } from '../lib/queries.ts';
import { api, clearCsrfToken, type Project } from '../lib/api.ts';
import { copyText } from '../lib/copy.ts';
import { useToast } from './Toasts.tsx';
import { rememberOrg } from '../lib/last-org.ts';

/**
 * The command palette (D-226).
 *
 * This is the spine of the shell, not a search box bolted on. It is what turns
 * "learn where the button is" into "know what the thing is called", which is the
 * single mechanic that makes a dashboard feel deep rather than wide — and it is the
 * cheapest surface to extend, so new capabilities land here first.
 *
 * Two consequences of that worth naming:
 *
 * - **Every command is a named object with a handler.** That is what makes the same
 *   action expressible in the CLI later, and it is why `Command` is a data shape
 *   rather than a pile of JSX.
 * - **Matching is subsequence, not substring.** `dbcon` finds "Copy database
 *   connection string", because a palette that requires the exact word order is a
 *   palette you have to remember rather than guess at.
 *
 * What it deliberately does not do yet: search *data* beyond the projects already
 * loaded on the client. That needs an endpoint per searchable resource and a
 * debounce contract — OQ-179.
 */

interface Command {
  id: string;
  group: 'Go to' | 'Organization' | 'Project' | 'Actions' | 'Account';
  label: string;
  /** Extra words that should match but need not be shown, e.g. a project ref. */
  keywords?: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/**
 * Subsequence match, scored so that a hit on a word boundary beats a hit in the
 * middle of a word. Returns null for no match, so filtering and ranking are one
 * pass and the caller cannot forget to check.
 */
function score(haystack: string, needle: string): { points: number; hits: number[] } | null {
  if (!needle) return { points: 0, hits: [] };
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const hits: number[] = [];
  let points = 0;
  let at = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, at);
    if (found === -1) return null;
    // A character starting a word is what the user most likely typed.
    const boundary = found === 0 || /[\s./_-]/.test(h[found - 1] ?? '');
    points += boundary ? 3 : 1;
    if (found === at) points += 1;              // consecutive run
    hits.push(found);
    at = found + 1;
  }
  return { points, hits };
}

/**
 * Highlight the matched characters — as *runs*, not per character.
 *
 * The first version wrapped every glyph in its own element, which is how
 * "Greenbull" rendered as "G r e e n b u l l": each character became a separate
 * inline box, so the browser could no longer kern or shape across them. Merging
 * adjacent indices into runs keeps the text a single shaped string except where a
 * highlight genuinely starts or stops.
 */
function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  const runs: { on: boolean; text: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.text += text[i];
    else runs.push({ on, text: text[i]! });
  }
  return (
    <>
      {runs.map((r, i) => (r.on ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </>
  );
}

export function CommandPalette({ open, onClose, orgSlug, projectRef }: {
  open: boolean;
  onClose: () => void;
  orgSlug?: string;
  projectRef?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const orgs = useOrgs();
  const me = useMe();

  const currentOrg = orgs.data?.orgs.find((o) => o.slug === orgSlug) ?? orgs.data?.orgs[0];
  const projects = useProjects(currentOrg?.id);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const project: Project | undefined = projects.projects.find((p) => p.ref === projectRef);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => { router.push(href); onClose(); };
    const list: Command[] = [];

    if (currentOrg) {
      list.push({ id: 'go-projects', group: 'Go to', label: 'Projects',
                  hint: 'g p', run: go(`/org/${currentOrg.slug}`) });
      // Every section in the sidebar is also in here. A page reachable only by
      // clicking is reachable one way, and §2 asks for three.
      list.push({ id: 'go-members', group: 'Go to', label: 'Members',
                  keywords: 'people team invite roles',
                  hint: 'g m', run: go(`/org/${currentOrg.slug}/members`) });
      list.push({ id: 'go-org-settings', group: 'Go to', label: 'Organization settings',
                  keywords: 'rename slug delete danger zone org',
                  hint: 'g s', run: go(`/org/${currentOrg.slug}/settings`) });
    }
    /**
     * The sidebar toggle. It has a button and a key already; §2 asks for all
     * three, and the palette is where someone looks when they know the name of a
     * thing and not its shortcut.
     */
    list.push({
      id: 'toggle-sidebar', group: 'Actions', label: 'Collapse or expand the sidebar',
      keywords: 'sidebar nav rail collapse expand icons narrow',
      hint: '[', run: () => { window.dispatchEvent(new Event('sh:sidebar')); onClose(); },
    });

    if (projectRef) {
      list.push(
        { id: 'go-overview', group: 'Go to', label: 'Project overview',
          hint: 'g o', run: go(`/project/${projectRef}`) },
        { id: 'go-connect', group: 'Go to', label: 'Connect',
          keywords: 'connection string psql uri database url',
          hint: 'g c', run: go(`/project/${projectRef}/connect`) },
        { id: 'go-keys', group: 'Go to', label: 'API keys',
          keywords: 'anon service role jwt jwks',
          hint: 'g k', run: go(`/project/${projectRef}/keys`) },
        { id: 'go-usage', group: 'Go to', label: 'Usage',
          keywords: 'disk size bytes quota backups wal archiving activity memory',
          hint: 'g u', run: go(`/project/${projectRef}/usage`) },
        { id: 'go-settings', group: 'Go to', label: 'Project settings',
          keywords: 'pause stop delete danger zone rename environment',
          hint: 'g s', run: go(`/project/${projectRef}/settings`) },
      );
    }

    for (const o of orgs.data?.orgs ?? []) {
      list.push({
        id: `org-${o.id}`, group: 'Organization',
        label: `Switch to ${o.name}`, keywords: o.slug,
        run: () => { rememberOrg(o.slug); router.push(`/org/${o.slug}`); onClose(); },
      });
    }

    for (const p of projects.projects.filter((x) => !x.deleted_at)) {
      list.push({
        id: `prj-${p.id}`, group: 'Project',
        label: `Open ${p.name}`, keywords: `${p.ref} ${p.status}`,
        run: go(`/project/${p.ref}`),
      });
    }

    if (currentOrg) {
      list.push({ id: 'new-project', group: 'Actions', label: 'Create a new project',
                  keywords: 'add database', run: go(`/org/${currentOrg.slug}/new`) });
    }
    // Every capability a menu exposes is also here (D-226).
    list.push({ id: 'new-org', group: 'Actions', label: 'Create a new organization',
                keywords: 'add team workspace', run: go('/new-org') });

    // D-226: every capability a menu exposes is also here. The projects table's row
    // menu offers these two, and the first version of this palette did not — which
    // made the palette an incomplete copy of the menus rather than the other way
    // round, and that is how a palette decays into a search box that finds three
    // things.
    //
    // The value is fetched when the command runs, not when the list is built: the
    // list endpoint carries no credentials, and pulling every project's connection
    // string to populate commands nobody invoked would be the wrong trade.
    if (project) {
      list.push(
        { id: 'copy-conn', group: 'Actions',
          label: `Copy connection string · ${project.name}`,
          keywords: 'database url postgres uri psql dsn',
          run: async () => {
            onClose();
            try {
              const detail = await api.project(project.ref);
              const cs = detail.database?.connection_strings?.direct;
              if (!cs) {
                toast.show({ tone: 'error', title: 'No connection string yet',
                             detail: 'It appears once the database is running.' });
                return;
              }
              if (await copyText(cs)) toast.copied('Connection string');
            } catch {
              toast.show({ tone: 'error', title: 'Could not read the connection string',
                           detail: `Open ${project.name} to see why.` });
            }
          } },
        { id: 'copy-ref', group: 'Actions',
          label: `Copy project ref · ${project.name}`,
          keywords: 'identifier id',
          run: async () => {
            onClose();
            if (await copyText(project.ref)) toast.copied('Project ref');
          } },
      );
    }

    list.push(
      { id: 'theme', group: 'Actions', label: 'Toggle theme',
        keywords: 'dark light appearance',
        run: () => {
          const root = document.documentElement;
          const isDark = root.getAttribute('data-theme') === 'dark'
            || (!root.getAttribute('data-theme')
                && window.matchMedia('(prefers-color-scheme: dark)').matches);
          const next = isDark ? 'light' : 'dark';
          root.setAttribute('data-theme', next);
          try { localStorage.setItem('sh-theme', next); } catch { /* private mode */ }
          onClose();
        } },
      { id: 'shortcuts', group: 'Actions', label: 'Keyboard shortcuts',
        hint: '?', run: () => { onClose(); window.dispatchEvent(new Event('sh:shortcuts')); } },
    );

    if (me.data?.user) {
      list.push(
        { id: 'copy-email', group: 'Account', label: `Copy ${me.data.user.email}`,
          keywords: 'email account',
          run: async () => {
            const ok = await copyText(me.data!.user!.email);
            if (ok) toast.copied('Email');
            onClose();
          } },
        { id: 'signout', group: 'Account', label: 'Sign out',
          run: async () => {
            try { await api.logout(); } finally {
              clearCsrfToken();
              onClose();
              router.replace('/login');
            }
          } },
      );
    }
    return list;
  }, [currentOrg, orgs.data, projects.projects, projectRef, project, me.data, router, onClose, toast]);

  const matches = useMemo(() => {
    return commands
      .map((c) => {
        const primary = score(c.label, query);
        // Keywords match but are not highlighted — highlighting text that is not
        // on screen is the sort of detail that makes a palette feel broken.
        const alt = primary ? null : score(`${c.label} ${c.keywords ?? ''}`, query);
        const s = primary ?? alt;
        return s ? { c, points: s.points, hits: primary ? s.hits : [] } : null;
      })
      .filter((x): x is { c: Command; points: number; hits: number[] } => x !== null)
      .sort((a, b) => b.points - a.points);
  }, [commands, query]);

  // Reset per opening, and remember where focus came from so Escape can put it back.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    input.current?.focus();
  }, [open]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // onClose restores focus to whatever opened this — the shell owns that,
        // because only the shell was on the stack before the layer existed.
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault();
        setCursor((c) => (matches.length ? (c + 1) % matches.length : 0));
      }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault();
        setCursor((c) => (matches.length ? (c - 1 + matches.length) % matches.length : 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void matches[cursor]?.c.run();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, matches, cursor, onClose]);

  // Keep the keyboard cursor in view; a selection you cannot see is not a selection.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches]);

  if (!open) return null;

  let lastGroup = '';
  return (
    <div className="layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input ref={input} className="palette__input" value={query} spellCheck={false} autoFocus
               placeholder="Search projects, jump to a page, run a command…"
               aria-label="Command palette"
               aria-activedescendant={matches[cursor] ? `cmd-${matches[cursor].c.id}` : undefined}
               onChange={(e) => setQuery(e.target.value)} />
        <div className="palette__list" ref={listRef} role="listbox">
          {matches.length === 0 ? (
            <div className="palette__empty">
              Nothing matches “{query}”.
            </div>
          ) : matches.map(({ c, hits }, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header ? <div className="palette__group">{header}</div> : null}
                <button type="button" id={`cmd-${c.id}`} role="option"
                        aria-selected={i === cursor}
                        className="palette__item" data-active={i === cursor}
                        onMouseMove={() => setCursor(i)}
                        onClick={() => void c.run()}>
                  <Highlight text={c.label} hits={hits} />
                  {c.hint ? <span className="palette__hint">{c.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette__foot">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">↵</span> run</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
