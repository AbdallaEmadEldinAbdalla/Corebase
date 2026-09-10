/**
 * The auth section's workspace: one full-height pane.
 *
 * A layout rather than the page claiming the height itself, for the reason the
 * table editor's layout gives — and one this section will need sooner than that
 * one did. The IA puts four pages under `/auth` (users, providers, templates,
 * settings), and every one of them is a list or a form that should fill the
 * column rather than float in a 1120px box. Putting `.deck` here means they
 * inherit the shape instead of each remembering it.
 *
 * `.deck--one` rather than `.deck--split`: there is no second pane. The table
 * editor's list column exists because a table is chosen *beside* its rows; the
 * users list has nothing to choose from.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="deck deck--one">{children}</div>;
}
