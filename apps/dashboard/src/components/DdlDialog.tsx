'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { classify } from '@steadhold/sql-guard';
import { useReturnFocus } from '../lib/return-focus.ts';
import { ApiError } from '../lib/api.ts';
import { SqlPreview } from './SqlPreview.tsx';
import { CopyButton } from './Copy.tsx';
import { describeFailure, type Plan } from '../lib/ddl.ts';
import type { RowPlan } from '../lib/dml.ts';
import { namesSatisfied } from '../lib/confirm.ts';

/**
 * The loop, as one layer.
 *
 * D-133: `user acts in UI → SQL preview shows the EXACT statement(s) → user
 * confirms → executed via the admin path → result or error shown`. This component
 * is the whole of it, and three decisions in it were made by the review gate
 * rather than by the spec.
 *
 * **One dialog, not two.** The spec describes a docked preview pane beside a form
 * and then a confirmation. Two stacked layers means `Escape` has an ordering
 * problem and focus has two places to return to, which is gate question 7 — and
 * the pane-beside-a-form shape is a desktop shape in a product with no
 * desktop-only surfaces. Form, preview, notices and confirm are one thing here;
 * on a narrow screen they stack and the dialog scrolls.
 *
 * **The flip to editable is reversible.** The spec says the form greys out and the
 * SQL becomes authoritative, which is right — but a one-way switch that silently
 * discards typed work fails no numbered question and is still bad. "Back to the
 * form" is always there and says that it discards the edits.
 *
 * **Cost is prose; the ladder is the server's.** A `Notice` renders as a sentence
 * with no checkbox, and the confirm button is identical whether or not one is
 * present. The typed-name field appears only when `classify()` says the *server*
 * will demand it (D-468). A client-side gate on a statement the server would run
 * unasked is theatre, and the moment there are two ladders on one screen the user
 * reads them as one and stops believing the one that is enforced.
 */

/**
 * What the caller has to give us: a way to build the plan, and the form to build
 * it from.
 *
 * `plan` is a function rather than a value because it is recomputed on every
 * keystroke — the preview has to be live, or it is a summary of what the form
 * said a moment ago. It may throw `Impossible`, which is a *refusal* with a
 * reason and is rendered instead of the preview: `SET NOT NULL` on a column with
 * nulls cannot succeed, and finding that out from a Postgres error after
 * confirming is worse than being told before.
 */
export interface DdlDialogProps {
  open: boolean;
  title: string;
  /** The form controls. Disabled by the dialog while the SQL is authoritative. */
  form: ReactNode;
  /**
   * Recomputed each render. Throws `Impossible` when the form is not runnable.
   *
   * A `Plan` or a `RowPlan`, and the difference is read off the value rather
   * than declared by the caller: a `RowPlan` has `bindings` and **no**
   * `filename`, so the download button and the binding list both appear exactly
   * when they should. "Row edits are never offered as migrations" is therefore
   * enforced by the shape of the data instead of by a prop somebody has to
   * remember to pass.
   */
  plan: () => Plan | RowPlan;
  onCancel: () => void;
  /** Runs the script. Resolves on success; rejects with an `ApiError`. */
  onRun: (req: {
    sql: string; params: unknown[];
    confirmDestructive: boolean; confirmNames: string[];
    /** True when the user hand-edited the SQL, so the caller's own summary of
     *  what it does is no longer reliable. */
    edited: boolean;
  }) => Promise<void>;
  /** The verb on the confirm button — "Add column", "Drop table". */
  confirmLabel: string;
}

export function DdlDialog(props: DdlDialogProps) {
  const {
    open, title, form, plan, onCancel, onRun, confirmLabel,
  } = props;

  const [editing, setEditing] = useState(false);
  /** The hand-edited SQL. Authoritative while `editing`. */
  const [edited, setEdited] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const { capture, restore } = useReturnFocus();

  /** Reset between openings, or the second drop inherits the first one's text. */
  useEffect(() => {
    if (!open) { setEditing(false); setEdited(''); setTyped(''); setError(null); }
  }, [open]);

  /**
   * Build the plan, on every render, catching the two expected failures.
   *
   * Not memoised, deliberately. `plan` is a fresh closure every render — it has
   * to be, since it closes over the form's state — so any dependency array
   * either recomputes anyway or goes stale, and a `useMemo` that never memoises
   * is worse than none: it reads as a claim that this is expensive and cached,
   * and it is neither.
   *
   * `describeFailure` sorts the throw into a *todo* (the form is not filled in
   * yet — the state every dialog opens in) or a *refusal* (this statement cannot
   * work however it is filled in). It lives in `ddl.ts` because `Incomplete
   * extends Impossible`, so those two checks are order dependent, and the
   * ordering is asserted by a test there rather than sitting in a component this
   * app has no way to render in a test. Anything else is a real fault and is
   * re-thrown, because a `TypeError` rendered as a friendly hint is a
   * `TypeError` that survives.
   */
  let built: { plan: Plan | RowPlan } | { refusal: string } | { todo: string };
  try { built = { plan: plan() }; } catch (err) { built = describeFailure(err); }

  const generated = 'plan' in built ? built.plan.sql : '';
  const sql = editing ? edited : generated;

  /**
   * The rung, decided by the same code the server runs (D-134).
   *
   * Not a mirror of it — the actual package, so the dialog cannot ask for a plain
   * confirmation on a statement the server will refuse without a typed name. A
   * second implementation of a safety ladder diverges, and it diverges in the
   * direction where the dialog is wrong.
   */
  const script = useMemo(() => classify(sql), [sql]);
  const needsNames = script.namesToType;
  /**
   * Whether the typed names satisfy the statement — in `lib/confirm.ts`, tested.
   *
   * It was four lines here, and the four lines were wrong: they split the typed
   * text on whitespace before comparing, so a column named `"odd name"` — whose
   * quotes the guard deliberately keeps, because dropping them changes which
   * identifier it is — tore into `"odd` and `name"` and could never match. The
   * confirm button would have stayed disabled however carefully the user typed,
   * with nothing on screen explaining why. Found by extracting the rule in order
   * to test it, which is the only reason it was found: there is no DOM test
   * environment here, so a rule left inside a component is a rule nothing checks.
   */
  const satisfied = namesSatisfied(needsNames, typed);

  const runnable = 'plan' in built && sql.trim().length > 0 && satisfied;

  /**
   * Capture-then-focus on the transition into `open`, and nothing else.
   *
   * The same contract `ConfirmDialog` documents, for the same reason: `onCancel`
   * is usually a fresh closure per render, and re-running this would re-capture
   * with one of this dialog's own controls focused — which then unmounts, landing
   * focus on `<body>`.
   *
   * Cancel takes focus rather than the confirm button. A dialog that opens with
   * "Drop table" under the return key is a trap, not a confirmation.
   */
  useEffect(() => {
    if (!open) return;
    capture();
    // The typed-name field inverts the rule, and safely — the same inversion
    // `ConfirmDialog` documents. Ordinarily Cancel takes focus so the
    // destructive button is not under the return key; when a name must be typed
    // that button is *disabled* until it matches, so there is nothing to fire by
    // accident and the field is where the user has to go anyway.
    if (needsNames.length > 0) nameField.current?.focus();
    else cancel.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while running: cancelling the dialog does not cancel the statement,
      // and closing it would leave the user with no idea whether it applied.
      if (e.key === 'Escape' && !pending) {
        e.preventDefault(); e.stopPropagation(); onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel, pending]);

  useEffect(() => { if (!open) restore(); }, [open, restore]);

  if (!open) return null;

  const submit = async () => {
    if (!runnable || pending) return;
    setPending(true);
    setError(null);
    try {
      await onRun({
        sql,
        /**
         * The params travel only while the *generated* statement is running.
         *
         * Once the user has hand-edited the SQL, `$1` may no longer mean what
         * the plan thought it meant — they may have reordered the SET list or
         * removed a clause — so sending the old array would bind values to the
         * wrong placeholders. Dropping them makes the edited statement fail
         * loudly on a missing parameter instead of writing the wrong value,
         * which is the right way round for this to break.
         */
        params: !editing && 'plan' in built && 'params' in built.plan
          ? built.plan.params : [],
        // `editing`, the mode — not `edited`, which is the text itself.
        edited: editing,
        // Sent from what the *script* says, not from what the operation intended:
        // once the user can hand-edit the SQL, the operation's own idea of its
        // danger is out of date and the text is the only truth.
        confirmDestructive: script.danger !== 'safe',
        confirmNames: needsNames,
      });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  const pg = error instanceof ApiError ? error.pg : null;
  const requestId = error instanceof ApiError ? error.requestId : null;

  return (
    <div className="sh-modal">
      <button type="button" className="sh-scrim" aria-label="Cancel"
              onClick={() => { if (!pending) onCancel(); }} />
      <div className="sh-dialog ddl" role="dialog" aria-modal="true"
           tabIndex={-1} aria-label={title} ref={dialog}>
        <div className="sh-dialog__title">{title}</div>

        <div className="ddl__body">
          {/* The form. `inert` rather than `disabled` on each control: it greys
              the whole group and takes it out of the tab order in one attribute,
              and the alternative is threading a disabled prop through every
              caller's form and forgetting it in one of them. */}
          <div className="ddl__form" inert={editing}
               {...(editing ? { 'aria-hidden': true } : {})}>
            {form}
          </div>

          {'todo' in built ? (
            /* Not filled in yet. A muted line where the preview will be, rather
               than a warning: the dialog opens in this state, and greeting the
               user with something that looks like a problem is §6's "never show
               an error for something still in progress" applied to a form. */
            <p className="sh-help ddl__todo" role="status">{built.todo}</p>
          ) : 'refusal' in built ? (
            /* A refusal, not an error: nothing has been attempted. It replaces
               the preview because there is no statement to preview — showing an
               empty code block under a warning reads as a bug. */
            <div className="sh-banner sh-banner--warning" role="status">
              <div className="sh-banner__body">
                <div className="sh-banner__title">This cannot run as described</div>
                <div className="sh-banner__text">{built.refusal}</div>
              </div>
            </div>
          ) : (
            <>
              <div className="ddl__previewhead">
                <span className="sh-label">
                  {editing ? 'SQL (yours — this is what runs)' : 'SQL that will run'}
                </span>
                <span className="sh-row sh-row--tight">
                  <CopyButton value={sql} what="SQL" />
                  {editing ? (
                    <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                            onClick={() => setEditing(false)} disabled={pending}>
                      Back to the form
                    </button>
                  ) : (
                    <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                            onClick={() => { setEdited(generated); setEditing(true); }}
                            disabled={pending}>
                      Edit SQL
                    </button>
                  )}
                </span>
              </div>

              {editing ? (
                <>
                  <textarea className="sh-textarea ddl__editor" value={edited} rows={8}
                            spellCheck={false} autoComplete="off" disabled={pending}
                            aria-label="SQL to run"
                            onChange={(e) => setEdited(e.target.value)} />
                  <p className="sh-help">
                    The form above is ignored while you are editing here.
                    &ldquo;Back to the form&rdquo; rebuilds the SQL from the fields and
                    discards these edits.
                  </p>
                </>
              ) : (
                <SqlPreview sql={sql} />
              )}

              {/**
                * What each placeholder holds.
                *
                * The spec asks for "values as placeholders", which is about not
                * *interpolating* them rather than about hiding them — a preview
                * showing `set "title" = $1` alone is a statement the user cannot
                * check, and this loop's entire premise is that they can. So the
                * statement keeps its placeholders and the values are listed
                * beside it, which is also how psql reports a prepared statement.
                */}
              {'bindings' in built.plan && built.plan.bindings.length > 0 ? (
                <dl className="ddl__binds">
                  {built.plan.bindings.map((b) => (
                    <div className="ddl__bind" key={b.placeholder}>
                      <dt><code style={{ font: 'var(--sh-code)' }}>{b.placeholder}</code></dt>
                      <dd>
                        <span className="ddl__bindcol">{b.column}</span>
                        <span className="ddl__bindval">{b.value}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {/* Cost, as prose. No checkbox, no second button: the confirm
                  control is the same one whether or not these are here. */}
              {built.plan.notices.length > 0 ? (
                <ul className="ddl__notices">
                  {built.plan.notices.map((n, i) => (
                    <li key={i} className={`ddl__notice ddl__notice--${n.kind}`}>
                      {n.text}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The rung the *server* enforces, and it says so — because the
                  difference between "we advise" and "we refuse" is the whole
                  value of the sentence. */}
              {needsNames.length > 0 ? (
                <div className="sh-field ddl__confirm">
                  <label className="sh-label" htmlFor={nameId}>
                    Type {needsNames.map((n, i) => (
                      <span key={n}>
                        {i > 0 ? ' and ' : ''}<strong>{n}</strong>
                      </span>
                    ))} to confirm
                  </label>
                  <input id={nameId} ref={nameField} className="sh-input" type="text"
                         value={typed} autoComplete="off" spellCheck={false}
                         disabled={pending}
                         onChange={(e) => setTyped(e.target.value)} />
                  <p className="sh-help">
                    {script.dangerous.map((d) => d.reason).join(' ')}
                  </p>
                </div>
              ) : null}
            </>
          )}

          {error ? (
            /**
             * The failure, with the database's own words.
             *
             * `pg.position` is a 1-based offset into the statement and is the
             * reason this is not just the message: it is what turns "syntax
             * error at or near \"form\"" into a location. `hint` is Postgres's
             * own suggestion and is often the actual fix, so it is shown
             * verbatim rather than paraphrased.
             */
            <div className="sh-banner sh-banner--error" role="alert">
              <div className="sh-banner__body">
                <div className="sh-banner__title">
                  {pg ? 'The database refused this statement' : 'Could not run this'}
                </div>
                <div className="sh-banner__text">
                  {(error as Error).message}
                  {pg?.detail ? <> {pg.detail}</> : null}
                  {pg?.hint ? (
                    <><br /><strong>Hint from Postgres:</strong> {pg.hint}</>
                  ) : null}
                </div>
                <div className="ddl__errmeta">
                  {/* The platform `code`, which D-032 asks for alongside the
                      sentence and the request id — it is what a support
                      conversation is actually conducted in. `VALIDATION_FAILED`
                      on a 409 is the guard refusing; `SQL_ERROR` is the database
                      refusing; and those are different problems with the same
                      red banner. */}
                  {error instanceof ApiError ? (
                    <span>
                      <code style={{ font: 'var(--sh-code)' }}>{error.code}</code>
                      {` · HTTP ${error.status}`}
                    </span>
                  ) : null}
                  {pg ? (
                    <span>
                      SQLSTATE <code style={{ font: 'var(--sh-code)' }}>{pg.sqlstate}</code>
                      {pg.position !== null ? ` · at character ${pg.position}` : ''}
                    </span>
                  ) : null}
                  {requestId ? (
                    <span>
                      Request <code style={{ font: 'var(--sh-code)' }}>{requestId}</code>
                      {' '}<CopyButton value={requestId} what="Request id" variant="secondary" />
                    </span>
                  ) : null}
                </div>
                <div className="sh-banner__text" style={{ marginTop: 'var(--sh-space-8)' }}>
                  {/* The one thing worth saying about a failed DDL run, and it is
                      not obvious: the whole script is one transaction, so a
                      failure changed nothing at all. */}
                  Nothing was applied — the whole script runs in one transaction,
                  so a failure leaves the schema exactly as it was.
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="sh-dialog__footer ddl__footer">
          {'plan' in built && 'filename' in built.plan ? (
            /**
             * Not "Save as migration", deliberately.
             *
             * D-076's promise is that a saved change is *recorded as applied* — a
             * row in `schema_migrations` plus a written file — and that needs a
             * server endpoint that does not exist. A button carrying that label
             * would claim the recording, which is the Q20 failure. This one
             * offers the file, correctly named per D-028, and says what it is
             * not.
             */
            <DownloadSql plan={built.plan} sql={sql} />
          ) : null}
          <span className="ddl__spacer" />
          <button ref={cancel} type="button" className="sh-btn sh-btn--secondary"
                  onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="button"
                  className={`sh-btn ${script.danger === 'safe' ? '' : 'sh-btn--danger'}`}
                  onClick={() => void submit()} disabled={!runnable || pending}>
            {pending ? 'Running…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The `.sql` file, and an honest label for it.
 *
 * A `Blob` and an object URL rather than a `data:` URI, because a statement can
 * be long and `data:` URLs have length limits that differ per browser — a
 * truncated migration file would be the worst possible failure here. The URL is
 * revoked after the click, so the blob does not sit in memory for the session.
 */
function DownloadSql({ plan, sql }: { plan: Plan; sql: string }) {
  const download = () => {
    const blob = new Blob([`${sql.trimEnd()}\n`], { type: 'application/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = plan.filename;
    a.click();
    // A microtask is not enough — Safari needs the click to have been processed.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <span className="ddl__download">
      <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
              onClick={download}>
        Download .sql
      </button>
      {/**
        * What this file is, without naming a tool that does not exist.
        *
        * The first version told the user to reconcile with `steadhold db pull
        * --changes`, which is the right eventual answer and is **Phase 8** — the
        * CLI is not built. Instructing someone to run a command that does not
        * exist is the Q20 failure moved from the nav into a help string, and it
        * is worse there because it reads as a workflow rather than a promise.
        */}
      <span className="sh-help">
        Correctly named for <code style={{ font: 'var(--sh-code)' }}>migrations/</code>,
        so committing it puts this change in your history. It is{' '}
        <strong>not</strong> recorded as already applied, so a fresh database will
        run it and this one must not.
      </span>
    </span>
  );
}
