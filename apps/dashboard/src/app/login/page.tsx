'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, ApiError } from '../../lib/api.ts';
import { ErrorSurface } from '../../components/ErrorSurface.tsx';
import { Logo } from '../../components/Logo.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

/**
 * Login.
 *
 * The API deliberately cannot tell an unknown email from a wrong password, and
 * this page must not undo that: there is one error surface for both, and the
 * message is whatever the API said. A helpful "no account with that email" here
 * would hand back the enumeration oracle the login endpoint spends a decoy hash
 * to deny.
 */
/**
 * `useSearchParams` opts a page out of static prerendering unless it sits under a
 * Suspense boundary, so the `?next=` read lives in an inner component. The shell
 * still prerenders; only the part that needs the URL waits.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <div className="auth">
      <div className="auth__panel" aria-busy="true">
        <div className="cb-skeleton" style={{ width: 140, height: 24 }} />
        <div className="cb-skeleton" style={{ width: '100%', height: 40, marginTop: 24 }} />
        <div className="cb-skeleton" style={{ width: '100%', height: 40, marginTop: 16 }} />
        <div className="cb-skeleton" style={{ width: '100%', height: 48, marginTop: 24 }} />
      </div>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const next = params.get('next');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.login(email.trim(), password);
      // The token the client echoes in x-csrf-token on every mutation. Stored
      // before any navigation, because the next page may mutate immediately.
      setCsrfToken(result.csrf_token);
      // Drop anything cached for the previous principal. Without this, a second
      // account on the same browser sees the first one's orgs for 30 seconds.
      qc.clear();
      router.replace(next && next.startsWith('/') ? next : '/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // 429 is the one failure with a different shape of answer: waiting is the fix.
  const rateLimited = error instanceof ApiError && error.status === 429;

  return (
    <div className="auth">
      <div style={{ position: 'fixed', top: 16, right: 16 }}><ThemeToggle /></div>
      <div className="auth__panel">
        <div className="auth__brand">
          <Logo size={26} />
          Corebase
        </div>
        <h1 className="auth__title">Sign in</h1>
        <p className="auth__sub">
          {next ? 'Sign in to continue where you left off.' : 'Your projects are waiting.'}
        </p>

        {error ? (
          <div style={{ marginBottom: 'var(--cb-space-4)' }}>
            <ErrorSurface error={error} title={rateLimited ? 'Too many attempts' : 'Sign-in failed'} />
          </div>
        ) : null}

        <form onSubmit={submit} className="stack">
          <div className="cb-field">
            <label className="cb-label" htmlFor="email">Email</label>
            <input className="cb-input" id="email" type="email" autoComplete="email"
                   required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="password">Password</label>
            <input className="cb-input" id="password" type="password" autoComplete="current-password"
                   required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="cb-btn cb-btn--lg" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth__foot">
          No account? <Link href="/signup">Create one</Link>
          {/* Password reset needs the Phase-4 email sender. Absent rather than a
              dead link, which is worse than not offering it at all. */}
        </div>
      </div>
    </div>
  );
}
