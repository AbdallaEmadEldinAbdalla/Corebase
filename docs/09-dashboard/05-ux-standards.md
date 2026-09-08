# UX Standards

## Purpose

The interaction contract for every Steadhold surface. [Design system](04-design-system.md)
fixes what things *look* like; this fixes how they *behave* — and it exists because
the first dashboard shell was built without it and came out as a page router with
panels rather than a product: correct in every colour and wrong in every mechanic.

It is written as rules with reasons, and it ends in a
[checklist](#8-the-review-gate) that every UI change must pass before it ships.
The checklist is the enforcement; the rules are so the checklist is arguable.

The reference standard is deliberately named: **Supabase's dashboard**, whose depth
does not come from having more features. It comes from context that never
disappears, everything being reachable three ways, and every action answering for
itself. Those are shell properties. They can be met with four pages or forty, which
is why this document can be honoured *now*, with the small surface Phase 1 has, and
not deferred to a redesign at the end.

## Design

### 1. The shell is the product

Steadhold has exactly two levels of context — **organization** and **project** — and
a user is always inside a known position in that hierarchy.

- **Context is always visible and always switchable from where you are.** The
  breadcrumb is `org / project / section` and every segment is a switcher, not a
  label. Switching organization or project must never require going "up" to a list
  page first: a list page as the only way to switch is a detour the user did not
  ask for.
- **The chrome never re-renders on navigation within a context.** Moving between
  sections of a project repaints the content region only. A shell that flashes on
  every click reads as a page load, and page loads are what a dashboard exists to
  avoid.
- **The URL is the state.** Every view a user can reach is a URL they can send to a
  colleague, including which tab is open and which row is selected. State that
  cannot be linked is state that has to be explained in a support ticket.
- **A cold load lands on content, not on a chooser.** `/` resolves to the last
  place the user was. Asking "which organization?" on every visit is asking a
  question that has the same answer every time.

### 2. Reachability: pointer, keyboard, and the palette

Every action has to be reachable three ways. Not for accessibility compliance —
though it delivers that — but because the three correspond to three real users: the
newcomer who is looking, the regular who is typing, and the expert who knows the
name of the thing and wants it now.

- **The command palette (`⌘K` / `Ctrl+K`) is the spine**, not a search box bolted
  on. It navigates, switches organization and project, runs actions, and copies
  values. Everything a menu can do, the palette can do, and the palette is the
  cheapest place to add a capability so it is where new capabilities land first.
- **`g` then a letter** goes to a section. **`?`** lists every shortcut, because a
  shortcut nobody can discover is a shortcut for the author only.
- **`Esc` always closes the topmost layer** and returns focus to the control that
  opened it. Focus that lands on `<body>` after a dialog closes silently ejects a
  keyboard user to the top of the page.
- **No pointer-only affordances.** A hover-revealed row action must also be in the
  row's menu, and the menu must be keyboard-openable.
- **Focus is never removed, only replaced** — the design system's 2px ring plus
  halo (§7). `outline: none` without a replacement is a bug, and it is one that a
  mouse user will never report.

### 3. Reveal in place; navigate only when the subject changes

The most common way a dashboard wastes a user's attention is by navigating away to
show them something small.

- **The subject test.** If the user is still looking at the same thing, do not
  navigate: open a side panel, expand the row, or show a dialog. Changing project,
  or changing section within a project, is a subject change and *is* navigation.
  Inspecting one row, one key, one connection string is not.
- **A panel keeps its context on screen.** The list stays visible behind a detail
  panel so the user can see where they are and move to the next item without a
  round trip.
- **Dialogs are for decisions, panels are for detail.** A dialog blocks and must
  therefore ask something. A panel that blocks the page to show read-only text is a
  dialog that forgot it had nothing to ask.

### 4. Density is the default

The design system already says it — "dense by default: 52px rows, one action
column, state as a badge" — and the first shell ignored it in favour of large cards,
which is how three projects filled a screen that should hold twenty.

- **Tables for comparison, cards for identity.** More than six items, or more than
  three attributes worth comparing, is a table. Cards are for a small set of
  primary objects where recognising *which one* matters more than comparing them.
- **Where both are defensible, offer both and remember the choice.** The view
  toggle is per-user, persisted locally, and never resets.
- **One action column, one primary action per view.** The accent is the loudest
  thing on the page and must stay rare (design system §5 rule 1).
- **Never truncate silently.** A list that shows part of the data says how much and
  offers the rest. "1–20 of 143" is a sentence; twenty rows and no count is a lie
  of omission.

### 5. Every mutation answers for itself

- **The pressed control shows the pending state.** Not a page overlay, not a
  spinner in the corner: the button the user pressed. It also becomes
  non-resubmittable, because the second click is the user asking whether the first
  one worked.
- **Completion produces a toast that names what happened** and, where an inverse
  exists, offers it. "Project deleted · Undo" is worth more than a confirmation
  dialog, because it costs a careful user nothing and saves a careless one.
- **Destructive actions confirm by typing the object's name** (design system §5
  rule 4) and the dialog states what is recoverable and for how long. A confirm
  dialog that only says "Are you sure?" trains people to click through it.
- **Progress reports where the work is, not where it was started.** A create form
  hands off to the object being created; the object shows its own progress. The
  form is finished the moment the request is accepted.
- **Optimistic only when the inverse is cheap.** A rename can be optimistic. A
  create that allocates infrastructure cannot, and pretending otherwise means
  showing a project that may not exist.

### 6. Four states, all designed, on every data surface

A surface with an undesigned state is a bug that ships. There are exactly four and
each has a required shape:

| State | Required shape |
|---|---|
| **Loading** | A skeleton in the shape of the content it replaces (design system: "skeletons match the shape of the content they replace"). Never a centred spinner where a layout will appear — the layout jumping into place is the same cost as a page load. |
| **Empty** | Says what would be here, why it is not, and carries the action that fixes it. An empty state without its action is a dead end. |
| **Error** | Platform error `code`, a human sentence containing the fix, the `request_id` with a copy button, and Retry where retrying can help (D-032). No raw stack traces, ever. |
| **Partial** | When some of the data cannot be had, say which and why in one sentence, and render the rest. A blank panel looks broken; a panel that explains itself is honest (D-222). |

**Never show an error state for something still in progress.** A project mid-provision
renders skeletons and a progress banner, never a red panel — the IA is explicit, and
a panel that flashes red for two seconds on every create teaches distrust.

### 7. Words, numbers, and motion

- **Nouns match the CLI and the docs exactly.** If `steadhold db push` calls them
  migrations, the dashboard says migrations. A synonym invented for the UI is a
  second vocabulary users have to learn.
- **Second person, present tense, no marketing voice**, and no "Oops". An error
  names what failed and what to do.
- **Never invent a number.** If a metric has no source, the surface says so in a
  sentence rather than showing a plausible zero. A wrong number is worse than an
  absent one because it will be acted on.
- **Motion is functional and small**: 120–180 ms, `transform` and `opacity` only, to
  show where a layer came from. Nothing animates on load, nothing loops except an
  indeterminate progress indicator, and every transition is disabled under
  `prefers-reduced-motion: reduce` (**D-225**).

### 8. The review gate

Every UI change answers all of these, and a "no" is either fixed or written down as
a known gap with a reason. This is what the `ux-review` role runs.

**Context and navigation**
1. Can the user tell which organization and project they are in, without scrolling?
2. Can they switch either one from this screen, without going up a level first?
3. Is this view a URL that can be sent to someone else, tab and selection included?
4. Does the chrome stay put when navigating within the same context?

**Reachability**
5. Is every action here reachable by keyboard alone?
6. Is it in the command palette?
7. Does `Esc` close the topmost layer and return focus to what opened it?
8. Is there any affordance that only appears on hover and nowhere else?

**Shape**
9. Should this navigate at all, or is the subject unchanged and a panel correct?
10. Is a list of this size and shape a table or cards — and if arguable, is the choice remembered?
11. Is there exactly one primary action?
12. If the data is truncated, does the screen say by how much?

**Feedback**
13. Does the pressed control show pending, and refuse a second submit?
14. Does completion say what happened, and offer the inverse if one exists?
15. Is a destructive action confirmed by typing the name, with the recovery window stated?

**States**
16. Are all four states designed, and does the skeleton match the content's shape?
17. Does every error carry code, sentence, `request_id`, and copy?
18. Does anything in progress render as progress rather than as an error?

**Honesty**
19. Is every number on this screen real?
20. Does the nav contain anything that does not exist yet?

### 9. What this does *not* license

The gate is about the shell's mechanics, and passing it does not make a screen
good. It cannot tell whether the right thing is on the page, whether the default is
the one most people want, or whether the flow matches how the job is actually done.
Those need a human looking at the product, and this document is not a substitute for
that — it is the floor beneath it, so that judgement is spent on the interesting
half.

## Decisions

- **D-224 — This document is binding for every Steadhold UI surface, and §8's review gate runs on every UI change before it is committed. A "no" is either fixed or recorded as a known gap with its reason in [STATUS.md](../../STATUS.md).** *(Rationale: the first dashboard shell was built with the token layer honoured and no interaction contract at all, and it produced a page router with panels — the failure was not in any one screen but in the absence of a rule that would have caught all of them at once. A checklist run per change costs minutes and is the only mechanism that stays true as the surface grows from four pages to forty; a redesign at the end would instead mean rebuilding every screen twice.)*
- **D-225 — Motion is functional, 120–180 ms, `transform`/`opacity` only, and fully disabled under `prefers-reduced-motion: reduce`. Nothing animates on load and nothing loops except an indeterminate progress indicator. Resolves OQ-170.** *(Rationale: the design system specified no motion at all, which is safe for a static board and wrong for a shell — a panel that appears instantly gives the user no idea where it came from, and layers that arrive without direction are the main reason an interface feels abrupt rather than smooth. Bounding it to two GPU-composited properties and one duration band keeps it from becoming a second, undocumented design language, and the reduced-motion clause is not optional: vestibular disorders make unbounded motion an accessibility failure, not a taste question.)*
- **D-226 — The command palette (`⌘K`) and full keyboard reachability are shell requirements, not enhancements. Every capability a menu exposes must also be in the palette, and new capabilities land in the palette first.** *(Rationale: this is the single mechanic that makes a dashboard feel deep rather than wide, because it converts "learn where the button is" into "know what the thing is called" — and it is the cheapest surface to extend, so making it the default landing place for new actions means it stays complete instead of decaying into a search box that finds three things. Requiring it up front also forces every action to have a name and an invocable handler, which is what makes the same action scriptable in the CLI later.)*

## Open Questions

- **OQ-179 — Does the palette search *data* (projects by name and ref, and later tables and buckets) or only actions and destinations?** Data search means an API endpoint per searchable resource and a debounce contract; actions-only ships now and is a smaller promise. Leaning: destinations plus the user's own objects, since a project list is already loaded client-side. Decide before the surface grows past two searchable resource types.
- **OQ-180 — Where does a side panel's state live in the URL?** A query parameter (`?panel=key&id=…`) is simple and ugly; a nested route is clean and doubles the route count. Decide before the second panel is built, because retrofitting the first one is cheap and retrofitting five is not.
- **OQ-181 — Is there a density preference (comfortable/compact) or is dense the only mode?** Supabase ships one density. A preference is a second layout to test forever; leaning one mode until someone complains.

## Dependencies

- Builds on: [design system](04-design-system.md) (tokens, components, the a11y floor), [dashboard IA](01-dashboard-ia.md) (routes, the overview's zones, the paused-project experience), [platform API](../02-control-plane/02-platform-api.md) (the error envelope this depends on), [decision log](../00-foundation/05-decision-log.md)
- Feeds: every dashboard surface from Phase 1 onward — [table editor](02-table-editor.md), [sql editor](03-sql-editor.md), and the CLI's action vocabulary ([cli spec](../10-cli-and-sdk/01-cli-spec.md)), since D-226 forces every action to have a name
