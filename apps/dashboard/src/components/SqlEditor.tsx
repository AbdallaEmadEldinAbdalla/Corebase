'use client';

import { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  rectangularSelection, crosshairCursor, placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle,
} from '@codemirror/language';
import { autocompletion, closeBrackets, completeFromList } from '@codemirror/autocomplete';
import { sql, PostgreSQL, type SQLNamespace } from '@codemirror/lang-sql';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import type { CompletionSchema } from '../lib/sql-completions.ts';

/**
 * The editor, D-134's CodeMirror 6.
 *
 * ## Every colour is a role token, and that is not automatic here
 *
 * CodeMirror draws its own DOM, so the design system's rules do not reach it by
 * default — it ships a perfectly reasonable light theme with a blue selection
 * and a grey gutter, which is a *cool* palette dropped into a warm clay one. So
 * the theme below names a role token for every surface CM6 would otherwise pick
 * for itself, and the list is deliberately exhaustive rather than "the ones that
 * looked wrong": a selector left out is a colour that silently is not ours, and
 * it will be found by a user rather than by a test.
 *
 * `tokens.test.ts` now scans `.ts` files as well as `.tsx` for colour literals,
 * which it did not before this file existed — a theme in a `.ts` module was
 * outside the guard entirely.
 *
 * ## Tab is not bound to indent, on purpose
 *
 * `indentWithTab` is opt-in in CM6 and is deliberately **not** added.
 * `defaultKeymap` leaves Tab alone, so it moves focus out of the editor the way
 * it does everywhere else — which is what makes this surface reachable *and
 * escapable* by keyboard (§2, gate question 5). An editor that swallows Tab is
 * a trap that only a keyboard user discovers.
 *
 * Indentation still works: Enter auto-indents (`indentOnInput`), and CM6's own
 * `Ctrl-m` / `Alt-Shift-m` toggles tab-focus mode for anyone who wants the
 * indenting behaviour.
 */

/**
 * Syntax colours, from the four code role tokens the design system defines.
 *
 * Four, not twelve — the same argument `sql-highlight.ts` makes for the SQL
 * preview: colour is how the eye finds the exception, so the exception has to be
 * rare. Types and identifiers stay plain because in a `CREATE TABLE` they *are*
 * the content.
 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--sh-code-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--sh-code-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--sh-code-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: 'var(--sh-code-string)' },
  { tag: t.operator, color: 'var(--sh-code-text)' },
  { tag: t.invalid, color: 'var(--sh-error)' },
]);

/**
 * Every surface CM6 would otherwise colour itself.
 *
 * Kept as one object with a comment per group, because the failure mode is an
 * omission and an omission is invisible in a diff. `tokens.test.ts` asserts that
 * each of these selectors is present, so deleting one fails rather than shipping
 * a blue selection.
 */
const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--sh-code-bg)',
    color: 'var(--sh-code-text)',
    borderRadius: 'var(--sh-radius-md)',
    border: '1px solid var(--sh-border)',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: '2px solid var(--sh-focus-ring)',
    outlineOffset: '1px',
  },
  '.cm-content': {
    fontFamily: 'var(--sh-font-mono)',
    caretColor: 'var(--sh-code-text)',
    padding: '10px 0',
  },
  '.cm-scroller': { fontFamily: 'var(--sh-font-mono)', lineHeight: '1.6' },
  // The caret. Two selectors because a drop cursor (drag-and-drop) is a separate
  // element and defaults to black.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sh-code-text)' },
  // Selection. CM6 draws its own (`drawSelection`), *and* the native one shows
  // through on unfocused content — both need saying or one of them is blue.
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sh-accent-subtle)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--sh-code-header)',
    color: 'var(--sh-code-comment)',
    borderRight: '1px solid var(--sh-border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--sh-surface-alt)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--sh-surface-alt)', color: 'var(--sh-code-text)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--sh-accent-subtle)',
    outline: '1px solid var(--sh-accent-border)',
  },
  // The completion popup, which is a floating layer CM6 positions itself.
  '.cm-tooltip': {
    backgroundColor: 'var(--sh-surface-raised)',
    border: '1px solid var(--sh-border-strong)',
    borderRadius: 'var(--sh-radius-md)',
    color: 'var(--sh-text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    fontFamily: 'var(--sh-font-mono)',
    padding: '3px 8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--sh-accent-subtle)',
    color: 'var(--sh-text)',
  },
  '.cm-completionDetail': { color: 'var(--sh-text-muted)', fontStyle: 'normal' },
  '.cm-completionIcon': { color: 'var(--sh-text-muted)' },
  // The error underline and its gutter marker — the whole point of wiring
  // Postgres's `position` through.
  '.cm-lintRange-error': {
    // A wavy underline drawn with a gradient rather than an SVG data URI, so it
    // takes a role token like everything else.
    backgroundImage: 'none',
    borderBottom: '2px wavy var(--sh-error)',
    textDecoration: 'underline wavy var(--sh-error)',
  },
  '.cm-lint-marker-error': { color: 'var(--sh-error)' },
  '.cm-panels': {
    backgroundColor: 'var(--sh-surface-alt)',
    color: 'var(--sh-text)',
  },
  '.cm-placeholder': { color: 'var(--sh-text-muted)', fontStyle: 'normal' },
  '.cm-specialChar': { color: 'var(--sh-warning)' },
}, { dark: false });

/**
 * The reconfigurable slice: the SQL language plus the extra completion source.
 *
 * At module scope rather than per component, which is correct because there is
 * one editor on the page — and if that ever stops being true, a compartment
 * shared between two views is a bug a `useRef` would have prevented. Noted
 * rather than pre-solved.
 */
const schemaConf = new Compartment();

function languageFor(c: CompletionSchema): Extension {
  const lang = sql({
    dialect: PostgreSQL,
    schema: c.schema as SQLNamespace,
    defaultSchema: c.defaultSchema,
    // Lower case, matching every statement this product generates — an editor
    // that completes `SELECT` beside a preview that says `select` looks like two
    // different tools.
    upperCaseKeywords: false,
  });

  return [
    lang,
    /**
     * Functions and roles, attached to the **language's own data** rather than
     * passed as an `override`.
     *
     * `autocompletion({override})` *replaces* every source, which would throw
     * away lang-sql's alias-aware column completion — the single reason for
     * using it. `language.data.of({autocomplete})` adds a source beside it, and
     * CM6 merges what the sources return.
     */
    lang.language.data.of({
      autocomplete: completeFromList(c.extra.map((e) => ({
        label: e.label, detail: e.detail, type: e.type,
      }))),
    }),
  ];
}

export interface SqlEditorProps {
  value: string;
  onChange: (sql: string) => void;
  /** The completion source, rebuilt when the schema changes. */
  completions: CompletionSchema;
  /** Runs the buffer, or the selection when there is one. */
  onRun: (selection: string | null) => void;
  onExplain: (selection: string | null) => void;
  /** A Postgres error to underline: a 1-based character offset. */
  errorAt?: { position: number; message: string } | null;
  placeholder?: string;
}

export function SqlEditor(props: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * The callbacks, in a ref.
   *
   * A CM6 extension list is baked into the state at creation, so a keymap
   * closing over `props.onRun` would call the first render's version forever —
   * and `onRun` closes over the tab, the role and the read-only flag, so a stale
   * one would run the wrong statement as the wrong role. Rebuilding the whole
   * editor on every render is the alternative and it loses the cursor, the undo
   * history and the selection on each keystroke.
   */
  const latest = useRef(props);
  latest.current = props;

  /** The selected text, or null when the selection is empty. */
  const selectionOf = (v: EditorView): string | null => {
    const { from, to } = v.state.selection.main;
    return from === to ? null : v.state.sliceDoc(from, to);
  };

  useEffect(() => {
    if (!host.current || view.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      // No `override`: the sources come from the language's data, which is what
      // keeps lang-sql's alias-aware column completion. `icons: false` because
      // CM6's default icons are a second icon language beside lucide's.
      autocompletion({ icons: false }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      lintGutter(),
      syntaxHighlighting(highlight),
      theme,
      /**
       * The run bindings, **before** `defaultKeymap` so they win.
       *
       * `Mod-Enter` is `Cmd` on a Mac and `Ctrl` elsewhere, which CM6 resolves
       * itself — the same reason `lib/hotkeys.ts` renders the label from the
       * platform rather than guessing.
       */
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: (v) => { latest.current.onRun(selectionOf(v)); return true; },
        },
        {
          key: 'Mod-Shift-Enter',
          preventDefault: true,
          run: (v) => { latest.current.onExplain(selectionOf(v)); return true; },
        },
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange(u.state.doc.toString());
      }),
      EditorView.lineWrapping,
      // The empty buffer says what to do, rather than being a blank box with a
      // Run button beside it.
      cmPlaceholder(props.placeholder ?? 'select * from …'),
      // The reconfigurable slice, seeded with whatever schema we have now —
      // possibly none, if introspection has not landed yet.
      schemaConf.of(languageFor(latest.current.completions)),
    ];

    const state = EditorState.create({ doc: props.value, extensions });
    view.current = new EditorView({ state, parent: host.current });

    return () => { view.current?.destroy(); view.current = null; };
    // Created once. Everything that changes is pushed in by the effects below,
    // because recreating the editor loses the cursor and the undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Push the buffer in when it changed *elsewhere* — a tab switch, or a saved
   * query being opened.
   *
   * Guarded on inequality, and that guard is load-bearing: without it every
   * keystroke would dispatch a full-document replacement, which resets the
   * cursor to the end and makes the editor unusable the moment you edit in the
   * middle of a line.
   */
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === props.value) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  /**
   * Swap the language extension when the schema arrives or changes.
   *
   * A `Compartment`, which is CM6's mechanism for a reconfigurable slice of the
   * extension list. The first version appended instead, and appending is wrong
   * twice over: the extensions **accumulate** — a project whose schema changes
   * ten times ends up with ten language extensions and ten completion sources
   * all running — and the API to do it (`StateEffect.appendConfig`) is for
   * adding something permanently, not for replacing it. A compartment is the
   * thing that replaces.
   */
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: schemaConf.reconfigure(languageFor(props.completions)) });
  }, [props.completions]);

  /** Underline the error position Postgres reported. */
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const err = props.errorAt;
    if (!err) { v.dispatch(setDiagnostics(v.state, [])); return; }
    /**
     * Postgres's `position` is **1-based and in characters**; CM6 wants a
     * 0-based offset. Off by one here puts the underline on the character after
     * the problem, which is worse than no underline: it sends the reader to the
     * wrong token with confidence.
     */
    const from = Math.max(0, Math.min(err.position - 1, v.state.doc.length));
    const to = Math.min(from + 1, v.state.doc.length);
    const diagnostic: Diagnostic = { from, to, severity: 'error', message: err.message };
    v.dispatch(setDiagnostics(v.state, [diagnostic]));
    // Bring it into view — an underline below the fold is not a report.
    v.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  }, [props.errorAt]);

  return (
    <div className="sqled" ref={host}
         // The editor is a `contenteditable` CM6 owns; this wrapper carries the
         // accessible name so a screen reader announces what the region is.
         role="group" aria-label="SQL editor" />
  );
}
