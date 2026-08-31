'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, ApiError } from '../../lib/api.ts';
import { ErrorSurface, FieldError } from '../../components/ErrorSurface.tsx';
import { Logo } from '../../components/Logo.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

/** Mirrors MIN_PASSWORD_LENGTH in @corebase/crypto. Checked here so the user
 *  learns the rule while typing, and on the server because this check is advice. */
const MIN_PASSWORD = 12;

export default function SignupPage() {
  const router = useRouter();
  const qc = useQueryClient();

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
      // security value. There is no org yet, so the entry point routes.
      router.replace('/');
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
          Corebase
        </div>
        <h1 className="auth__title">Create an account</h1>
        <p className="auth__sub">One command to a production backend.</p>

        {error ? (
          <div style={{ marginBottom: 'var(--cb-space-4)' }}>
            <ErrorSurface error={error}
                          title={taken ? 'That email is already registered' : 'Sign-up failed'} />
          </div>
        ) : null}

        <form onSubmit={submit} className="stack">
          <div className="cb-field">
            <label className="cb-label" htmlFor="email">Email</label>
            <input className="cb-input" id="email" type="email" autoComplete="email"
                   required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="name">Name <span className="muted">(optional)</span></label>
            <input className="cb-input" id="name" autoComplete="name"
                   value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="password">Password</label>
            <input className={`cb-input${tooShort ? ' cb-input--error' : ''}`} id="password"
                   type="password" autoComplete="new-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
            {/* The error replaces the help text rather than stacking with it
                (design system §5 rule 3). */}
            {tooShort
              ? <FieldError>{`At least ${MIN_PASSWORD} characters — length is what makes a password hard to guess.`}</FieldError>
              : <span className="cb-help">{`At least ${MIN_PASSWORD} characters.`}</span>}
          </div>
          <button className="cb-btn cb-btn--lg" type="submit"
                  disabled={busy || tooShort || password.length === 0}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <div className="auth__foot">
          Already have an account? <Link href="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
