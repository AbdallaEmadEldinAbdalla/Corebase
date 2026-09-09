'use client';

/**
 * `/table-editor` with no table chosen.
 *
 * A real state rather than a redirect to the first table. Redirecting would make
 * the URL lie about what the user asked for, and it would pick a table for them —
 * on a project whose first schema is `auth`, that means opening the platform's
 * user table as if it were theirs.
 */
export default function TableEditorIndex() {
  return (
    <div className="emptywrap">
      <div className="sh-empty">
        <div className="sh-empty__title">Pick a table</div>
        <div className="sh-empty__text">
          Its rows, its columns and its row-level security policies are on one
          page. Nothing here changes anything yet — creating and altering tables
          is the next step, and until then the SQL editor is the way to do it.
        </div>
      </div>
    </div>
  );
}
