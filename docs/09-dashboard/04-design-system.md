# Design System

## Purpose

The visual and interaction contract for every Steadhold surface: dashboard, docs, marketing, and the CLI's terminal output where colour applies. It exists so that a component built in month nine looks like one built in month one, and so that state — the thing users actually read the dashboard for — is expressed the same way everywhere.

Scope is tokens plus a component inventory with variants. It does not prescribe implementation beyond the token contract; the dashboard stack is fixed elsewhere (D-025: Next.js + Tailwind + shadcn/ui).

The canonical artefact is the pair of design boards in Pencil (`pencil-new.pen`): frames **Steadhold Design System** (light) and **Steadhold Design System · Dark**, drawn from the same token set, plus five theme-exploration boards kept as the record of why violet won. This doc is the written source of truth for the values; the boards are the visual reference.

## Design

### 1. Brand decision

The accent is **Terracotta** — `#B4502E`, in **both** themes. Neutrals are warm
clay, carrying a trace of the accent's hue so the terracotta reads as native to the
surface rather than applied on top of a cool grey.

It comes from the identity rather than from a palette bake-off: the mark is a
chiselled S whose lower bowl is the ground it stands in (D-408), and that ground is
fired earth. **This supersedes D-177's Electric Violet (D-417).** D-177's two
objections were practical, not aesthetic, and both are answered rather than waved
past:

- **White must clear contrast on the accent in both themes.** It does, at 5.09:1,
  because the fill **does not lift in dark mode**. D-177's own "the accent lifts one
  step in dark" rule had put the dark accent at `violet/600`, where white is 4.23:1
  and ink 4.36:1 — so the dark primary button failed AA with *either* label for the
  entire life of that system, and nobody noticed because §7 justified the accent by
  measuring only the light value. Holding one fill across both themes keeps
  `on-accent` unconditional, which is what D-177 was really buying.
- **`error` must never be a hue the brand also uses.** Terracotta is red-adjacent,
  so the rule is kept by moving the semantics instead: error to the *cool* side of
  red, warning to a true ochre, both ≥25° from the accent, asserted in
  `tokens.test.ts` rather than asserted here.

**Hue keeps the semantics apart; chroma keeps them in the family (D-424).** Info is
a muted slate-teal rather than a blue, because a saturated navy on a warm clay
surface reads as borrowed from another product — and no semantic tint may be more
saturated than the accent's own, since nothing merely informational should
out-shout the brand. That rule was missing from the first version of this palette
and a screenshot found it in minutes; it is measured now.

**The limitation, stated:** the accent *tint* cannot be hue-separated from both
semantic tints simultaneously, because the brand hue sits between error and warning
— 20° is already near-equidistant, and moving away from one moves toward the other.
That separation is carried by chroma and a deeper foreground (`accent-on-subtle`,
D-420) instead, with D-180's mandatory text labels underneath. This is a permanent
consequence of a warm brand, not a defect to be fixed later.

### 2. Colour tokens

**The values are not in this document.** They live in
[`apps/dashboard/src/styles/tokens.build.mjs`](../../apps/dashboard/src/styles/tokens.build.mjs),
which generates `tokens.css` (D-418), and the constraints below are executed by
`tokens.test.ts` rather than described here. A table of hexes in Markdown is a
second source of truth that drifts silently; the previous version of this section
carried one and it is exactly where the failing dark accent hid.

What the token layer guarantees, and fails the build over:

| Guarantee | Floor |
|---|---|
| White on every accent and danger **fill**, both themes | 4.5:1 |
| `text`, `text-secondary`, `text-muted` on `bg`, `surface`, `surface-alt` | 4.5:1 |
| Every semantic colour on its own tint | 4.5:1 |
| `accent-on-subtle` on `accent-subtle` (the tinted badge) | 4.5:1 |
| Focus ring against `bg` and `surface` (WCAG 2.2) | 3:1 |
| `accent` ↔ `warning` / `error` / `danger` hue separation | 25° |
| Every semantic tint's chroma, against the accent's own tint | ≤ it |
| A skeleton against the surface it loads on | 1.25:1 |
| Ramps monotonic in luminance | — |
| No colour literal in any component stylesheet or component | — |

**Role tokens** are the only names a component may use — `--sh-surface`,
`--sh-text`, `--sh-accent`. Naming a ramp step (`--sh-clay-700`) is a bug (D-178),
and so is writing a colour literally (D-420): a literal is the same violation and
harder to see, which is how the old violet `#BEB4D6` survived a whole brand rebuild
inside the code panel's copy button.

Four things are roles in their own right because reusing something else was
measurably wrong (D-420): `accent-on-subtle`, `skeleton`, `switch-knob`, and the
code panel's copy affordance.

### 3. Typography

Three families (**D-419**, widening D-179's two).

- **Zilla Slab** — display, `heading-1`, `heading-2`. Weights 600 / 700 only. It is
  the typographic half of the identity: flat slabs answering the mark's stone-cut
  terminals. Confined to three roles at two weights so D-179's loading-budget
  argument still holds.
- **Space Grotesk** — the entire interface. Weights 400 / 500 / 600 / 700.
- **JetBrains Mono** — anything the user may copy or is authoring: SQL, connection
  strings, API keys, project refs, request IDs, log lines. This keeps D-179's real
  point, which was never the count: mono signals "this is data you can copy", a
  genuine affordance in a database product.

| Token | Size / line-height | Family | Use |
|---|---|---|---|
| `display` | 32 / 40, tracking −0.6 | slab | Page hero, empty states |
| `heading-1` | 26 / 34, tracking −0.4 | slab | Page title |
| `heading-2` | 20 / 28, tracking −0.2 | slab | Section title |
| `heading-3` | 16 / 24 | sans | Card title, table group |
| `body-l` | 16 / 24 | sans | Lead paragraph |
| `body-m` | 14 / 20 | sans | Default body, table cells |
| `body-s` | 13 / 18 | sans | Secondary detail |
| `caption` | 12 / 16, tracking +0.4 | sans | Labels, metadata, table headers |
| `code` | 13 / 20 | mono | Code, keys, identifiers |

Negative tracking on headings only. Never on body or mono.

### 4. Shape, spacing, surfaces

- **Radius:** `sm` 6 (badges, small controls), `md` 10 (buttons, inputs), `lg` 14
  (cards, dialogs), `full` 999 (pills, avatars).
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 48 — and **each token is named by its
  value**: `--sh-space-16` is 16px. The previous scale was named by a skipping index
  (`space-1/2/3/4/6/8/12`), which made `--sh-space-5` read as a real token; it was
  written in five components that had no such thing, and an undefined custom
  property with no fallback voids the whole declaration, so five margins silently
  rendered as zero (D-414). 20 is on the scale because three components wanted it.
  A test asserts every spacing name equals its value.
- **Surfaces:** three levels — `bg` (page, and it is paper, never `#FFF`),
  `surface` (cards/panels), `surface-alt` (table headers, inline code). Popovers and
  menus use `surface` with `border-strong`.

**No drop shadows anywhere.** Depth comes from surface tint plus border weight. The
rule is enforced as *blur radius*, not as `box-shadow`, because the system requires
two zero-blur shadows: the focus ring and the active nav item's 3px accent bar
(D-180).

### 5. Component inventory

Every component below exists on the board with its variants drawn.

| Component | Variants | States |
|---|---|---|
| Button | primary, secondary, ghost, danger | default, hover, active, focus, disabled |
| Button sizes | sm 32, md 40, lg 48 | icon-only squares at each size |
| Text field | default, with helper, with prefix, read-only/copy | default, focus, error, disabled |
| Select / textarea | closed select, textarea | as text field |
| Checkbox | — | off, on, indeterminate, disabled |
| Radio | — | off, on |
| Switch | — | off, on, disabled |
| Badge · project state | READY, PROVISIONING, RESTORING, PAUSED, FAILED | dot + label, always both |
| Badge · plan | Free, Pro, Team | — |
| Badge · count | attention (accent), neutral | — |
| Banner | success, info, warning, error | with and without action |
| Toast | success, error | with and without action |
| Tooltip | — | — |
| Card · project | ready, paused (dimmed), failed (error border) | — |
| Card · stat | — | positive / negative delta |
| Table | — | row default, hover, selected; sortable header; row actions; pagination |
| Tabs | underline | active, inactive |
| Breadcrumb / segmented | — | — |
| Sidebar item | — | active (accent-subtle + 3px bar), hover, default |
| Project switcher | collapsed, open | selected row |
| Dialog | standard, destructive (type-to-confirm) | — |
| Code block | with header + copy | syntax-coloured |
| Empty state | — | — |
| Loading | progress bar, skeleton, spinner | — |

**Component rules that are binding, not stylistic:**

1. **One primary action per view.** The accent is the loudest thing on the page and must stay rare.
2. **State is never colour alone.** Every project state pairs a colour with a distinct text label; the table's selected row uses a left accent bar, not a tint alone. This survives colour-blindness and greyscale printing.
3. **Errors replace help text, never stack with it**, and are written as sentences containing a fix.
4. **Destructive actions require a confirmation dialog**, and project deletion requires typing the project name (mirrors D-038's 7-day recovery framing — the dialog states the recovery window).
5. **Hit areas are at least 40×40** even when the control is 18px.
6. **Minimum body size is 13px.** 12px is for labels and metadata only.
7. **Code is always mono on `ink/900`** with a copy affordance, in both light and dark themes.

### 6. Theming

Both themes ship. Dark is not an inversion — it is a second set of values for the
same role tokens.

**Implementation contract.** Role tokens are CSS custom properties on `:root`,
redefined under `[data-theme="dark"]` and under `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme="light"])`. Both dark blocks are required: an
explicit choice stamps the attribute, and the default "system" setting stamps
nothing at all, so a viewer on system-dark has nothing on `:root` to select.

Those blocks are **generated, not written** (D-418), and the test asserts their
bodies are identical. `light-dark()` would collapse them into one declaration and
was rejected for a specific reason: a custom property parses permissively, so an
unsupported `light-dark()` is accepted at parse time and fails at *substitution*
time, which unsets the colour instead of falling back to the light value — a broken
UI on an older browser rather than a degraded one.

Two things change between modes beyond the obvious:

- **Semantic colours swap direction** — deep-on-pale becomes light-on-deep.
- **Border weight does more work in dark**, because tint differences compress;
  `border` moves up one ramp step relative to surface.

And one thing deliberately does *not*: **the accent fill is the same value in both
themes** (D-417). Lifting it is what made the previous system's dark primary button
fail AA.

### 7. Accessibility floor

The floor is executable. Every row of §2's guarantee table is an assertion in
`tokens.test.ts`, and each was verified by breaking it and watching the build fail.
This section used to *state* that white on the accent cleared AA "which is what made
this accent viable" — a claim that was true of the light value, false of the dark
one, and unfalsifiable because prose does not run.

- Body text meets 4.5:1 against its surface; `text-muted` meets 4.5:1 against `bg`,
  `surface` **and** `surface-alt` — the last of which is the one that fails first,
  since a table header is the darkest light surface.
- Focus is a 2px accent ring plus an `accent-subtle` outer halo, at ≥3:1 against
  both `bg` and `surface` (WCAG 2.2). Never `outline: none`, never colour-only.
- Never colour as the sole carrier of meaning (D-180).
- A skeleton must be visible against the surface it loads on. Not an AA matter — a
  skeleton is not text — but at 1.09:1 a placeholder is indistinguishable from
  content that never arrived, which defeats one of §6's four required states.

## Decisions

**D-177 — Superseded by D-417.** ~~The brand accent is Electric Violet (`#7C3AED` light / `#8B5CF6` dark) with cool violet-tinted neutrals; the full token set and component inventory in this doc are binding for every Steadhold surface.~~ **Superseded by D-417:** the accent is Terracotta `#B4502E`, unlifted in dark, with warm clay neutrals. D-177's two practical criteria are preserved and are now executed as tests rather than asserted in prose — one of them was false of its own dark value. *(Rationale: it was the only candidate of five where white text clears AA contrast on the accent in both themes, removing per-mode label exceptions across every component; it collides with no semantic colour, where both green candidates conflated brand with success and cyan forced info off blue; and it differentiates from a market that is uniformly blue and green.)*

**D-178 — Light and dark are both first-class and ship together. Components reference semantic role tokens only, never ramp steps; dark mode is a second set of role values, not an inversion.** *(Rationale: retrofitting dark mode means auditing every component twice; naming role tokens from day one makes the second theme a config change instead of a redesign, and it is the only way the "accent lifts one step in dark" rule can be applied centrally.)*

**D-179 — No drop shadows in the system; elevation is surface tint plus border weight. ~~Type families are frozen at two: Inter for interface, JetBrains Mono for anything copyable.~~ Widened by D-419** to three: Zilla Slab (display/h1/h2, two weights), Space Grotesk (interface), JetBrains Mono (copyable). The no-shadow half stands, and is enforced as blur radius rather than as `box-shadow`. *(Rationale: shadows over tinted backgrounds read as grey smudges and would need a second scale for dark mode; two families keep the loading budget small and make the mono/UI distinction meaningful — mono signals "this is data you can copy", which is a real affordance in a database product.)*

**D-180 — State is never communicated by colour alone: every project state carries a distinct text label, and selection uses a left accent bar rather than a tint alone.** *(Rationale: project state is the most-read element in the dashboard (per [dashboard IA](01-dashboard-ia.md)); colour-only state fails colour-blind users, greyscale, and screenshots in support tickets.)*

## Open Questions

- **OQ-168** — Does the marketing site share this token set, or does it get a looser expressive palette (gradients, larger type scale) that the product deliberately does not use? Decide before the launch site is built.
- **OQ-169** — Icon library: adopt an existing set (Lucide is the shadcn default) or draw a small custom set for the ~30 product-specific concepts (project, pooler, replica, WAL, bucket)? Leaning Lucide plus a handful of custom marks; decide at Phase 7.
- **OQ-170** — Do we ship a `prefers-reduced-motion` contract now (the system currently specifies no motion at all) or defer until animation appears? Related: whether skeleton shimmer is animated.
- **OQ-171** — Whether the CLI colours its output to match this palette (violet accent in a terminal is legible on most themes but not all), or stays with terminal-default colours. Feeds [CLI spec](../10-cli-and-sdk/01-cli-spec.md).

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-025 dashboard stack, D-032 error envelope, D-038 deletion window), [dashboard IA](01-dashboard-ia.md) (nav structure, project states), [table editor](02-table-editor.md), [sql editor](03-sql-editor.md) (editor rails the code tokens serve)
- Feeds: [dashboard IA](01-dashboard-ia.md), [table editor](02-table-editor.md), [sql editor](03-sql-editor.md), [cli spec](../10-cli-and-sdk/01-cli-spec.md) (output colour), [sdk spec](../10-cli-and-sdk/03-sdk-spec.md) (error surfaces), [testing strategy](../13-quality/01-testing-strategy.md) (visual regression targets)
