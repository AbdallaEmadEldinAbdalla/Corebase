'use client';

import { use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useIntrospection } from '../../../../lib/queries.ts';
import { TableOps } from '../../../../components/TableOps.tsx';

/**
 * `/table-editor` with no table chosen.
 *
 * A real state rather than a redirect to the first table. Redirecting would make
 * the URL lie about what the user asked for, and it would pick a table for them —
 * on a project whose first schema is `auth`, that means opening the platform's
 * user table as if it were theirs.
 *
 * It is also where **creating** a table lives, for two reasons. The subject of a
 * create is the schema rather than any table, so this is the only page whose
 * subject it is; and the IA's onboarding checklist says step one "opens table
 * editor's create-table dialog", which needs the dialog to be reachable by URL
 * rather than only by clicking something. `?new=table` is that URL, which also
 * satisfies §1's "every view a user can reach is a URL they can send".
 */
export default function TableEditorIndex(
  { params }: { params: Promise<{ ref: string }> },
) {
  const { ref } = use(params);
  const search = useSearchParams();
  const router = useRouter();
  const intro = useIntrospection(ref);
  const [creating, setCreating] = useState(false);

  /**
   * The query parameter opens the dialog, and is then removed.
   *
   * Removed with `replace`, so closing the dialog does not leave a URL that
   * re-opens it on the next refresh — and so the back button goes back to where
   * the user came from rather than to this page with the dialog up again.
   */
  useEffect(() => {
    if (search.get('new') === 'table') {
      setCreating(true);
      router.replace(`/project/${ref}/table-editor`);
    }
  }, [search, router, ref]);

  /**
   * Where a new table goes.
   *
   * `public` unless the project does not have one — which is unusual and
   * possible, since a customer can drop it. Guessing the first schema they own
   * would be worse than asking, but asking on every create for the 99% case is
   * worse still, so the dialog's own help text names the schema it will use and
   * the SQL below it says so too.
   */
  const schemas = intro.data?.schemas ?? [];
  const target = schemas.includes('public') ? 'public' : (schemas[0] ?? 'public');

  return (
    <>
      <div className="emptywrap">
        <div className="sh-empty">
          <div className="sh-empty__title">
            {intro.data && intro.data.tables.length === 0
              ? 'No tables yet' : 'Pick a table'}
          </div>
          <div className="sh-empty__text">
            {intro.data && intro.data.tables.length === 0
              ? 'A new table gets an id, a created_at and Row Level Security '
                + 'enabled — and you will see the SQL for all of it before it runs.'
              : 'Its rows, its columns and its row-level security policies are on '
                + 'one page.'}
          </div>
          {/* An empty state carries the action that fixes it (§6). This one is
              the page's single primary action either way: with tables it is the
              only action here at all. */}
          <button type="button" className="sh-btn" style={{ marginTop: 'var(--sh-space-16)' }}
                  onClick={() => setCreating(true)}>
            New table
          </button>
        </div>
      </div>

      {creating ? (
        <TableOps key="create" projectRef={ref} op={{ kind: 'create_table' }}
                  schema={target} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
