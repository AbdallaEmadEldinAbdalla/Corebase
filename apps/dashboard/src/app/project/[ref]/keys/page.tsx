'use client';

import { use } from 'react';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { CopyButton } from '../../../../components/Copy.tsx';
import { useProject, useProjectKeys } from '../../../../lib/queries.ts';

/**
 * API keys.
 *
 * The two keys are not equivalent and the page is built to make that impossible to
 * miss. `anon` is publishable by design — it goes in client-side code — so it is
 * shown in full to anyone who can read the project; hiding it behind a click would
 * teach the wrong lesson about which of the two is dangerous. `service_role`
 * bypasses row-level security, so the API only returns it under `?reveal=true` with
 * `key.manage`, and it writes an audit row naming who looked.
 *
 * That reveal is deliberately **not wired up here yet**: it needs a confirmation
 * that states what the key does and the fact that looking is recorded, and a
 * half-built version would produce audit rows saying a key was revealed when
 * nothing displayed it.
 */
export default function KeysPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const project = useProject(ref);
  const ready = project.data?.project.status === 'ready';
  const keys = useProjectKeys(ref, ready);

  const anon = keys.data?.api_keys.find((k) => k.kind === 'anon');
  const service = keys.data?.api_keys.find((k) => k.kind === 'service_role');

  return (
    <div className="wrap">
      <div className="head">
        <div>
          <h1 className="head__title">API keys</h1>
          <p className="head__sub">
            Signed ES256 tokens, minted when the project was created. Both stay
            byte-identical on every read, because a key that changes on each view is
            not usable as configuration.
          </p>
        </div>
      </div>

      {keys.error ? <ErrorSurface error={keys.error} onRetry={() => void keys.refetch()} /> : null}

      {!ready ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">Keys are not minted yet</div>
          <div className="sh-empty__text">
            They are created as part of provisioning. This page fills in when the project
            reaches <code className="mono">ready</code>.
          </div>
        </div></div>
      ) : keys.isLoading ? (
        <div className="card"><div className="card__body" aria-busy="true">
          <div className="sh-skeleton" style={{ height: 12, width: 60 }} />
          <div className="sh-skeleton" style={{ height: 18, marginTop: 10 }} />
          <div className="sh-skeleton" style={{ height: 12, width: 90, marginTop: 28 }} />
          <div className="sh-skeleton" style={{ height: 18, marginTop: 10, width: '40%' }} />
        </div></div>
      ) : (
        <>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">anon</h2>
              <p className="section__note">Safe in client-side code. Subject to row-level security.</p>
            </div>
            <div className="card">
              <div className="card__body">
                {anon?.key ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sh-space-12)' }}>
                    <code style={{ flex: 1, minWidth: 0, font: 'var(--sh-code)', overflowWrap: 'anywhere' }}>
                      {anon.key}
                    </code>
                    <CopyButton value={anon.key} what="anon key" />
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    Not available. The API can only return this key when it can decrypt it.
                  </p>
                )}
              </div>
              {anon ? (
                <div className="card__foot">
                  <span className="mono">{anon.prefix}</span>
                  <span>·</span>
                  <span>created {new Date(anon.created_at).toLocaleDateString()}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">service_role</h2>
              <p className="section__note">Bypasses row-level security. Server-side only, never in a browser.</p>
            </div>
            <div className="card">
              <div className="card__body">
                <p className="muted" style={{ margin: 0 }}>
                  Hidden. Revealing this key requires admin rights and is recorded in the
                  audit log against your account. The confirmation flow that does that
                  properly is not built yet — until then, read it with the API:
                </p>
                <div className="sh-code codeblock" style={{ marginTop: 'var(--sh-space-16)' }}>
                  <div className="sh-code__header">
                    <span className="sh-code__lang">shell</span>
                    <CopyButton
                      value={`curl -b cookies.txt "$STEADHOLD_API/v1/projects/${ref}/keys?reveal=true"`}
                      what="Command" variant="ghost" />
                  </div>
                  <pre><code>{`curl -b cookies.txt \\\n  "$STEADHOLD_API/v1/projects/${ref}/keys?reveal=true"`}</code></pre>
                </div>
              </div>
              {service ? (
                <div className="card__foot">
                  <span className="mono">{service.prefix}</span>
                  <span>·</span>
                  <span>created {new Date(service.created_at).toLocaleDateString()}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="section">
            <div className="section__head"><h2 className="section__title">JWKS</h2></div>
            <div className="card"><div className="card__body">
              <p className="muted" style={{ margin: 0, marginBottom: 'var(--sh-space-12)' }}>
                Your own services can verify these tokens without calling us.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sh-space-12)' }}>
                <code style={{ flex: 1, minWidth: 0, font: 'var(--sh-code)', overflowWrap: 'anywhere' }}>
                  {`/v1/projects/${ref}/.well-known/jwks.json`}
                </code>
                <CopyButton value={`/v1/projects/${ref}/.well-known/jwks.json`} what="JWKS path" />
              </div>
            </div></div>
          </section>
        </>
      )}
    </div>
  );
}
