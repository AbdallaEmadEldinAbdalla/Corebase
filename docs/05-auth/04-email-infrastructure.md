# Email Infrastructure

## Purpose

The subsystem the v0.1 proposal missed entirely ([critical review §2.3 and §3](../00-foundation/03-critical-review.md)): auth is dead without deliverable email. Every flow in [flows](03-flows.md) that matters — signup verification, password recovery, email change, security notifications — terminates in an inbox. If those mails land in spam, Corebase Auth is broken *from the customer's point of view* regardless of how correct the token protocol is; and because V1 sends from **shared** Corebase infrastructure, one abusive project can poison deliverability for every project. This doc specifies the V1 sending architecture, the DNS/authentication setup, the abuse containment, bounce handling, templates, and monitoring.

## Design

### Why this is a real subsystem

- **Deliverability is adversarial and stateful**: inbox providers score the sending domain and IPs on history. It cannot be bolted on after launch — reputation is earned over weeks (warm-up) and destroyed in hours (spam burst).
- **Auth email is a spam vector by construction**: `/signup` and `/recover` let any anonymous visitor cause Corebase to email an arbitrary address. Multiply by N projects with N attack surfaces, all sharing one sending reputation → the tightest abuse coupling in the platform ([abuse prevention](../12-business/03-abuse-prevention.md)).
- **It is on the provisioning critical path**: a new project must be able to send a verification email in its first five minutes (proposal §80) with zero email setup by the developer.

### V1 architecture

```text
auth module ── enqueue email job (BullMQ, D-018; idempotency key = one_time_token id)
   │
   ▼
worker ── render template (per-project overrides + variables, escaped)
   │
   ▼
EmailProvider interface ── send({from, to, subject, html, text, tag, metadata})
   │                          │
   │  primary: Postmark ──────┘   (transactional message stream)
   │
   ◀── webhooks: delivery / bounce / complaint ──▶ suppression lists + metrics
```

- Sending is **asynchronous** (queue + worker): an email-provider outage must never fail a signup request ([flows](03-flows.md) return 200 and retry sends). Retries: 3 attempts, exponential backoff 30 s/5 min/30 min, then dead-letter + alert (D-018 semantics).
- **From**: `Corebase Auth <auth@mail.corebase.co>` — with the project's name in the friendly-from and templates, e.g. `"Acme (via Corebase)"`, so recipients see whose app is talking. `Reply-To` optionally per-project config.
- **`mail.corebase.co` is a dedicated sending subdomain**: its reputation is isolated from `corebase.com` (corporate mail) and `corebase.co` (data-plane API hosts). If auth-mail reputation is damaged, the company domain is not.

### Provider choice (D-115)

| | Postmark | Resend | Amazon SES |
|---|---|---|---|
| Deliverability | **Best-in-class for transactional**; separate transactional/broadcast streams enforced by policy; aggressive about ejecting spammers from shared IPs | Good, younger network; less enforcement history | Entirely what you make of it — raw pipes; shared IPs mediocre, dedicated IPs need warm-up and ops |
| Price (order of magnitude) | ~$15/10k, ~$1.25/1k at volume — priciest | ~$20/50k tier — middle | ~$0.10/1k — cheapest by ~10× |
| API/DX | Mature REST, message streams, first-class bounce/complaint webhooks, template API | Modern DX, React-email tooling (irrelevant server-side) | Verbose (SESv2), SNS-based webhooks — assembly required |
| Ops burden on us | Minimal — reputation management is their product | Low | High: reputation, feedback loops, warm-up, suppression are **our** job |
| Lock-in risk | Low behind our interface | Low | Lowest cost at scale = the eventual destination |

**Pick: Postmark as the V1 primary** — *and not yet built: see D-331. The interface is, and the SMTP implementation behind it sends to a Mailpit container locally and in CI, which is the same substitution MinIO makes for R2. Postmark is a config-and-credentials task; what it is not is verifiable without an account and a domain.* At V1 volume (thousands of mails/day, not millions) the ~10× unit-price premium over SES is noise in absolute dollars, while its transactional-only enforcement and deliverability track record are exactly the property we cannot build ourselves in launch quarter. The economics lane (D-006, D-023) points at SES **at scale** — that is why sending goes through an **`EmailProvider` interface** (send, verify-domain, normalize webhook events) with the provider chosen by config, so cutting over to SES (or per-region providers) is a config-and-warm-up project, not a rewrite. This mirrors the D-005 pattern: compose the proven thing, keep the exit.

### DNS & authentication for `mail.corebase.co`

All records managed in Terraform via the Cloudflare provider (D-022, D-023):

| Record | Value (Postmark) | Purpose |
|---|---|---|
| `TXT mail.corebase.co` | `v=spf1 include:spf.mtasv.net -all` | SPF: only Postmark's MTAs may send as this domain; `-all` hard-fails everything else |
| `CNAME <selector>._domainkey.mail.corebase.co` | provider-issued DKIM key | DKIM: cryptographic signature over headers/body; the primary reputation identity |
| `TXT _dmarc.mail.corebase.co` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@corebase.com; adkim=s; aspf=s` | DMARC: alignment enforcement + aggregate reports; move `p=quarantine` → `p=reject` after 30 clean days |
| `CNAME pm-bounces.mail.corebase.co` | provider return-path host | Aligned custom Return-Path so SPF alignment passes |

Also: MX + real mailbox (or route) for `auth@mail.corebase.co` — a sending address that hard-bounces replies looks like a spammer; route replies to support tooling. Warm-up plan: start on Postmark shared IPs (correct at low volume); dedicated IP only when sustained volume exceeds ~50k/month (OQ-116).

### Custom SMTP per project — V1.1, not V1 (D-117)

Projects will want auth mail from **their own domain** (`noreply@acme.com`). That feature is: per-project SMTP credentials (host, port, username, password — envelope-encrypted per D-035), a test-send validation step, fallthrough policy when their SMTP fails, and support tickets about *their* DNS. None of it gates launch, and it is also the **pressure valve for abuse and customization**: once a project sends via its own SMTP, its reputation is its own, and template freedom can be unlocked (below). Decision: **V1.1**, immediately after launch stabilizes — it is the top ask from any serious production user, cheap to build against the `EmailProvider` interface (an `SmtpProvider` implementation), and it drains risk out of the shared pool.

### Abuse containment on the shared domain (D-116)

Threat: an attacker creates a free project and uses `/signup`//`/recover` as a free bulk-mailer (or to "mail-bomb" a victim address), burning `mail.corebase.co`'s reputation for everyone. Controls, layered:

**Per-project email rate caps** (enforced at enqueue time, Redis counters; separate from the per-endpoint request limits in [flows](03-flows.md)). *Built in P4d, with the ordering and the concurrency behaviour pinned by tests — see D-334; the counters are `INCR`-then-compare, and the per-recipient key is a hash of the address (D-337).*

| Plan | Emails/hour | Emails/day | Distinct recipients/day | Same recipient |
|---|---|---|---|---|
| Free | **30** | **200** | 100 | max 4/hour, 10/day |
| Pro | 200 | 2,000 | 1,000 | max 8/hour |
| Team | 500 | 10,000 | 5,000 | max 8/hour |
| Custom SMTP (V1.1) | project's own — caps off | — | — | — |

Cap hit → email silently queued-then-dropped for enumeration-sensitive flows (the HTTP response was already same-shape 200), `email_rate_limited` audit row + dashboard warning for the developer. Sustained cap-hitting trips the abuse-review pipeline ([abuse prevention](../12-business/03-abuse-prevention.md)).

**Content is fixed templates only in V1**: projects can override template *text* (subject and body copy) but the output is rendered from Corebase-controlled layouts with **variable interpolation only — no arbitrary HTML, no arbitrary links**. Every URL in an auth mail is constructed by Corebase from the project's validated `site_url`/redirect allowlist. This kills the phishing kit use-case (attacker cannot make Corebase send arbitrary content from a reputable domain). Full HTML freedom arrives only with custom SMTP (V1.1), where the sender reputation at stake is the project's own.

**New-project throttle**: projects < 24 h old on Free get half caps; unverified platform accounts (control-plane email not confirmed) cannot send at all — their projects won't provision anyway ([platform API](../02-control-plane/02-platform-api.md)).

### Bounce & complaint handling

*Built in P4d: the two suppression lists, and the enqueue-time check that consults them. **Not** built: the webhook endpoint that would populate them, because there is no provider sending webhooks — so today a suppression arrives only by an operator inserting a `manual` row. The complaint score, the ≥3-project global promotion and the auto-pause thresholds are all part of that same unbuilt half.*

Provider webhooks → `POST api.corebase.com/v1/webhooks/email` (signature-verified) → normalized events:

1. **Hard bounce** (mailbox doesn't exist): add `(project_id, email)` to the **per-project suppression list** (control-plane table `email_suppressions`); further sends to that address for that project are dropped at enqueue. Surfaced in the project dashboard (developers must be able to see "why didn't my user get the email" — and to clear an entry after a fix).
2. **Spam complaint**: suppress per-project **and increment the project's complaint score**; complaints are the strongest reputation poison.
3. **Repeated hard bounces across projects** for one address (≥3 projects): add to the **global suppression list** — the address is a trap or dead; protects the shared domain.
4. Suppression check order at enqueue: global list → project list → rate caps → send.

### Template system

Five V1 templates: `confirmation`, `recovery`, `email_change_current`, `email_change_new`, `password_changed_notice` (plus `magic_link` reserved for V1.1). *All five exist in P4d, plus a sixth the flows doc asks for and this list omitted — `account_exists_notice`, Flow 1 step 3b. Only `confirmation`, `recovery` and that notice are reachable, because nothing emits the other three until their flows are built; a rendering test covers all six so a variable named in a template but absent from the type fails immediately rather than at send time.* Each per-project override is `{subject, body}` in a constrained template dialect; rendering produces **both HTML (fixed layout, inlined CSS) and plaintext** parts (multipart/alternative — text-only clients and spam scoring both want the text part).

Variables (GoTrue-compatible names, easing migration):

| Variable | Value |
|---|---|
| `{{ .ConfirmationURL }}` | Full validated action link (`/auth/v1/verify?...` with allowlisted redirect) |
| `{{ .Token }}` | The one-time token alone (for apps that build their own deep link / show a code) |
| `{{ .SiteURL }}` | Project `site_url` |
| `{{ .Email }}` | Recipient address |
| `{{ .NewEmail }}` | Proposed address (email-change templates only) |
| `{{ .ProjectName }}` | Display name |

All interpolation is HTML-escaped; unknown variables fail validation at save time (dashboard), not send time.

### Deliverability monitoring

Metrics per project and global, via provider webhooks + API, into Prometheus (D-021): sent, delivered, hard/soft bounce rate, complaint rate, time-to-delivery.

| Signal | Threshold | Action |
|---|---|---|
| Project bounce rate (24 h, ≥50 sends) | > 5 % | Dashboard warning to developer |
| Project bounce rate | > 10 % | Auto-pause project email + abuse review |
| Project complaint rate | > 0.1 % | Auto-pause project email + abuse review |
| **Global** bounce rate | > 2 % | Page on-call — shared reputation is at risk |
| **Global** complaint rate | > 0.05 % | Page on-call |
| DMARC aggregate reports | weekly review | Catch spoofing / misconfig drift |

A canary account at each major inbox provider (Gmail, Outlook, Yahoo) receives a synthetic verification mail daily; landing in spam = alert. Cheap, catches reputation decay before customers do.

## Decisions

- **D-115 — Transactional email ships V1 on Postmark (transactional message stream) behind an `EmailProvider` interface (send, domain verification, normalized webhook events); SES is the designated at-scale migration target behind the same interface. Sending identity is the dedicated subdomain `mail.corebase.co` (`auth@mail.corebase.co`) with SPF `-all`, DKIM, and DMARC (quarantine → reject after 30 clean days).** *(Rationale: at launch volume the price delta to SES is absolute pennies while Postmark's transactional-only enforcement buys the deliverability track record we cannot earn in time; the interface plus subdomain isolation keep both the provider exit (D-005/D-006 economics) and the company domain's reputation intact.)*
- **D-116 — Shared-infrastructure email is capped per project (Free 30/hour, 200/day, 100 distinct recipients/day, ≤4/hour to one address; Pro/Team scaled per the table) and its content is fixed templates only: per-project subject/body text with escaped variable interpolation, no arbitrary HTML or links — all URLs constructed by Corebase from the validated redirect allowlist. Hard bounces and complaints feed per-project suppression lists plus a global list; >10 % bounce or >0.1 % complaint auto-pauses a project's email pending review.** *(Rationale: on a shared sending domain every project's abuse is every project's spam-folder problem; caps bound the blast radius, fixed templates remove the phishing payload, and suppression + auto-pause keep one bad actor from burning the domain for all.)*
- **D-117 — Custom per-project SMTP is V1.1, not V1: projects configure their own SMTP credentials (envelope-encrypted per D-035) to send from their own domain, at which point the shared caps and the fixed-template restriction no longer apply to them.** *(Rationale: it gates nothing at launch, but it is the top production ask and the structural pressure valve — moving serious senders onto their own reputation shrinks the shared-pool risk; building it against the provider interface is small.)*

### Decided while building (P4d)

- **D-331 — The `EmailProvider` interface ships with an SMTP implementation and no Postmark client; local and CI sending goes to a Mailpit container.** *(Rationale: D-115's load-bearing half is the interface, and it is built. A Postmark client with no account and no verified domain behind it is untested code on the one path where failure is silent and reaches users. SMTP is the shape D-117 needs anyway, and Mailpit stands in for the provider as MinIO stands in for R2 — a real listener, so our own conversation, headers and MIME structure are what get exercised. Deliverability is what the substitute cannot exercise, so Phase 4's third exit criterion stays **unmet** rather than being declared met against a sink.)*
- **D-332 — The SMTP client is hand-written and sends one message per connection.** *(Rationale: one narrow conversation is all that is needed, a general-purpose mailer brings a dependency tree for none of it, and every dependency has to survive `--experimental-strip-types`. One message per connection cannot half-fail in a way that leaves the next message ambiguous, which is the failure mode that produces duplicate mail.)*
- **D-333 — A display name is quoted, and both MIME parts are base64.** *(Rationale: `Acme (via Corebase) <auth@…>` unquoted parses as the display name "Acme" plus an RFC 5322 *comment* — the live sink caught it — and the "via Corebase" half is what keeps us from claiming to be the customer while sending from our own domain. base64 removes the quoted-printable line-length and trailing-whitespace bug class and makes dot-stuffing a formality.)*
- **D-334 — Caps and suppression are checked at enqueue, suppression first, with `INCR`-then-compare and a rollback on refusal.** *(Rationale: enqueue-time refuses a burst while it is one Redis round trip rather than filling the queue whose drain rate the caps protect. Suppression first, or a mail-bomb at a suppressed address consumes the project's whole budget without a message being sent. `GET`-then-`INCR` lets two concurrent enqueues both read 29 against a cap of 30; an interrupted rollback under-sends slightly, which is the right direction to be wrong in.)*
- **D-335 — `email_sends` is the row of record, and idempotency lives there rather than in the queue.** *(Rationale: BullMQ deduplicates a duplicate enqueue; duplicate *mail* comes from a worker that sends and dies before recording. The remaining window is irreducible without provider-side idempotency keys but is not silent — `attempts` shows the retry. The table also answers "why did my user get no mail", which a queue cannot, and `suppressed` versus `rate_limited` mean opposite things to a developer.)*
- **D-336 — Retries are 30 s / 5 min / 30 min via a custom backoff strategy; a non-retryable failure is dead-lettered on the first attempt.** *(Rationale: BullMQ's `exponential` would give 30 s / 1 min / 2 min and spend the budget in three minutes, shorter than the outage it exists to survive. Retrying a refused recipient or an unrenderable template delays real mail and changes nothing; not retrying a reset drops a verification mail on a blip.)*
- **D-337 — Per-recipient counter keys are hashed, and the auth-email queue is separate from provisioning.** *(Rationale: Redis keys appear in `MONITOR`, slowlogs, dumps and any `--scan`, so a plaintext key exposes every end-user address on the platform. The separate queue keeps a provider outage's worth of retrying email out of the way of every project waiting to be created.)*

## Open Questions

- **OQ-116** — Dedicated sending IP: at what sustained volume (provisional trigger ~50k/month) do we move from Postmark's shared pool to a dedicated IP, and who owns the warm-up schedule? Revisit when metering exists ([cost model](../12-business/01-cost-model.md)).
- **OQ-117** — Do security-notice emails (`password_changed_notice`, new-login notice later) count against per-project caps? Leaning **no** (attacker-triggerable only via already-authenticated actions, and suppressing them harms the victim), but exempting any template class weakens the cap invariant — decide with [abuse prevention](../12-business/03-abuse-prevention.md).

## Dependencies

- Builds on: [01-auth-architecture.md](01-auth-architecture.md), [03-flows.md](03-flows.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-005, D-006, D-018, D-021, D-022, D-023, D-035), [../02-control-plane/04-job-queue-and-workers.md](../02-control-plane/04-job-queue-and-workers.md)
- Feeds: [../12-business/03-abuse-prevention.md](../12-business/03-abuse-prevention.md), [../12-business/01-cost-model.md](../12-business/01-cost-model.md) (per-mail unit cost), [../11-infrastructure/03-observability.md](../11-infrastructure/03-observability.md) (deliverability dashboards/alerts), [05-oauth-and-future.md](05-oauth-and-future.md) (magic links reuse this pipeline)
