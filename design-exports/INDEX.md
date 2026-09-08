# Steadhold Design System — exports

Rendered from the Pencil boards (`pencil-new.pen`) at **2x**. Accent: Electric Violet (D-177).
Written source of truth for the values: [`docs/09-dashboard/04-design-system.md`](../docs/09-dashboard/04-design-system.md).

```
00-boards/
  .DS_Store
  design-system-dark.png
  design-system-light.png
  themes/
    coral-dark.png
    coral-light.png
    cyan-dark.png
    cyan-light.png
    deep-forest-dark.png
    deep-forest-light.png
    electric-violet-dark.png
    electric-violet-light.png
    emerald-dark.png
    emerald-light.png
01-foundations/
  .DS_Store
  dark/
    colour.png
    shape-spacing-surfaces.png
    typography.png
  light/
    colour.png
    shape-spacing-surfaces.png
    typography.png
02-sections/
  .DS_Store
  dark/
    badges-status.png
    buttons.png
    cards.png
    feedback.png
    forms.png
    navigation.png
    overlays-code-states.png
    table.png
  light/
    badges-status.png
    buttons.png
    cards.png
    feedback.png
    forms.png
    navigation.png
    overlays-code-states.png
    table.png
03-components/
  .DS_Store
  dark/
    badge-count.png
    badge-plan.png
    badge-project-state.png
    banner-error.png
    banner-info.png
    banner-success.png
    banner-warning.png
    breadcrumb.png
    button-icon-only.png
    button-in-context.png
    button-sizes.png
    button-states-primary.png
    button-states-secondary.png
    button-variants.png
    card-project-failed.png
    card-project-paused.png
    card-project-ready.png
    card-stat-negative.png
    card-stat-neutral.png
    card-stat-positive.png
    checkbox-all-states.png
    code-block.png
    dialog-destructive.png
    empty-state.png
    field-copy-readonly.png
    field-default.png
    field-disabled.png
    field-error.png
    field-focus.png
    loading-progress-skeleton.png
    pagination.png
    project-switcher.png
    radio.png
    segmented-control.png
    select.png
    sidebar.png
    status-inline-dot.png
    switch.png
    table-full.png
    table-header-row.png
    table-row-selected.png
    tabs.png
    textarea.png
    toast-error.png
    toast-success.png
    tooltip.png
    validation-inline.png
  light/
    badge-count.png
    badge-plan.png
    badge-project-state.png
    banner-error.png
    banner-info.png
    banner-success.png
    banner-warning.png
    breadcrumb.png
    button-icon-only.png
    button-in-context.png
    button-sizes.png
    button-states-primary.png
    button-states-secondary.png
    button-variants.png
    card-project-failed.png
    card-project-paused.png
    card-project-ready.png
    card-stat-negative.png
    card-stat-neutral.png
    card-stat-positive.png
    checkbox-all-states.png
    code-block.png
    dialog-destructive.png
    empty-state.png
    field-copy-readonly.png
    field-default.png
    field-disabled.png
    field-error.png
    field-focus.png
    loading-progress-skeleton.png
    pagination.png
    project-switcher.png
    radio.png
    segmented-control.png
    select.png
    sidebar.png
    status-inline-dot.png
    switch.png
    table-full.png
    table-header-row.png
    table-row-selected.png
    tabs.png
    textarea.png
    toast-error.png
    toast-success.png
    tooltip.png
    validation-inline.png
04-fonts/
  font-weights-inter-dark.png
  font-weights-inter-light.png
  specimen-inter-dark.png
  specimen-inter-light.png
  specimen-jetbrains-mono-dark.png
  specimen-jetbrains-mono-light.png
  type-scale-dark.png
  type-scale-light.png
05-palette/
  .DS_Store
  dark/
    palette-brand-violet.png
    palette-neutral-ink.png
    palette-semantic.png
  light/
    palette-brand-violet.png
    palette-neutral-ink.png
    palette-semantic.png
06-tokens/
  colours.json
  tokens.css
  typography.json
```

## What is where

| Folder | Contents |
|---|---|
| `00-boards/` | The two full system boards (light, dark) and the five theme explorations. `themes/` holds each theme's light and dark column on its own. |
| `01-foundations/` | Colour, typography and shape/spacing/surfaces sections — light and dark. |
| `02-sections/` | The eight component sections as full strips — light and dark. |
| `03-components/` | Every component cropped on its own (40 per theme) — light and dark. |
| `04-fonts/` | Inter and JetBrains Mono specimens, the nine-step type scale, and the Inter weight row. |
| `05-palette/` | Brand ramp, neutral ramp and semantic pairs as separate images — light and dark. |
| `06-tokens/` | `tokens.css` (CSS custom properties, both themes), `colours.json`, `typography.json`. |

## Using the tokens

`tokens.css` is drop-in. Components must reference **role** tokens (`--sh-surface`, `--sh-text`, `--sh-accent`), never ramp steps — that is what makes dark mode a config change rather than a second design pass (D-178).

Three values behave differently than a naive inversion would suggest:

- The accent **lifts one ramp step** in dark (`violet/500` → `violet/600`) so it holds against a dark surface.
- `--sh-danger` (button fill) is **darker** than `--sh-error` (text/icon colour) in dark mode, so white labels keep contrast on destructive buttons.
- There is **no shadow scale**. Elevation is surface tint plus border weight (D-179).

## HTML reference

`07-html/index.html` renders every component from `tokens.css` + `components.css`, each with its markup
beside it, and a theme toggle that flips the whole page — because components reference role tokens only,
that toggle *is* the entirety of dark mode.

Open it over a local server so the relative CSS links resolve:

```
cd design-exports/07-html && python3 -m http.server 8000
```

Opening `index.html` straight from the filesystem works in most browsers too. Fonts load from Google
Fonts when online and fall back to `system-ui` / `ui-monospace` offline.

`components/<name>.html` is a standalone file per component — useful for copying one thing into a
codebase, or diffing a component in isolation.
