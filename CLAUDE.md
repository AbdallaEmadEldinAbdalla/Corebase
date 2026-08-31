# Corebase — working rules

Read [STATUS.md](STATUS.md) first: it is the handover document and states what is
built, how to run it, and what is deliberately not built yet.

## Binding sources

- **[docs/00-foundation/05-decision-log.md](docs/00-foundation/05-decision-log.md)
  wins when two documents disagree.** If it is silent on a disagreement, that is a
  bug — file it in
  [docs/15-risks/02-open-questions.md](docs/15-risks/02-open-questions.md).
- Every decision made while building, rather than while planning, gets a new
  `D-xxx` row with its rationale and — where it narrows or overturns an earlier
  decision — a note saying so. Rows are never deleted.

## Definition of done, for every step

1. Tested, and **verified live** against the Docker staging stack — not just unit
   tests. A suite that needs infrastructure must say so in its filename
   (`*.e2e.test.ts`, D-223) and must fail rather than skip when it is missing.
2. **STATUS.md and README.md updated in the same step**, not later. STATUS.md's
   §4/§4b entry says what was built, what it broke, and what the verification was.
   §8 lists the gaps honestly.
3. **Split commits**, each tagged with its phase and step — `feat(P1/P1g): …`,
   `fix(P1/P1f): …`. Stage explicit paths, then check `git status` before
   committing: sweeping unrelated work into a commit has happened here more than
   once.
4. No step of the plan is skipped, and staging is Docker — never a paid host.

## UI work

**Every dashboard change runs the `ux-review` skill before it is committed**
(**D-224**). The standard is
[docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md); its
§8 is a 20-question gate, and a "no" is either fixed or recorded in STATUS.md as a
gap with its reason.

The visual layer is fixed and is not up for reinvention per screen: role tokens
from `apps/dashboard/src/styles/tokens.css`, components from `components.css`,
both rendered from the Pencil boards in `design-exports/`. **A stylesheet that
names a ramp step (`--cb-ink-700`) instead of a role token is a bug** (D-178), and
there are no drop shadows (D-179) — tests enforce both.

## Things this codebase will bite you with

- Node runs TypeScript with `--experimental-strip-types`, which **strips types
  without transpiling**. Parameter properties, enums and decorators fail at
  runtime while Vitest happily compiles them in tests. Don't use them.
- `exactOptionalPropertyTypes` is on: an explicit `undefined` is not an absent
  key. Spread optional fields conditionally.
- The dashboard is the exception to the no-build rule — Next.js compiles it, and
  `tsc --noEmit` passing does not mean `next build` will.
