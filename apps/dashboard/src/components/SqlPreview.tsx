'use client';

import { highlight } from '../lib/sql-highlight.ts';

/**
 * SQL, coloured, read-only, verbatim.
 *
 * `.tok-key`, `.tok-str` and `.tok-com` have been in `shell.css` since the code
 * block was built and nothing in the dashboard had ever emitted one of them —
 * three rules matching nothing, which is a claim the product made and did not
 * keep. This is the component that keeps it.
 *
 * The spans come back as data rather than HTML, so there is no
 * `dangerouslySetInnerHTML` anywhere near a string the user typed and which is
 * about to be executed.
 */
export function SqlPreview({ sql, label }: { sql: string; label?: string }) {
  const spans = highlight(sql);
  return (
    <div className="sh-code codeblock sqlprev">
      {label ? <div className="sh-code__header">
        <span className="sh-code__lang">{label}</span>
      </div> : null}
      {/* `<pre>` and not a wrapped div: the statement's line breaks are part of
          the statement, and the preview's whole job is to be the thing that
          runs. `tabIndex={0}` so a keyboard user can scroll a long statement —
          a scroll container that cannot be focused is unreachable without a
          mouse, which is gate question 5. */}
      <pre tabIndex={0} aria-label={label ?? 'The SQL that will run'}>
        {spans.map((s, i) => (
          s.cls === 'plain'
            ? <span key={i}>{s.text}</span>
            : <span key={i} className={`tok-${s.cls}`}>{s.text}</span>
        ))}
      </pre>
    </div>
  );
}
