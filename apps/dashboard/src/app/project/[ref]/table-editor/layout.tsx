'use client';

import { use } from 'react';
import { TableList } from '../../../../components/TableList.tsx';

/**
 * The table editor's workspace: a table list that stays, and the grid beside it.
 *
 * A layout rather than a component each page renders, and that is §1's "the
 * chrome never re-renders on navigation within a context" applied one level
 * down. Moving from `posts` to `comments` is a navigation — the IA gives it a URL
 * because §1 requires the selection be sendable — but the list is not what
 * changed, so it must not re-mount, lose its scroll position, or flash a
 * skeleton.
 *
 * ## Full-bleed, not a centred column
 *
 * `.deck` rather than `.wrap`, and the difference is the whole shape of the
 * page. `.wrap` caps at 1120px with 24px gutters, which put a twelve-column
 * table in a horizontal scroll while a third of a laptop screen sat empty beside
 * it. The reference — Supabase's table editor, which the UX standard names — has
 * the grid *be* the page: it fills the viewport, a toolbar sits above and a
 * footer below, and the rows are the only thing that scrolls.
 *
 * That is also why the height is owned here. A grid whose scroll container is a
 * block in a scrolling document cannot pin a footer; one whose container is a
 * row of a `grid-template-rows: auto minmax(0,1fr) auto` can.
 */
export default function TableEditorLayout(
  { children, params }: { children: React.ReactNode; params: Promise<{ ref: string }> },
) {
  const { ref } = use(params);
  return (
    <div className="deck deck--split">
      <div className="deck__list">
        <TableList projectRef={ref} />
      </div>
      {children}
    </div>
  );
}
