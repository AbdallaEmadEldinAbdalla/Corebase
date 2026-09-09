'use client';

import { use } from 'react';
import { TableList } from '../../../../components/TableList.tsx';

/**
 * The table editor's own two-pane layout: a table list that stays, and the
 * selected table beside it.
 *
 * A layout rather than a component each page renders, and that is §1's "the
 * chrome never re-renders on navigation within a context" applied one level
 * down. Moving from `posts` to `comments` is a navigation — the IA gives it a URL
 * (`/table-editor/[schema]/[table]`) because §1 also requires that the selection
 * be sendable — but the list is not part of what changed, so it must not
 * re-mount, lose its scroll position, or flash a skeleton.
 *
 * §3 asks for exactly this shape: "the list stays visible behind a detail panel
 * so the user can see where they are and move to the next item without a round
 * trip". The list is the context, the pane is the subject.
 *
 * The list is neither a table nor cards, which is the question §4 does not
 * answer: its dichotomy is about *content* lists, and this is a selector. A
 * grouped sidebar list is what the IA's route map implies and what makes "which
 * table am I on" answerable without reading the URL.
 */
export default function TableEditorLayout(
  { children, params }: { children: React.ReactNode; params: Promise<{ ref: string }> },
) {
  const { ref } = use(params);
  return (
    <div className="wrap tablepane">
      <TableList projectRef={ref} />
      <div className="tablepane__main">{children}</div>
    </div>
  );
}
