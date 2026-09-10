/**
 * The SQL editor's workspace: one full-height pane.
 *
 * The page was a `.wrap` — a 1120px centred column with a heading and a
 * paragraph — which made it the odd one out beside the table editor and wasted
 * the width the results actually need. The reference puts the editor and its
 * output in the whole viewport with the panes splitting it, and that is the
 * shape the user asked for three times.
 *
 * `.deck--one` because the left panel the reference also has is *saved queries*,
 * and those need `GET/POST /v1/projects/:ref/queries`, which does not exist. An
 * empty column reserved for it would be a promise; the gap is recorded in
 * STATUS §8 instead.
 */
export default function SqlLayout({ children }: { children: React.ReactNode }) {
  return <div className="deck deck--one">{children}</div>;
}
