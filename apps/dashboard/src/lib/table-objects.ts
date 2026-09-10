/**
 * Reconciling a table's indexes with its constraints.
 *
 * Pure logic in `lib/` rather than beside the component that renders it, and for
 * a reason that showed up the moment it was needed elsewhere: a `.tsx` file
 * cannot be imported by anything outside the React toolchain — Node's type
 * stripping does not handle JSX — so a live verification script could not call
 * it. That is the same lesson `describeFailure` and `namesSatisfied` taught. A
 * rule worth testing is a rule worth putting where anything can reach it.
 *
 * ## Why the reconciliation exists at all
 *
 * Every primary-key and unique constraint has a **backing index of the same
 * name**, so the two payload lists overlap. Measured on a real project:
 * `articles_pkey`, `articles_notes_key`, `fk_target_pkey` and `no_key_pkey` were
 * in both. Rendering them as two sections lists those objects twice and invites
 * the reader to wonder whether there are two of them.
 *
 * Folding constraints into the column list instead fails differently: a
 * table-level `CHECK` belongs to no column and a composite `UNIQUE` belongs to
 * several, so they are either lost or duplicated across rows.
 */
import type { IntrospectionConstraint, IntrospectionIndex } from './api.ts';

/** A row of the merged list: either a constraint, or an index of its own. */
interface Row {
  name: string;
  /** `primary_key`, `unique`, `check`, `foreign_key`, `exclusion`, or `index`. */
  kind: string;
  columns: (string | null)[];
  definition: string;
  /** For a constraint whose index shares its name, so the row can say so. */
  backedBy: string | null;
  references: string | null;
  /** Only an index can be invalid. */
  invalid: boolean;
  unique: boolean;
}

/**
 * Merge the two lists, dropping the indexes that only exist to back a
 * constraint.
 *
 * Matched by **name**, because that is what Postgres guarantees: a unique or
 * primary-key constraint and its index always share one. Matching by column set
 * instead would wrongly merge a hand-made index that happens to cover the same
 * columns — which is a real thing to have, and a real thing to want to see.
 */
export function mergeRows(
  indexes: IntrospectionIndex[], constraints: IntrospectionConstraint[],
): Row[] {
  const byName = new Map(indexes.map((i) => [i.name, i]));
  const rows: Row[] = constraints.map((c) => ({
    name: c.name,
    kind: c.kind,
    columns: c.columns,
    definition: c.definition,
    backedBy: byName.has(c.name) ? c.name : null,
    references: c.references_table
      ? `${c.references_schema}.${c.references_table}` : null,
    invalid: byName.get(c.name)?.is_valid === false,
    unique: c.kind === 'primary_key' || c.kind === 'unique',
  }));

  const claimed = new Set(constraints.map((c) => c.name));
  for (const i of indexes) {
    if (claimed.has(i.name)) continue;
    rows.push({
      name: i.name,
      kind: 'index',
      columns: i.columns,
      definition: i.definition,
      backedBy: null,
      references: null,
      invalid: !i.is_valid,
      unique: i.is_unique,
    });
  }

  // Constraints first — they are rules, and an index is a performance decision.
  // Within each, by name, so the order does not shift as things are added.
  const rank = (k: string) => (k === 'index' ? 1 : 0);
  return rows.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
}

