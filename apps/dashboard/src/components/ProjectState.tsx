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
  deleting: 'cb-badge--warning',
  soft_deleted: '',
  deleted: '',
};

/** Every state the control plane is still working through. */
export const SETTLING: ReadonlySet<string> = new Set<ProjectStatus>([
  'creating', 'provisioning', 'configuring', 'pausing', 'resuming', 'deleting',
]);

/** What the label says. `soft_deleted` reads badly in a badge; the rest are fine. */
const LABEL: Partial<Record<ProjectStatus, string>> = { soft_deleted: 'DELETED' };

export function ProjectStateBadge({ status }: { status: string }): ReactElement {
  // An unknown state renders neutral under its own name rather than being mapped
  // to something reassuring. Inventing "ready" for a state this build does not
  // know is the one failure mode that actually matters here.
  const tone = TONE[status as ProjectStatus] ?? '';
  const label = LABEL[status as ProjectStatus] ?? status.replace(/_/g, ' ');
  return (
    <span className={`cb-badge ${tone}`.trim()}>
      <span className="cb-dot" aria-hidden="true" />
      {label.toUpperCase()}
    </span>
  );
}
