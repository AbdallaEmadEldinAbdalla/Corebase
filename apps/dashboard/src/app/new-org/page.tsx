'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell.tsx';
import { ErrorSurface, FieldError } from '../../components/ErrorSurface.tsx';
import { useCreateOrg, useOrgs } from '../../lib/queries.ts';
import { useToast } from '../../components/Toasts.tsx';
import { rememberOrg } from '../../lib/last-org.ts';

/**
 * Create an organization.
 *
 * This page exists because the shell had a dead end: a new account has no
 * organization, `/no-org` explained the state, and there was no way to resolve it —
 * the endpoint had existed since P1d with no screen. The UX standard is explicit
 * that an empty state without its action is a dead end (§6), and this was the
 * clearest one in the product.
 *
 * The slug is **derived from the name and shown, not asked for**. It is part of
 * every URL, so it cannot be hidden; but making someone invent one is asking a
 * question that has an obvious answer 95% of the time. It stays editable for the
 * other 5%, and once edited it stops tracking the name — silently overwriting
 * something a user deliberately typed is worse than a slightly stale slug.
 */
const SLUG_RULE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // café → cafe
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export default function NewOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const orgs = useOrgs();
  const create = useCreateOrg();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const nameOk = name.trim().length >= 2 && name.trim().length <= 120;
  const slugOk = effectiveSlug.length >= 2 && effectiveSlug.length <= 48 && SLUG_RULE.test(effectiveSlug);
  const slugTaken = (orgs.data?.orgs ?? []).some((o) => o.slug === effectiveSlug);
  const valid = nameOk && slugOk && !slugTaken;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    try {
      const { org } = await create.mutateAsync({ name: name.trim(), slug: effectiveSlug });
      rememberOrg(org.slug);
      toast.show({ tone: 'success', title: `${org.name} created`, detail: 'You are its owner.' });
      router.replace(`/org/${org.slug}`);
    } catch { /* rendered below */ }
  };

  return (
    <AppShell>
      <div className="wrap wrap--narrow">
        <div className="head">
          <div>
            <h1 className="head__title">New organization</h1>
            <p className="head__sub">
              Organizations own projects and hold their members and billing. You will be
              its owner.
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
              <label className="sh-label" htmlFor="org-name">Name</label>
              <input className="sh-input" id="org-name" value={name} autoFocus
                     placeholder="Greenbull" autoComplete="organization"
                     onChange={(e) => setName(e.target.value)} />
              <span className="sh-help">What people in your team will see.</span>
            </div>

            <div className="sh-field" style={{ marginTop: 'var(--sh-space-4)' }}>
              <label className="sh-label" htmlFor="org-slug">
                URL <span className="muted">· appears in every link</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono muted" style={{ flex: 'none' }}>/org/</span>
                <input className={`sh-input${(slugTaken || (effectiveSlug && !slugOk)) ? ' sh-input--error' : ''}`}
                       id="org-slug" value={effectiveSlug} spellCheck={false}
                       aria-invalid={slugTaken || Boolean(effectiveSlug) && !slugOk}
                       onChange={(e) => { setSlugEdited(true); setSlug(e.target.value); }} />
              </div>
              {slugTaken
                ? <FieldError>You already have an organization at this URL.</FieldError>
                : effectiveSlug && !slugOk
                  ? <FieldError>
                      Lowercase letters, numbers and dashes, starting and ending with a
                      letter or number.
                    </FieldError>
                  : <span className="sh-help">
                      {slugEdited ? 'Edited — it no longer follows the name.' : 'Derived from the name. You can change it.'}
                    </span>}
            </div>
          </div>

          <div className="card__foot" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="sh-btn sh-btn--secondary"
                    onClick={() => router.back()}>Cancel</button>
            <button type="submit" className="sh-btn" disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create organization'}
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
