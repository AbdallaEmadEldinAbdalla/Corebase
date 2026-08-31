---
name: ux-review
description: Run the Corebase UX review gate on a dashboard change. Use before committing any UI work — new screens, changed screens, or a new component — and when asked to audit an existing surface. Checks the 20 questions in docs/09-dashboard/05-ux-standards.md §8 against the actual code and, where a browser is available, against the running app.
---

# UX review

You are reviewing a Corebase UI surface against a written standard. The standard is
**[docs/09-dashboard/05-ux-standards.md](../../../docs/09-dashboard/05-ux-standards.md)** —
read it before reviewing, every time, because it changes as the product grows.

The reference bar is Supabase's dashboard: depth from context that never
disappears, everything reachable three ways, every action answering for itself.

## How to run it

1. **Read the standard** (`docs/09-dashboard/05-ux-standards.md`), then the
   [design system](../../../docs/09-dashboard/04-design-system.md) §5 component rules
   and [dashboard IA](../../../docs/09-dashboard/01-dashboard-ia.md) for the routes
   and the states this surface can be in.
2. **Read the code under review.** Not a summary of it — the actual components,
   including their loading, empty, error and partial branches.
3. **Run the 20 questions in §8** against it. Answer each one with the file and
   line that makes it true or false, never with an impression.
4. **Drive the running app** if a browser is available: the gate has questions no
   static read can answer (does `Esc` restore focus, does the chrome flash on
   navigation, does the skeleton match the content's shape). Log in, use the
   surface, use it with the keyboard only, and look at both themes.
5. **Report.** Every "no" is either fixed in the same change or recorded in
   STATUS.md as a known gap with its reason. There is no third option — an
   unrecorded "no" is how the standard decays.

## Rules for the review itself

- **Cite, don't assert.** "Q7 fails: `AppShell.tsx:41` closes the menu on Escape
  but never returns focus to the trigger" is a finding. "Focus management could be
  better" is not.
- **A green gate is not a good screen.** Say so in the report (§9). The gate is the
  floor; whether the right thing is on the page is a separate judgement and worth
  stating separately.
- **Check the honesty questions hardest** (19, 20). An invented number or a nav item
  for something unbuilt is the failure that damages trust rather than convenience,
  and it is the one most likely to be defended as "a placeholder".
- **Prove a guard before trusting it.** If a rule is enforced by a test, break the
  rule and watch the test fail. A guard that passes while matching nothing has
  happened in this repo more than once.
- **Density and reveal-in-place are the two most commonly failed.** The instinct is
  to give each thing a card and each detail a page. Check §3's subject test and §4's
  table-vs-cards threshold explicitly, on every list and every detail view.

## Output

A short report, in this order:

1. **Verdict** — pass, or the count of failures by section.
2. **Failures** — one line each: question number, what is wrong, file:line, and the
   fix.
3. **Fixed in this change** / **Recorded as a gap** — where each failure went.
4. **Beyond the gate** — anything you noticed that no question covers. This section
   is where the actual design judgement goes, and it should rarely be empty.
