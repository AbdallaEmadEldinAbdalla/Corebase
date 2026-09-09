'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useIntrospection } from '../lib/queries.ts';
import { ErrorSurface } from './ErrorSurface.tsx';
import type { IntrospectionTable } from '../lib/api.ts';

/**
 * The table editor's selector: every table and view, grouped by schema.
 *
 * Grouped rather than flat, and the grouping is not decoration. A project has
 * three schemas that mean different things — `public` is the customer's,
 * `storage` and `auth` are the platform's — and a flat alphabetical list puts
 * `auth.users` above `public.posts`, which makes the platform's tables look like
 * the customer's. `public` therefore comes first, always, whatever it sorts as.
 */

/** `public` first, then the rest alphabetically. */
function bySchema(tables: IntrospectionTable[]): [string, IntrospectionTable[]][] {
  const groups = new Map<string, IntrospectionTable[]>();
  for (const t of tables) {
    const list = groups.get(t.schema);
    if (list) list.push(t); else groups.set(t.schema, [t]);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b));
}

/**
 * Rows an extension put in `public`, which are not the customer's tables.
 *
 * `pg_stat_statements` and its `_info` companion are views the extension creates
 * in `public`, owned by `postgres`. They are genuinely there — hiding them would
 * be a lie about the schema — but they are noise at the top of a list whose
 * first job is "find my table", so they sort to the bottom of their group and
 * say who owns them.
 */
const isPlatformOwned = (t: IntrospectionTable) => t.owner !== 'developer';

export function TableList({ projectRef }: { projectRef: string }) {
  const q = useIntrospection(projectRef);
  const path = usePathname();

  if (q.isPending) {
    return (
      <nav className="tablelist" aria-label="Tables" aria-busy="true">
        <div className="tablelist__group">Tables</div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="tablelist__row" key={i}>
            <div className="sh-skeleton" style={{ width: `${45 + (i % 3) * 18}%`, height: 14 }} />
          </div>
        ))}
      </nav>
    );
  }

  if (q.error) {
    return (
      <nav className="tablelist" aria-label="Tables">
        <ErrorSurface error={q.error} onRetry={() => void q.refetch()}
          title="Could not read the schema" />
      </nav>
    );
  }

  const tables = q.data?.tables ?? [];
  const groups = bySchema(tables);

  if (tables.length === 0) {
    return (
      <nav className="tablelist" aria-label="Tables">
        <div className="tablelist__group">Tables</div>
        <p className="tablelist__empty">
          This database has no tables yet. Creating one is the SQL editor&rsquo;s
          job until the table editor can do it.
        </p>
      </nav>
    );
  }

  return (
    <nav className="tablelist" aria-label="Tables">
      {groups.map(([schema, rows]) => (
        <div key={schema}>
          <div className="tablelist__group">{schema}</div>
          {[...rows].sort((a, b) =>
            Number(isPlatformOwned(a)) - Number(isPlatformOwned(b))
            || a.name.localeCompare(b.name)).map((t) => {
            const href = `/project/${projectRef}/table-editor/`
              + `${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`;
            const current = decodeURIComponent(path) === decodeURIComponent(href);
            return (
              <Link key={t.name} href={href} className="tablelist__row"
                    aria-current={current ? 'page' : undefined}>
                <span className="tablelist__name">{t.name}</span>
                {/* Only the states that change what you can do with the row. A
                    badge on every table would be noise; a view cannot be edited
                    and a platform-owned table is not yours, and both of those
                    are answers to "why can I not change this". */}
                {t.kind !== 'table' ? (
                  <span className="tablelist__tag">{t.kind === 'view' ? 'view' : t.kind}</span>
                ) : isPlatformOwned(t) ? (
                  <span className="tablelist__tag" title={`owned by ${t.owner}`}>
                    {t.owner}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
      {q.data?.truncated.tables ? (
        // §4: never truncate silently. The server caps this list, and a list that
        // stops without saying so is the version of that failure nobody notices.
        <p className="tablelist__empty">
          Only the first tables are listed — this database has more than the
          schema payload carries.
        </p>
      ) : null}
    </nav>
  );
}
