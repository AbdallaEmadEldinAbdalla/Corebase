'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, ApiError } from '../../lib/api.ts';
import { safeNext } from '../../lib/next-path.ts';
import { ErrorSurface, FieldError } from '../../components/ErrorSurface.tsx';
import { Logo } from '../../components/Logo.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

/** Mirrors MIN_PASSWORD_LENGTH in @steadhold/crypto. Checked here so the user
 *  learns the rule while typing, and on the server because this check is advice. */
const MIN_PASSWORD = 12;

/**
 * Same Suspense split as the login page, and for the same reason: reading
 * `?next=` opts the route out of static prerendering unless the read sits under a
 * boundary.
 *
 * Signup needed `next` at all because of the invitation flow. An invitee arrives
 * at `/accept-invite/<token>`, is bounced to `/login?next=…`, and the one thing
 * they almost certainly need is the "Create one" link — which used to drop `next`
 * and send them to `/` after signing up, stranding the invitation they came for.
 */
export default function SignupPage() {
  return (
    <Suspense fallback={<SignupSkeleton />}>
      <SignupForm />
    </Suspense>
  );
}

function SignupSkeleton() {
  return (
    <div className="auth">
      <div className="auth__panel" aria-busy="true">
        <div className="sh-skeleton" style={{ width: 140, height: 24 }} />
        <div className="sh-skeleton" style={{ width: '100%', height: 40, marginTop: 24 }} />
        <div className="sh-skeleton" style={{ width: '100%', height: 40, marginTop: 16 }} />
        <div className="sh-skeleton" style={{ width: '100%', height: 40, marginTop: 16 }} />
      </div>
    </div>
  );
}

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  /** Only in-app paths — see `safeNext`, which a leading-slash test is not. */
  const next = safeNext(params.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const taken = error instanceof ApiError && error.status === 409;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.signup(email.trim(), password, displayName.trim() || undefined);
      setCsrfToken(result.csrf_token);
      qc.clear();
      // Signup signs you in — the account was just proven to belong to whoever
      // holds the password, so a login form here would be friction with no
      // security value. `next` takes precedence over the entry point: someone who
      // arrived from an invitation wants the invitation, not the org router.
      router.replace(next ?? '/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div style={{ position: 'fixed', top: 16, right: 16 }}><ThemeToggle /></div>
      <div className="auth__panel">
        <div className="auth__brand">
          <Logo size={26} />
          Steadhold
        </div>
        <h1 className="auth__title">Create an account</h1>
        <p className="auth__sub">One command to a production backend.</p>

        {error ? (
          <div style={{ marginBottom: 'var(--sh-space-16)' }}>
            <ErrorSurface error={error}
                          title={taken ? 'That email is already registered' : 'Sign-up failed'} />
          </div>
        ) : null}

        <form onSubmit={submit} className="stack">
          <div className="sh-field">
            <label className="sh-label" htmlFor="email">Email</label>
            <input className="sh-input" id="email" type="email" autoComplete="email"
                   required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="sh-field">
            <label className="sh-label" htmlFor="name">Name <span className="muted">(optional)</span></label>
            <input className="sh-input" id="name" autoComplete="name"
                   value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="sh-field">
            <label className="sh-label" htmlFor="password">Password</label>
            <input className={`sh-input${tooShort ? ' sh-input--error' : ''}`} id="password"
                   type="password" autoComplete="new-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
            {/* The error replaces the help text rather than stacking with it
                (design system §5 rule 3). */}
            {tooShort
              ? <FieldError>{`At least ${MIN_PASSWORD} characters — length is what makes a password hard to guess.`}</FieldError>
              : <span className="sh-help">{`At least ${MIN_PASSWORD} characters.`}</span>}
          </div>
          <button className="sh-btn sh-btn--lg" type="submit"
                  disabled={busy || tooShort || password.length === 0}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <div className="auth__foot">
          Already have an account?{' '}
          <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}>
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
