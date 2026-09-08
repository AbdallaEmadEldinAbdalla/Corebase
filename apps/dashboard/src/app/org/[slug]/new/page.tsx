'use client';

import { use, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSurface, FieldError } from '../../../../components/ErrorSurface.tsx';
import { useOrgBySlug, useCreateProject, useProjects } from '../../../../lib/queries.ts';
import { useToast } from '../../../../components/Toasts.tsx';

/**
 * Create a project.
 *
 * **One field.** Region is eu-central because it is the only region (D-024) and the
 * plan is Free — both shown as read-only facts rather than hidden, because someone
 * about to create infrastructure should see where it lands, and both stated rather
 * than asked, because a form that works with zero fields changed is the design
 * system's "good defaults" rule made concrete.
 *
 * **The form is finished the moment the request is accepted** (§5). It hands off to
 * the project, which reports its own progress; a create form that sits there
 * spinning is a page watching work that belongs to something else.
 *
 * **The idempotency key is minted once per form, not per click** (D-055). A
 * double-click, a flaky connection or an impatient reload must not produce two
 * databases. It rotates only after a success, when the next create really is a
 * different create.
 */
const NAME_RULE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export default function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { org } = useOrgBySlug(slug);
  const projects = useProjects(org?.id);
  const create = useCreateProject(org?.id ?? '');

  const [name, setName] = useState('');
  const [keySeed, setKeySeed] = useState(0);
  const idempotencyKey = useMemo(
    () => `dash-${globalThis.crypto.randomUUID()}`, [keySeed]);

  const trimmed = name.trim();
  // Mirrors CreateProjectRequest in @steadhold/types — a single character fails
  // there too, since the rule needs a first *and* a last character.
  const shapeOk = trimmed.length >= 2 && trimmed.length <= 63 && NAME_RULE.test(trimmed);
  // Names are unique within the organization (D-217), so the collision is knowable
  // before the round trip. Catching it here turns a 409 into a keystroke.
  const taken = projects.projects
    .some((p) => !p.deleted_at && p.name.toLowerCase() === trimmed.toLowerCase());
  const valid = shapeOk && !taken;
  const showError = trimmed.length > 0 && !valid;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org || !valid) return;
    try {
      const result = await create.mutateAsync({ name: trimmed, idempotencyKey });
      setKeySeed((n) => n + 1);
      toast.show({ tone: 'success', title: `Creating ${result.project.name}`,
                   detail: 'It will be ready in a few seconds.' });
      router.replace(`/project/${result.project.ref}`);
    } catch { /* rendered below */ }
  };

  return (
    <div className="wrap wrap--narrow">
      <div className="head">
        <div>
          <h1 className="head__title">New project</h1>
          <p className="head__sub">
            {org ? `A PostgreSQL database in ${org.name}, with its own credentials and API keys.` : ' '}
          </p>
        </div>
      </div>

      {create.error ? (
        <div style={{ marginBottom: 'var(--sh-space-4)' }}>
          <ErrorSurface error={create.error} />
        </div>
      ) : null}

      <form onSubmit={submit} className="card">
        <div className="card__body">
          <div className="sh-field">
            <label className="sh-label" htmlFor="name">Project name</label>
            <input className={`sh-input${showError ? ' sh-input--error' : ''}`}
                   id="name" value={name} autoFocus autoComplete="off" spellCheck={false}
                   placeholder="my-app"
                   aria-invalid={showError}
                   onChange={(e) => setName(e.target.value)} />
            {/* The error replaces the help text rather than stacking with it
                (design system §5 rule 3), and it names the fix. */}
            {showError
              ? <FieldError>
                  {taken
                    ? `${org?.name ?? 'This organization'} already has a project called ${trimmed}. Names are unique within an organization.`
                    : 'Lowercase letters, numbers and dashes, starting and ending with a letter or number — this becomes part of URLs and role names.'}
                </FieldError>
              : <span className="sh-help">
                  Lowercase letters, numbers and dashes. Unique within {org?.name ?? 'this organization'}.
                </span>}
          </div>

          <div className="facts" style={{ marginTop: 'var(--sh-space-5)' }}>
            <div className="facts__k">Region</div>
            <div className="facts__v">eu-central <span className="muted">· the only region today</span></div>
            <div className="facts__k">Plan</div>
            <div className="facts__v">Free <span className="muted">· pauses after 7 idle days</span></div>
            <div className="facts__k">Postgres</div>
            <div className="facts__v">17.5</div>
          </div>
        </div>

        <div className="card__foot" style={{ justifyContent: 'flex-end' }}>
          <button className="sh-btn sh-btn--secondary" type="button"
                  onClick={() => router.push(`/org/${slug}`)}>
            Cancel
          </button>
          <button className="sh-btn" type="submit"
                  disabled={!org || !valid || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}
