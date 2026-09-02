import type { ReactElement } from 'react';
import { ProjectStatus } from '@corebase/types';

/**
 * A project's state, as a dot *and* a word.
 *
 * D-180 makes this binding: project state is the most-read element in the
 * dashboard and is never carried by colour alone, so every badge pairs a hue with
 * a label that survives colour-blindness, greyscale, and a screenshot in a support
 * ticket.
 *
 * The tone map is typed `Record<ProjectStatus, …>` against the enum in
 * `@corebase/types` rather than a hand-kept list of strings. The first version
 * here *was* a hand-kept list, and it was wrong on the very first live create: a
 * new project's status is `creating`, which the list did not have, so the badge
 * rendered neutral and — much worse — the overview page decided the project was
 * not settling and stopped polling. It would have sat on CREATING until the user
 * reloaded. Typing it against the enum turns that class of mistake into a
 * compile error the next time a state is added.
 */
export const TONE: Record<ProjectStatus, string> = {
  creating: 'cb-badge--info',
  provisioning: 'cb-badge--info',
  configuring: 'cb-badge--info',
  ready: 'cb-badge--success',
  failed: 'cb-badge--error',
  pausing: 'cb-badge--warning',
  paused: '',
  resuming: 'cb-badge--info',
  restoring: 'cb-badge--info',
  /**
   * A restored copy is not healthy production and must not read as it (P3d).
   *
   * Warning rather than success, because the state needs the customer to *do*
   * something — validate it, then promote or discard — and rather than neutral,
   * because neutral is what `paused` uses and a paused project is inert. This one
   * is running, serving nothing, and costing money.
   */
  restored: 'cb-badge--warning',
  deleting: 'cb-badge--warning',
  soft_deleted: '',
  deleted: '',
};

/** Every state the control plane is still working through. */
export const SETTLING: ReadonlySet<string> = new Set<ProjectStatus>([
  'creating', 'provisioning', 'configuring', 'pausing', 'resuming', 'deleting',
  // `restoring` settles; `restored` does not. A restored copy is waiting for a
  // person, not for the control plane, so polling it forever would be a spinner
  // that never resolves — the state *is* the answer.
  'restoring',
]);

/**
 * What the label says. `soft_deleted` reads badly in a badge; the rest are fine.
 *
 * `restored` becomes "RESTORED COPY" because one word is not enough here. The
 * whole risk of this state is someone reading it as "restored, so we're fine" and
 * pointing an application at it while the original is still serving — two live
 * databases and no way to reconcile them afterwards. The noun makes the badge say
 * what the thing *is*, not what happened to it.
 */
const LABEL: Partial<Record<ProjectStatus, string>> = {
  soft_deleted: 'DELETED',
  restored: 'RESTORED COPY',
};

export function ProjectStateBadge({ status, compact }: {
  status: string;
  /** Dot only, with the word as the accessible name — for menus and dense rows
   *  where the label would not fit. D-180 still holds: the word is present, it is
   *  just carried by the title/aria rather than by pixels. */
  compact?: boolean;
}): ReactElement {
  // An unknown state renders neutral under its own name rather than being mapped
  // to something reassuring. Inventing "ready" for a state this build does not
  // know is the one failure mode that actually matters here.
  const tone = TONE[status as ProjectStatus] ?? '';
  const label = LABEL[status as ProjectStatus] ?? status.replace(/_/g, ' ');
  if (compact) {
    return (
      <span className={`cb-badge ${tone}`.trim()} title={label.toUpperCase()}
            style={{ padding: 0, width: 16, height: 16, justifyContent: 'center', background: 'none' }}>
        <span className="cb-dot" aria-hidden="true" />
        <span className="cb-sr">{label}</span>
      </span>
    );
  }
  return (
    <span className={`cb-badge ${tone}`.trim()}>
      <span className="cb-dot" aria-hidden="true" />
      {label.toUpperCase()}
    </span>
  );
}
