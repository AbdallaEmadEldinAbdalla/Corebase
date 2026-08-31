'use client';

import { use, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../../../components/AppShell.tsx';
import { ErrorSurface, FieldError } from '../../../../components/ErrorSurface.tsx';
import { useOrgBySlug, useCreateProject } from '../../../../lib/queries.ts';

/**
 * Create a project.
 *
 * **It works with zero fields changed except the name** — the design system's
 * "good defaults" rule made concrete: region is eu-central because that is the
 * only region (D-024) and plan is Free, so the form is one field and a button.
 * Region and plan are shown as read-only facts rather than hidden, because a
 * user about to create infrastructure should be able to see where it lands.
 *
 * **The idempotency key is minted once per form, not per click.** That is the
 * whole point of D-055: a double-click, a flaky connection or an impatient
 * reload must not produce two databases. The key is regenerated only after a
 * success, when the next create is genuinely a different create.
 */
const NAME_RULE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export default function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { org } = useOrgBySlug(slug);
  const create = useCreateProject(org?.id ?? '');

  const [name, setName] = useState('');
  // useMemo, not useState(crypto.randomUUID()) — the latter re-evaluates on
  // every render even though the value is thrown away, which is noise in a
  // security-adjacent primitive.
  const [keySeed, setKeySeed] = useState(0);
  const idempotencyKey = useMemo(
    () => `dash-${globalThis.crypto.randomUUID()}`, [keySeed]);

  const trimmed = name.trim();
  // Mirrors CreateProjectRequest in @corebase/types. A single character fails
  // there too — the rule needs a first *and* last character.
  const nameValid = trimmed.length >= 2 && trimmed.length <= 63 && NAME_RULE.test(trimmed);
  const showNameError = trimmed.length > 0 && !nameValid;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org || !nameValid) return;
    try {
      const result = await create.mutateAsync({ name: trimmed, idempotencyKey });
      setKeySeed((n) => n + 1);
      // Straight to the project: provisioning progress belongs on the thing
      // being provisioned, not on the form that asked for it.
      router.replace(`/project/${result.project.ref}`);
    } catch { /* rendered below */ }
  };

  return (
    <AppShell orgSlug={slug}>
      <main className="page">
        <div className="page__inner" style={{ maxWidth: 560 }}>
          <div className="page__head">
            <div>
              <h1 className="page__title">New project</h1>
              <p className="page__sub">
                {org ? `In ${org.name}. Ready in a few seconds.` : ' '}
              </p>
            </div>
          </div>

          {create.error ? (
            <div style={{ marginBottom: 'var(--cb-space-4)' }}>
              <ErrorSurface error={create.error} />
            </div>
          ) : null}

          <form onSubmit={submit} className="stack">
            <div className="cb-field">
              <label className="cb-label" htmlFor="name">Project name</label>
              <input className={`cb-input${showNameError ? ' cb-input--error' : ''}`}
                     id="name" value={name} autoFocus
                     placeholder="my-app"
                     onChange={(e) => setName(e.target.value)} />
              {showNameError
                ? <FieldError>
                    Lowercase letters, numbers and dashes, starting and ending with a
                    letter or number — this becomes part of URLs and role names.
                  </FieldError>
                : <span className="cb-help">
                    Lowercase letters, numbers and dashes. Unique within {org?.name ?? 'this organization'}.
                  </span>}
            </div>

            <div className="kv">
              <div className="kv__k">Region</div>
              <div className="kv__v">eu-central <span className="muted">· the only region today</span></div>
              <div className="kv__k">Plan</div>
              <div className="kv__v">Free <span className="muted">· pauses after 7 idle days</span></div>
            </div>

            <div className="row">
              <button className="cb-btn cb-btn--lg" type="submit"
                      disabled={!org || !nameValid || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create project'}
              </button>
              <button className="cb-btn cb-btn--secondary cb-btn--lg" type="button"
                      onClick={() => router.push(`/org/${slug}`)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </main>
    </AppShell>
  );
}
