# Design System

## Purpose

The visual and interaction contract for every Steadhold surface: dashboard, docs, marketing, and the CLI's terminal output where colour applies. It exists so that a component built in month nine looks like one built in month one, and so that state — the thing users actually read the dashboard for — is expressed the same way everywhere.

Scope is tokens plus a component inventory with variants. It does not prescribe implementation beyond the token contract; the dashboard stack is fixed elsewhere (D-025: Next.js + Tailwind + shadcn/ui).

The canonical artefact is the pair of design boards in Pencil (`pencil-new.pen`): frames **Steadhold Design System** (light) and **Steadhold Design System · Dark**, drawn from the same token set, plus five theme-exploration boards kept as the record of why violet won. This doc is the written source of truth for the values; the boards are the visual reference.

## Design

### 1. Brand decision

The accent is **Electric Violet** — `#7C3AED` in light, `#8B5CF6` in dark.

Chosen over coral, emerald, deep forest and cyan after building all five as full light/dark systems. The deciding factors were practical rather than aesthetic:

- **White text clears contrast on the accent in both modes.** It was the only candidate where this held. Cyan `#06B6D4` fails white at 2.6:1 and forces dark labels on every primary button; bright emerald and coral need dark labels in dark mode. Violet needs no per-mode exception, which removes a whole class of component special-casing.
- **No collision with any semantic colour.** Success green, warning amber, error red and info blue all stay unmistakable beside violet. Both green candidates conflated brand with success; cyan forced info to move to indigo.
- **Differentiation.** The managed-Postgres market is blue and green (Supabase, Neon, Firebase, Planetscale). Violet reads as neither.

### 2. Colour tokens

**Brand ramp**

| Token | Light | Dark |
|---|---|---|
| `violet/50` | `#F5F3FF` | `#2A1D4A` |
| `violet/100` | `#EDE9FE` | `#3A2A63` |
| `violet/300` | `#C4B5FD` | `#6D48C9` |
| `violet/500` | `#7C3AED` **accent** | `#7C3AED` |
| `violet/600` | `#6D28D9` hover | `#8B5CF6` **accent** |
| `violet/700` | `#5B21B6` active | `#A78BFA` hover |

**Neutrals** — cool, violet-tinted. Never pure grey; the faint violet cast is what makes the accent feel native rather than applied.

| Token | Light | Dark |
|---|---|---|
| `ink/50` | `#F7F6FB` | `#120F1A` |
| `ink/100` | `#EFECF8` | `#1A1526` |
| `ink/200` | `#E1DCF0` | `#241D33` |
| `ink/300` | `#C3BADF` | `#322847` |
| `ink/400` | `#8B82A3` | `#453A63` |
| `ink/500` | `#6B6285` | `#5D5080` |
| `ink/600` | `#4B4360` | `#8E85A8` |
| `ink/700` | `#2C2640` | `#BEB4D6` |
| `ink/800` | `#1F1A2E` | `#DDD6EE` |
| `ink/900` | `#16121F` | `#F3F0FA` |

**Semantic** — state colours, deliberately away from the brand hue. Light mode uses deep values on pale tints; dark mode inverts to light values on deep tints, or the banners glow.

| Token | Light | Light bg | Dark | Dark bg |
|---|---|---|---|---|
| `success` | `#1E9E6A` | `#E4F5EE` | `#4ADE80` | `#0F2E1E` |
| `warning` | `#C77A02` | `#FDF1DC` | `#FBBF24` | `#2E2410` |
| `error` | `#B3261E` | `#F9E3E1` | `#F87171` | `#2E1614` |
| `info` | `#2F6FB5` | `#E4EEF8` | `#60A5FA` | `#12233A` |

**Semantic role tokens** — components reference these, never raw ramp steps:

| Role | Light | Dark |
|---|---|---|
| `bg` | `ink/50` | `ink/50` (dark scale) |
| `surface` | `#FFFFFF` | `ink/100` |
| `surface-alt` | `ink/100` | `ink/200` |
| `border` | `ink/200` | `ink/300` |
| `border-strong` | `ink/300` | `ink/400` |
| `text` | `ink/900` | `ink/900` (dark scale) |
| `text-secondary` | `ink/600` | `ink/700` |
| `text-muted` | `ink/400` | `ink/600` |
| `accent-subtle` | `violet/100` | `violet/50` (dark scale) |
| `on-accent` | `#FFFFFF` | `#FFFFFF` |

**Binding rule:** `error` must never be a hue the brand also uses. This is why a red-adjacent brand accent was rejected during the coral round — a destructive action and a primary action must never be confusable.

### 3. Typography

Two families only.

- **Inter** — everything in the interface. `Inter, system-ui, sans-serif`. Weights 400 / 500 / 600 / 700.
- **JetBrains Mono** — anything the user may copy or is authoring: SQL, connection strings, API keys, project refs, request IDs, log lines. `"JetBrains Mono", monospace`.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `display` | 32 / 40, tracking −0.6 | bold | Page hero, empty states |
| `heading/1` | 24 / 32, tracking −0.4 | bold | Page title |
| `heading/2` | 20 / 28, tracking −0.2 | semibold | Section title |
| `heading/3` | 16 / 24 | semibold | Card title, table group |
| `body/l` | 16 / 24 | normal | Lead paragraph |
| `body/m` | 14 / 20 | normal | Default body, table cells |
| `body/s` | 13 / 18 | normal | Secondary detail |
| `caption` | 12 / 16, tracking +0.4 | medium | Labels, metadata, table headers |
| `code` | 13 / 20 | normal | Code, keys, identifiers (mono) |

Negative tracking on headings only. Never on body or mono.

### 4. Shape, spacing, surfaces

- **Radius:** `sm` 6 (badges, small controls), `md` 10 (buttons, inputs), `lg` 14 (cards, dialogs), `full` 999 (pills, avatars).
- **Spacing:** 4-point scale — 4, 8, 12, 16, 24, 32, 48. 16 is the default gutter, 24 separates groups, 32+ separates sections.
- **Surfaces:** three levels — `bg` (page), `surface` (cards/panels), `surface-alt` (table headers, inline code, skeletons). Popovers and menus use `surface` with `border-strong`.

**No drop shadows anywhere.** Depth comes from surface tint plus border weight. Shadows over a tinted background read as grey smudges, and the token set stays legible in both modes without a second shadow scale.

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

Both themes ship. Dark is not an inversion — it is a second set of values for the same role tokens.

Implementation contract: role tokens as CSS custom properties on `:root`, redefined under `[data-theme="dark"]` and under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`. Components reference role tokens only. A component that names a ramp step directly is a bug.

Three things that change between modes beyond the obvious:

- **Semantic colours swap direction** — deep-on-pale becomes light-on-deep.
- **Border weight does more work in dark**, because tint differences compress; `border` moves up one ramp step relative to surface.
- **The accent lifts one step** (`violet/500` → `violet/600`) so it holds against a dark surface.

### 7. Accessibility floor

- Body text meets 4.5:1 against its surface; `text-muted` is reserved for non-essential metadata and meets 4.5:1 against `bg`.
- White on `violet/500` is 4.6:1 — clears AA for normal text, which is what made this accent viable.
- Focus is a 2px accent ring plus a `violet/100` outer halo — never outline-none, never colour-only.
- Never colour as the sole carrier of meaning (rule 2 above).

## Decisions

**D-177 — The brand accent is Electric Violet (`#7C3AED` light / `#8B5CF6` dark) with cool violet-tinted neutrals; the full token set and component inventory in this doc are binding for every Steadhold surface.** *(Rationale: it was the only candidate of five where white text clears AA contrast on the accent in both themes, removing per-mode label exceptions across every component; it collides with no semantic colour, where both green candidates conflated brand with success and cyan forced info off blue; and it differentiates from a market that is uniformly blue and green.)*

**D-178 — Light and dark are both first-class and ship together. Components reference semantic role tokens only, never ramp steps; dark mode is a second set of role values, not an inversion.** *(Rationale: retrofitting dark mode means auditing every component twice; naming role tokens from day one makes the second theme a config change instead of a redesign, and it is the only way the "accent lifts one step in dark" rule can be applied centrally.)*

**D-179 — No drop shadows in the system; elevation is surface tint plus border weight. Type families are frozen at two: Inter for interface, JetBrains Mono for anything copyable.** *(Rationale: shadows over tinted backgrounds read as grey smudges and would need a second scale for dark mode; two families keep the loading budget small and make the mono/UI distinction meaningful — mono signals "this is data you can copy", which is a real affordance in a database product.)*

**D-180 — State is never communicated by colour alone: every project state carries a distinct text label, and selection uses a left accent bar rather than a tint alone.** *(Rationale: project state is the most-read element in the dashboard (per [dashboard IA](01-dashboard-ia.md)); colour-only state fails colour-blind users, greyscale, and screenshots in support tickets.)*

## Open Questions

- **OQ-168** — Does the marketing site share this token set, or does it get a looser expressive palette (gradients, larger type scale) that the product deliberately does not use? Decide before the launch site is built.
- **OQ-169** — Icon library: adopt an existing set (Lucide is the shadcn default) or draw a small custom set for the ~30 product-specific concepts (project, pooler, replica, WAL, bucket)? Leaning Lucide plus a handful of custom marks; decide at Phase 7.
- **OQ-170** — Do we ship a `prefers-reduced-motion` contract now (the system currently specifies no motion at all) or defer until animation appears? Related: whether skeleton shimmer is animated.
- **OQ-171** — Whether the CLI colours its output to match this palette (violet accent in a terminal is legible on most themes but not all), or stays with terminal-default colours. Feeds [CLI spec](../10-cli-and-sdk/01-cli-spec.md).

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-025 dashboard stack, D-032 error envelope, D-038 deletion window), [dashboard IA](01-dashboard-ia.md) (nav structure, project states), [table editor](02-table-editor.md), [sql editor](03-sql-editor.md) (editor rails the code tokens serve)
- Feeds: [dashboard IA](01-dashboard-ia.md), [table editor](02-table-editor.md), [sql editor](03-sql-editor.md), [cli spec](../10-cli-and-sdk/01-cli-spec.md) (output colour), [sdk spec](../10-cli-and-sdk/03-sdk-spec.md) (error surfaces), [testing strategy](../13-quality/01-testing-strategy.md) (visual regression targets)
