# Corebase

**The backend foundation for modern applications.**

Corebase is a developer-focused Backend-as-a-Service: a developer creates a project and receives a production-ready backend — PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and (later) realtime — in minutes, without assembling infrastructure themselves.

> One command to get a production backend: `corebase create my-app`

## Status

**Milestone 0 and Phases 1–4 complete; Phase 5 in progress** (P5a–P5e: the traffic signal, PostgREST per project, the gateway in front of it, the tenant-isolation suite now gating releases, and the RLS posture and policy cookbook proven through the gateway). Phase 4 met two of its three exit criteria; the third needs a real sending domain and cannot be met on Docker.

**The provisioning spine (Milestone 0).** `POST /v1/projects` returns a real, isolated PostgreSQL 17.5 database on a data node about **2.5 seconds** later, with its own volume, cgroup limits, the full role model, envelope-encrypted credentials, and a connection string you can `psql` into immediately. Twenty consecutive creates are measured end to end.

The worker has also been SIGKILLed at eleven points in that saga to prove it resumes with no duplicate containers, volumes, credentials or capacity bookings.

Deleting a project keeps its data for a 7-day recovery window and then a scheduled purge destroys it and returns the capacity; twenty create+delete cycles leave nothing behind on the node or in the control plane.

Reboot the data node and every project is serving queries again seconds later with no human involved; whatever the control plane and the node disagree about is reported, and anything holding data is reported *without* being touched.

All of it is visible: Prometheus scrapes both services, Grafana has a provisioned dashboard, logs are in Loki and findable by project ref or request id, and the "job stuck" alert has been watched firing.

The [retro](docs/14-roadmap/06-milestone-0-retro.md) reconciled the cost model with six measurements and its main output is a refusal: the RAM and density planning numbers did not move, even though the first data is 3× favourable, because every number was taken in the cheapest corner of the state space.

**The platform surface (Phase 1).** You can sign up and log in — scrypt hashing, rate-limited per identifier and per address, with nothing distinguishing an unknown email from a wrong password including the response time — and hold either a session cookie or a `cbp_` personal access token. You can create organizations, invite people to them, and hold one of three roles that genuinely decides what you can do: a member creates and pauses projects but cannot delete them, an admin does everything except delete the org or grant owner, and no admin can strip an owner to take the org. Projects belong to organizations, so listing them shows *yours*.

Every mutating call leaves a row in an append-only audit table — enforced by a trigger, because `REVOKE` does not bind a table's owner, and by an application role that owns nothing and cannot run DDL. A test enumerates every mutating route and fails if one is unaudited.

Each project gets its own ES256 keypair with `anon` and `service_role` keys, and publishes `GET /v1/projects/:ref/.well-known/jwks.json` so a customer's services can verify tokens without calling us.

**The dashboard shell (P1g).** A Next.js app that is a pure client of the platform API — no BFF, no server-side control-plane access. Sign in, switch organizations, see your projects in a dense table, create one and watch it go `creating` → `ready` without reloading, then copy a connection string that works. Context lives in a breadcrumb where every segment is a switcher, the chrome never re-renders when you navigate inside it, and everything is reachable from the keyboard: `⌘K` for a command palette that navigates, switches, creates and copies, `g p` / `g o` / `g c` / `g k` to jump, `?` for the list.

It is built on the design system that already existed in `design-exports/` rather than on Tailwind + shadcn (D-220): those exports turned out to be a complete component library, and a second component system for the same design would only drift from it. Both themes ship, and tests enforce the three rules that decay silently — no stylesheet may name a ramp step, no drop shadows, and no reference to a token that does not exist.

**How the UI stays consistent.** The first version of this shell was right in every colour and wrong in every mechanic, so the fix was not nicer screens but a written interaction contract: [docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md), ending in a 20-question gate that **runs on every UI change** (D-224) as the `ux-review` role in [.claude/skills/](.claude/skills/ux-review/SKILL.md). Its first run found two real failures in the code written to satisfy it — the palette was missing two actions a row menu already had, and the project list printed "Showing 20 of 20" while hiding a second page.

**Something restores every project's backup without being asked, and checks what came back.** This is the step that changes what the others mean. Everything before it built an archive; the design's own rule is that *a backup which has not been restore-tested is treated as not existing*, so until this ran the honest description was "files in a bucket we believe are restorable". Four checks — recovery completed, page checksums verify, `pg_amcheck` on the indexes, and row counts compared against what the live project says should be there, because a backup can pass every structural test and contain an empty database.

Proving it works meant proving it can fail: overwrite a file inside a real backup with random bytes, and the verification fails and names which check caught it. A verifier that passes healthy backups *and* broken ones is worse than none — it manufactures exactly the confidence the phase exists to earn. Two of my own bugs had that shape and both reported healthy clusters as corrupt: a bash-ism in a `sh -c` and a flag `pg_amcheck` does not accept. A check that cannot pass is as useless as one that cannot fail.

**And thirty days after a project is purged, its backups are destroyed — provably.** A deleted project's repo used to outlive it indefinitely: data a customer asked us to destroy, retained forever, with nothing recording that it should not be. The control plane now deletes the bucket prefix itself, because by then there is no container left to run pgBackRest in and delete rights belong to the control plane alone. "Provably" is the operative word: every sweep deletes the prefix and then *lists it again*, and only records the destruction when that list comes back empty. Deleting and assuming would leave objects retained forever behind a row asserting they were gone.

**Deleting a project takes a final backup first, and stops if it cannot.** Nothing about a `DELETE` distinguishes "we are done with this" from "I typed the wrong ref", so the seven-day recovery window exists — and a recovery window with nothing behind it looks exactly like a recovery window, right up to the moment somebody needs it. Always a full, never an incremental: this is the only copy that will outlive the project. Proven by reading the repo from a *different* container after the project is gone, because a database row saying `succeeded` is our own bookkeeping and the promise is about the archive.

Pausing has the same interlock, for a reason that is easy to miss: a paused project has no running Postgres, so WAL archiving stops with the container. Left alone, the only current copy of a customer's data would be one node's disk with a backup behind it that is already older than the pause. So pause takes a backup after the checkpoint, confirms it landed, and **refuses to stop the containers** if either fails — a paused project whose backup failed is strictly worse than a running one, which is the opposite of what pausing is for.

**A restored copy has a deadline — 48 hours, never more than a week.** It holds a second full dataset and two capacity bookings while serving no traffic, and nothing about it ever finishes on its own: without a deadline the copy a customer validated on Tuesday is still on the node in March. Expiry hands it to the *normal* deletion pipeline rather than destroying it, which matters more here than anywhere — the customer restored because they lost data, so the copy may be the only surviving version of something. What the deadline ends is the copy *running*; its data stays recoverable for the usual week behind that, and the screen says so rather than reading "your copy will be deleted".

**Restoring to a point in time works.** `POST /v1/projects/:ref/restore` provisions a *new* project and replays write-ahead log into it up to the second you name — the original is never touched, and the copy is marked `restored` rather than `ready`, because two databases serving one application loses data by construction. Proven the only way that counts: a row written before the target is there, the row written after it is not, and the original still has both.

Getting there found the bug that would have mattered most. The target was formatted for pgBackRest by trimming the milliseconds off a timestamp, which moves the requested instant backwards by up to a second — so a restore would come back looking perfectly correct and one transaction short, and a customer restoring to the second before a bad migration would have lost that second's writes with no way to tell. It also found a guard of mine that could not fail: checking for a file with `ls` and a substring match passes whether the file exists or not, because `ls` prints the path in its own error message.

**Backups happen without being asked, and failures are visible.** A nightly full on the free tier, weekly fulls with nightly incrementals on paid plans, jittered across a maintenance window so a node with 150 projects does not read 150 databases at 03:00. Every attempt is recorded — including the ones that fail, which is the point: a repo can tell you what it holds but never what was tried, so a project whose nightly full has failed for six days looks exactly like one whose retention window starts six days ago.

Two of my own earlier mistakes surfaced here. Retention was set as a *count* of full backups where the design says days — identical on the free tier, where fulls are nightly, and about eight times too much storage on a plan whose fulls are weekly. And the "no backup in 26 hours" alert was reading the WAL-archiving timestamp rather than the base-backup one, so it would have stayed green for a project whose nightly full had been failing all week while its WAL flowed perfectly.

**When archiving breaks, something notices.** WAL-archive lag is measured every two minutes, and the definition turned out to be the whole problem: the obvious one — time since the last successful archive — pegs every *healthy* idle free-tier project at the alert threshold, because `archive_timeout` closes a segment every five minutes and nothing happens in between. An alert that always fires is worse than no alert, since it discredits the ones that matter. What is measured instead is the age of the oldest segment closed but not yet archived, so nothing waiting means zero lag.

Proving it works meant breaking it, and breaking it found something worse: pointing a project's repo at a bucket that did not exist made the **database restart its whole cluster**. pgBackRest's async archiver double-forks, which reparented its worker onto PID 1 — the postmaster — where a non-zero exit is indistinguishable from a crashed backend. An archiving failure had become an availability incident, which is exactly backwards.

**Every project has an encrypted backup repo in object storage — and nothing has been restored from one yet.** Phase 3 leads with the backups doc's own rule: a backup that has not been restore-tested is treated as not existing. So what is true today is narrower than "backups work": each project gets its own pgBackRest repo under its own cipher-pass, and provisioning does not finish until `pgbackrest check` has forced a WAL switch and confirmed the segment landed. Point-in-time restore and the verification loop are the next two steps, and until they exist Corebase has an archive, not a recovery path.

Building it turned up that `initdb` was never given `--data-checksums`, which the restore-verification checks require. That absence is silent twice over: page corruption goes undetected, and a verification pass then reports a healthy restore of a rotting cluster — a backup system whose checks cannot fail is worse than none.

**One hundred projects run on one node.** 100/100 provisioned in 99 seconds, 200 containers, 200 client connections attached, 1.4 million statements — and each project's actual working set is 13 MiB under load against the 350 MB placement books for it. The interesting number is the one nobody was watching: RAM was over-booked 27-fold while **CPU sat at 82% of the node**. The cost model books RAM and does not model cores at all. That does not re-base anything — the density model may only move on a measurement with the full three-container stack on x86 hardware, and this is neither, which is a rule the project wrote for itself precisely because the data came back *favourable*.

**Projects are packed onto nodes by how full those nodes actually are.** Placement used to order candidate nodes by absolute megabytes reserved, which sorts a small nearly-full node ahead of a large nearly-empty one — so as soon as a fleet has nodes of different sizes, every new project goes to the fullest one. It also considered a single candidate, so a booking that did not fit that node was refused while the region had room: measured on the old code, 20 concurrent provisions against two nodes with 18 free slots placed 13. Nodes are now ranked by fill ratio across both RAM and disk, and a provision that loses a race for the last slot tries the next node instead of failing.

**Every axis a tenant can saturate has a wall, and the walls are checked against the kernel.** Memory, CPU, processes and disk I/O, read back from `/sys/fs/cgroup` inside the container rather than from `docker inspect` — which only ever echoes what we asked for. That distinction was not academic: setting the disk-I/O weight our own design document calls for made *every container on the node fail to start*, because this kernel has no `io.weight` at all, and no inspect-based test could have seen it.

**A project that fills its disk goes read-only and recovers.** The enforcement ladder warns at 80%, escalates at 90%, and makes the database soft read-only at 95% — reads keep working, writes fail with an error naming the cause, and freeing space lifts it automatically. Building it turned up that our own documentation gave the wrong recovery command: `SET transaction_read_only = off` does nothing under autocommit, so a customer following the docs would have concluded they were locked out of the only action that fixes it. The same mechanism had made the ladder a one-way door, because `ALTER DATABASE` is itself a write.

**Credentials rotate without breaking anything.** One `ALTER ROLE` replaces a project's database password: applications already connected keep working (Postgres only checks the password when a connection opens), a new connection with the old password is refused immediately, and **the connection pooler needs no reconfiguration at all** — it reads `pg_shadow` live, which is the reason `auth_query` was chosen over a credentials file. There is an opt-in flag to disconnect everything, documented as compromise response, because rotating alone does nothing about someone already holding a connection.

**A deep review of everything built** produced eight fixes, recorded as D-240…D-245. Two are worth naming here: `CB_STATIC_TOKEN` defaulted to the literal string `dev-token`, so an API deployed with no configuration accepted that header as the bootstrap owner; and the data node answered *"all predefined address pools have been fully subnetted"* with three networks on it — a per-project-network design runs out of *addresses* at roughly ten projects while Phase 2 aims at a hundred.

**Phase 2 (the database platform) has started.** Every project now gets a **connection pooler** — PgBouncer in transaction mode on its own port — so `DATABASE_URL` is a string an application can actually point at: twelve concurrent clients share one Postgres backend. The pooler resolves credentials through a `SECURITY DEFINER` lookup that allowlists exactly one role, so the pooled port cannot reach `postgres` or any other internal role even if PgBouncer is fully compromised — checked by presenting the correct superuser password and being refused. It sits on a private per-project network added in the same phase, which is also what PostgREST will need in Phase 5.

Projects also **pause and resume** now, which is what makes a database per free project affordable: an idle one returns its RAM and keeps its disk, its port and its credentials, coming back in **546 ms at the median** — measured, with 50 consecutive cycles proving nothing is lost. The idle signal took three attempts to get right, and the wrong versions are instructive: PgBouncer parks server connections under the customer's own role, so counting database backends means no project is ever idle, and subtracting the pooler's count instead pauses a project that has one live session open.

Chasing a test failure along the way turned up something older: the worker was opening unbounded keep-alive connections to data nodes through Node's global HTTP agent, which had been breaking the Docker engine outright and reading as "Docker Desktop is flaky" for weeks.

All three Phase-1 exit criteria are met. Above the database, the data plane is still Phase 2+: no data API (PostgREST), no end-user auth service, no storage, no realtime — and the dashboard is a shell, so there is no table editor, SQL editor, members page or billing yet.

> **[STATUS.md](STATUS.md) is the handover document**: what works, how to run it locally, what every rule in the code is defending against, and what is not built yet. Read it before the corpus if you are here to contribute.

**A customer's users can sign up and log in (P4b).** With a project's anon key, `POST /auth/v1/signup` and `POST /auth/v1/token?grant_type=password` create a user and hand back an ES256 access token that verifies against that project's published JWKS — carrying `sub`, `aud`, `role` and a `session_id`, which is what every RLS policy a customer writes will read. The users live in the customer's own database, so `pg_dump` carries them out and nothing about them is ever stored in the control plane.

The interesting part is what the endpoints refuse to tell you. A signup against an address that already exists returns **200 with the same body shape and a decoy uuid**, and pays for a full 64 MiB password hash it does not need — because skipping it would make a taken address answer in 2 ms and a fresh one in 100 ms, which is the same disclosure moved from the body into the clock. Login verifies against a decoy hash when the email is unknown, for the same reason: removing it makes that path 12.6 ms against 269 ms for a wrong password, a 21× oracle that a test measures. All of it is affordable only because the rate limit is checked *before* the hash.

Two of the boundary checks here nearly shipped broken, and both were caught by insisting a guard must be able to fail. A project's API key and a user's access token carry different issuers; pinning one string for both returned 401 for every request with a perfectly valid signature. And the test asserting that a user's own token is rejected as an API key **passed with that check disabled** — the issuer pin was doing all the work — so it now mints a token that gets past the issuer pin and fails with a 200 when the role check is removed.

**Verification, password reset, and the link that carries them (P4c).** A signup writes a single-use confirmation token, `/auth/v1/verify` spends it and hands back a session, and `/recover` and `/resend` do the same for a password reset — all four answering with a shape that is identical whether or not the address exists.

Two details are the actual work. **Spending a token once is a concurrency property, not a check:** the consume is one `UPDATE … WHERE used_at IS NULL`, because concurrent clicks on one link are ordinary — mail clients prefetch, users double-click, corporate scanners follow every link — and with a select-then-update both callers pass the check and both get a session. Removing that predicate was tried: two simultaneous verifies of one link both returned 200 and left two sessions.

And **the redirect allowlist caught a bug in my own code.** `/recover` originally put the caller's `redirect_to` straight into the mailed link. That is not an open-redirect nuisance — the mail comes from a reputable domain, the link genuinely points at the project's own host, and the session tokens land wherever the attacker asked. So a redirect is validated where the link is *built*, not only where it is followed; an unlisted one is replaced by the project's `site_url` and the substitution is audited; a project that has configured nothing permits nothing; and the tokens ride in the URL fragment, which no server, proxy or `Referer` header ever sees.

Nothing sends the mail yet — that is the next step. The boundary is a handover that cannot throw, because an enumeration-safe flow has already committed to returning 200, and the token in the project's own database is the record that mail is owed.

**Mail actually leaves the process (P4d).** A flow decides an email is owed, the API checks the suppression lists then the per-project caps then writes a row then queues a job, and the worker renders both MIME parts and speaks SMTP. One test covers the whole arc: sign up, drain the queue, pull the link *out of the delivered message*, click it, and log in with an account that was refused a minute earlier.

Postmark is not built and the interface is. A client for a paid API with no account and no verified domain behind it would be untested code on the one path where failure is silent and reaches a user, so sending goes over SMTP to a Mailpit container — the same substitution MinIO makes for R2, and the shape per-project custom SMTP needs anyway. What a sink cannot test is deliverability, so the phase's SPF/DKIM/DMARC criterion is recorded as **unmet** rather than declared met against a container.

Testing the hand-written SMTP client against a real listener earned its keep on the first run: **`Acme (via Corebase) <auth@…>` unquoted is not the name it looks like.** Parentheses delimit a comment in RFC 5322, so the sink reported the display name as "Acme" alone — and "via Corebase" is exactly the half that keeps us from claiming to *be* the customer while sending from our own domain. A mock would have agreed with whatever we sent it.

Caps are checked at enqueue rather than at send, and suppression before caps — otherwise a mail-bomb aimed at an address we already refuse to write to consumes the project's whole hourly budget without one message going out, and the attacker denies the project its real mail for free. And idempotency lives in a database row rather than in the queue, because the thing that actually produces duplicate mail is a worker that sends successfully and dies before recording it.

One local trap worth passing on: the sink paused **eight seconds before its SMTP greeting**, which made every send 8s and looked precisely like a bug in our client. It reverse-resolves the connecting address first, and inside a container that lookup finds no resolver and times out. One environment variable took a send from 8038ms to 20ms; the client had been patiently waiting for a banner, correctly.

**A session can now be renewed and ended (P4e).** Refresh rotation with reuse detection, `/logout` with all three scopes, and a sessions list a user can act on.

Rotation is the densest logic in the module and every branch of it is a security decision, so both halves of the grace window were proven by breaking them: remove the theft branch and a token replayed a minute after being spent still works; remove the grace and an ordinary retry destroys the session. Both mistakes are invisible from outside until the system is either logging people out constantly or letting a stolen token live indefinitely. Ten seconds is argued from both ends — not zero, because mobile clients on flaky networks retry and two browser tabs race, and zero tolerance teaches developers to switch rotation off; not sixty, because the window *is* the period in which a stolen token goes undetected.

One place the design could not be implemented as written, and the honest version is better: the spec says a replay inside the grace window returns the already-issued child token. Only its SHA-256 was ever stored, so it cannot be handed out twice. The code issues a replacement under the same parent and revokes the one it replaces — same property (a client whose response was lost gets a working token, no second lineage), and the token from the lost response stops working, which is right, because the only party who might hold it is whoever received the response the retrying client did not.

And revocation's boundary is stated rather than implied: **on the auth endpoints revocation is immediate; on the data API refresh is dead immediately and an already-issued access token dies within its hour.** Putting a session lookup on every data-plane request would move a database round trip onto the hot path and make auth availability into data-API availability. Anyone claiming stateless JWTs plus instant revocation everywhere is selling something.

**Password reset works end to end (P4f).** `GET /user`, `PUT /user`, and the email-change branch of `/verify` — which closes the last gap that mattered: before this, a recovery link logged you in and could not change your credential.

Changing a password requires the current one, and that rule is the security content of the endpoint: a token lifted from `localStorage` buys an attacker an hour, and a token that can *set* the password buys the account forever. The one exception is a token minted by a recovery link, which has already proved control of the mailbox — the same proof a password gives. That exception rides a claim on the token rather than a flag on the session, which turned out to be the better mechanism: the capability expires with the token that carried it, in an hour at most and not across a refresh, instead of lasting the session's thirty days.

Email change needs **both** addresses to confirm, because both single-sided policies are broken in opposite directions. Confirm only the new address and an attacker with a hijacked session can silently re-point the account, then own password reset forever — a temporary compromise made permanent. Confirm only the old one and a user can strand themselves on a typo'd, unreachable address. And `PUT /user {email}` deliberately does *not* tell you an address is taken: that would be the enumeration oracle signup and `/recover` were carefully built to avoid, reachable with one throwaway account. The unique index decides the collision at confirmation time instead.

Two asymmetries that look like bugs and are not: a completed password change revokes every session *except* the one that made it, while a completed email change revokes *every* session including that one. A password change is an act of suspicion, so the session performing it is the one known to be in the right hands. An email change re-points the account's identity, and if it came from a hijacked session then the owner's sessions going too is the correct outcome — there is no way to tell the two cases apart.

**On CI being red for six steps, and what it caught.** The auth work was green on the runner throughout; two *Phase 2* tests were not, and both had failed in the same way — a conditional branch that only executes on the machine you are not developing on.

One was a genuine bug. `exec` against a container that has already exited *throws* rather than returning a non-zero code, and that raw Engine error escaped the health loop and became the step's failure — so a database whose entrypoint refused to initialise reported `POST /exec/673c33c5…` instead of "container exited while starting". The loop's own comment had already given `inspect` the job of deciding whether a container cannot start *yet* or cannot start *ever*; catching the throw is what lets it do that. Which of the two things happens first is a race, so this would have reached production eventually.

The other was an assertion that encoded someone else's arithmetic: it checked that a cgroup read back the literal weight we asked for, but Docker's `BlkioWeight` uses cgroup v1's range and runc rescales it into cgroup v2's, so 200 legitimately reads back as 1920. It now asserts what the mechanism guarantees — the weight is not the kernel's default, which is what an ignored weight looks like — rather than what runc's rounding happens to produce.

The part worth keeping: fixing the race did **not** prove the fix. This machine's Engine returns an exit code where the runner's throws, so the test still passed with the fix reverted. There is now a second test that injects an `exec` throwing exactly what the Engine throws, and it fails with CI's precise message when the fix is removed. A guard whose branch never executes where it was written is a guard nobody has tested.

**The auth API is complete (P4g).** `/admin/users` is the thirteenth and last endpoint, and it's what makes a customer able to honour a user's deletion request at all — developer-initiated deletion is the only deletion in V1, so until now the answer was "write SQL".

This surface deliberately breaks the rule every other one follows. It's authorised by the **service_role** key — the customer's own server-side credential, which can already read every row in the schema — so hiding whether a user id exists would protect nothing and would break a retrying import script that needs to tell "already gone" from "done". The corollary is that the key check is the *only* thing between the published anon key and every account on the project, so it runs first on all five routes and a test exercises all five. Disabling it, the anon key gets a 200.

Deletion keeps the id and nothing else. The customer's own tables reference `auth.users(id)` under their foreign-key semantics and Corebase doesn't cascade into app schemas, so a hard delete would either break those references or force a decision about someone else's data. The address becomes `deleted+<id>@invalid` — valid syntax, reserved TLD, can never receive mail — which frees the real address for re-registration. Password, both metadata halves and the confirmation timestamp are scrubbed, and every session, refresh lineage and outstanding one-time token goes with them: **a deleted user whose recovery link still works is a deleted user who can be signed back in from an inbox.**

**The drill that proves crash-resume had not completed a single provision in four nights.** Found while checking CI on something else. The nightly said `DID NOT CONVERGE` for all eleven kill points and printed four lines of worker log; the error explaining everything was in memory, just outside that window — `backups are required (CB_REQUIRE_BACKUPS) but no repo is configured`, naming the exact variables and the command to run.

Five faults, four in the drill and none in the product. Its environment never carried the object-store settings, so a step added later failed every scenario. It never checked the status of the call it depended on. It read `{ref, id}` out of a response that has been `{project: …, job: …}` for two phases — so every convergence poll watched a project that did not exist while provisioning succeeded perfectly. Its failure path printed four lines of a two-minute failure. And its credential invariant asserted a stale total: exactly 3, the number a project had at Milestone 0, against the 11 it legitimately carries now.

Crash-resume was working the entire time. **T6 now passes 11/11 with zero duplicates**, resuming in 31 seconds at the median. The two rules that came out of it are in STATUS: a harness checks what it is told, and a failure path prints everything it already holds — five separate bugs here have been prolonged by a diagnostic that had the answer and showed a window that excluded it.

**A signing key can be rotated without logging anyone out (P4h).** Phase 4's second exit criterion: the runbook runs against staging and a session created before it survives it.

It's three commands rather than one function, because the runbook's value is the *waiting* between its steps. `begin` publishes the new key without signing anything, so a verifier caching the JWKS for ten minutes already holds it before a token signed with it can arrive. `cutOver` switches signing and refuses to run before that window has passed — naming both elapsed and required seconds, because the operator's next question is "how much longer", and an error that makes them compute it is an error that gets forced past. `retire` un-publishes, and it's gated on **30 days**, not on token expiry: user tokens die within an hour, but the anon key in a customer's deployed frontend does not, and only they can ship a replacement.

That last point is the one that makes rotation survivable at all. A project's anon and service_role keys *are* JWTs under the same signing keypair, so a signing rotation is an API-key rotation whether or not anyone planned for it. Verification therefore accepts **every published key**, not just the active one — restricting it to the active key was tried, and the old anon key stops working the instant of cut-over.

One trap found in our own secret store, producing the worst available failure mode: `put` is create-if-absent, not a setter. The cut-over called it expecting a swap and got a silent no-op — JWKS published both keys, the cut-over reported success, and every token still carried the old key id. A rotation in which nothing rotates is worse than one that fails, because it reports success.

And two of my own test probes were green for the wrong reason, which only the *negative* assertion could reveal: "the old key still works during the window" passed while testing nothing at all, twice. Only "retiring it kills it" — which needs the key to stop working — could tell the difference.

**Phase 4 ends with a demo, and the demo found a bug before it was finished.** `demo/auth/` is a plain HTML page — no build, no framework, no dependency — that signs a user up, verifies the address from a genuinely delivered email, logs in, and shows what each JWT claim is *for*. `./scripts/auth-demo.sh` creates the project, points its `site_url` at the page, hands it the anon key and serves it.

It is the auth API's first browser client, and that is the point of asking for it: **`apikey` was not in the allowed CORS request headers.** It's required on every `/auth/v1/*` endpoint, a custom header forces a preflight, and the browser refuses before the request leaves — so every signup and login from a customer's frontend had been failing for the whole phase. `PUT` was missing too, which is how a user changes their password. The allowlist was written for the dashboard, which talks to the control plane and never sends an apikey; the CORS suite only ever preflighted a control-plane route, so it asserted exactly the wrong client's needs.

`./scripts/dev.sh` also couldn't create a project — it never loaded the object store's settings, so provisioning dead-lettered. Seventh instance of the same drift, and the first one in the path a person actually types.

The demo doesn't skip the verification step. Its server proxies the mail sink's read API under its own origin, so one click pulls the token out of the message the worker really sent over SMTP — `autoconfirm` stays off, which is both the default and the point. Driven end to end in a real browser: four steps, zero console errors.

**Phase 5 opens by closing a hole that was already open.** The idle scan pauses a project after a week of inactivity, and it decided that from database connections alone. That was sound while there was no data plane — a client connection was the only way to use a project — and a tripwire was left in place so that adding PostgREST would fail loudly and force the missing "no HTTP traffic" signal to be built first.

The auth module walked straight past it. The tripwire watched for a third *container*; the auth module is a shared multi-tenant *process*, so nothing tripped when it started serving `/auth/v1/*` per project — and its database connections open as an internal role the scan deliberately excludes. So for the whole of Phase 4, **a project whose users only signed up and logged in looked idle**, and would have been paused under them after seven days with nothing to wake it.

The fix needed no change to the scan at all: the signal writes `last_active_at`, which is the column the scan already filters candidates on, so a project touched by traffic simply stops being a candidate. It's a throttled write to Postgres rather than a counter in Redis, because a lost timestamp fails in the dangerous direction — it reads as *idle*.

The test is a controlled comparison: two identical projects, both backdated a month, one scan, and the traffic signal the only difference. One stays ready; its twin pauses.

**Every project now has a data API, and a gateway in front of it.** PostgREST runs
as a third container per project, connected directly to that project's Postgres
and reloading its schema cache on `NOTIFY` rather than on a timer. Five failures
stood between the image building and the container serving, and four of them were
invisible to `docker build`: an em dash in a config comment (the base image's
locale is POSIX, so a non-ASCII byte is `invalid argument`), an apostrophe inside a
shell default that broke the entrypoint at EOF, `information_schema` revoked from
`PUBLIC` by the Phase 1 hardening so introspection 503'd forever, a schema `USAGE`
grant that does not imply `EXECUTE` on the function inside it, and a port the data
node never published. What made them tractable was printing PostgREST's own log on
a health-check timeout — one run instead of five.

The gateway is deliberately thin: resolve the project from the Host, validate the
apikey, apply three rate-limit layers, proxy. It parses no queries, inspects no
response bodies, holds no customer data, and — the one that matters most — makes
**no control-plane query on the hot path**. Its routing table lives in memory and
refreshes on a timer, which is about blast radius rather than speed: a gateway
that queried per request would make every customer's data API depend on the
control plane being up. In memory, a control-plane outage costs new projects and
rotations, not the fleet.

The order of its checks is the design. Resolve before validating a key, because a
key can't be checked against an unidentified project; validate before rate
limiting, so an unauthenticated flood can't spend a valid key's budget; rate-limit
before the paused check, so a burst at a paused project can't enqueue one resume
per request. And because a `Host` header is an unverified assertion — anyone can
send any Host — resolving it is only half of identity: the apikey's own `ref`
claim must match the project it resolved to.

Running the routing table's query against staging for the first time is what
caught the fault the tests could not: a signing key that fails to *load* was being
swallowed, making an unreachable KEK indistinguishable from a project with no key
— both showing up as every request 401ing with nothing anywhere saying why.

**And now A and B, continuously.** The proposal's §74 asks for two projects and a
standing proof that one cannot touch the other. `tests/isolation/` is 38 rows of
that — API, database, network and RLS canaries — and it is a **release gate**:
red freezes every pending change, not just the one that broke it, because while
isolation is provably broken there is no reasoning about which change is safe to
ship.

It is worth saying what it found on its first run, since that is the argument for
building it now rather than at launch. Two of the four faults were in controls
that had never been built at all. Arbitrary internet egress was open from every
project container — exfiltration and mining both need outbound reach and both had
it — and once that was closed, the node's own Docker API turned out to still be
reachable at the container's default gateway, because the node's bridge address is
a *local* destination and never traverses the chain the first fix used. Neither
was recorded as a gap anywhere. The other two were in the gateway: `kid` was
decorative, and a token whose claim named a different project was refused for the
wrong reason.

The harness may only use surfaces an attacker has: HTTP, the pooler port, a psql
session with the project's own advertised credentials. It never reads a container
log or a firewall rule to decide whether an attack was blocked — that would prove
the rule exists, not that it works. What it *does* hold, in setup only, is each
project's private key, so it can mint forgeries no attacker could: a claim
rewritten to name the neighbour and re-signed correctly, refused anyway.

Every deny has a positive control beside it, because the failure mode of a suite
like this is passing for the wrong reason. A container with no networking passes
every network row; a pooler that refuses everyone passes the credential row.

**Then the policy cookbook was run exactly as the docs write it — and it could
not be written at all.** Every pattern calls `auth.uid()`, and creating a policy
that references it needs USAGE on the `auth` schema. That was granted to the
roles a *request* runs as, and to nobody else — so the role a customer runs
migrations as failed on the first policy anyone would copy out of the
documentation, with an error that reads like a platform fault. The entire subject
of this phase was unusable from the connection string the previous one hands out.

One pattern was also simply wrong. Soft delete filtered tombstones in the read
policy, and PostgREST writes with `RETURNING`, so Postgres applies the read policy
to the *new* row too — meaning the one operation the pattern exists to perform
fails on its own policy. The rule generalises: an UPDATE may not move a row
outside its own SELECT policy. Tombstones now hide in a view instead.

Running the docs verbatim is the whole technique here. These are the policies
customers copy, so the value is entirely in not quietly improving them on the way
into the test — if a pattern needs a fix to work, the documentation is what should
change.

## Run it

```bash
pnpm install
./scripts/staging.sh up && ./scripts/migrate-staging.sh && ./scripts/staging.sh kek
docker build -t corebase/postgres:17.5 infra/docker/postgres
docker build -t corebase/pgbouncer:1.23 infra/docker/pgbouncer
./scripts/staging.sh seed-images && ./scripts/staging.sh backup-store && ./scripts/staging.sh verify
```

`backup-store` creates the bucket, generates the object store's TLS material, and
proves the store is reachable from inside a project's own private network — the
same NAT path a real node takes to R2. Skip it and projects still provision, but
they provision without a backup repo and say so in the log.

Then start the services and watch the whole thing work in about five seconds:

```bash
./scripts/dev.sh
```

```bash
./scripts/demo.sh
```

Or use the dashboard, on http://localhost:3000:

```bash
pnpm dev:dashboard
```

There is no seeded password anywhere, so create an account on `/signup`; a new account has no organization, and [STATUS.md](STATUS.md) §2 has the two curl calls that make one (the endpoint exists, the screen does not yet).

The demo script creates a project, waits for it, connects to the database it made with the credentials the API handed back, runs real SQL, and deletes it — using only `curl` and `psql`, which is exactly what a customer has.

The full suite is **606 tests**, integration included; they need the staging stack above and **fail rather than skip** without it:

```bash
pnpm test
```

The unit lane is **216 of those** and needs no infrastructure at all — it is what CI runs first, in about a minute:

```bash
pnpm test:unit
```

Or measure provisioning end to end — twenty creates, each proven usable by connecting to it:

```bash
pnpm --filter @corebase/worker bench
```

Or kill the worker at eleven points mid-provision and watch every one converge:

```bash
pnpm --filter @corebase/worker kill-matrix
```

Or run twenty full create-use-delete-purge cycles and check nothing is left behind:

```bash
pnpm --filter @corebase/worker lifecycle
```

Or reboot the data node and watch it converge on its own:

```bash
pnpm --filter @corebase/worker node-reboot
```

To watch it work, `./scripts/dev.sh` starts both services with the right environment and ships their logs to Loki; Grafana is then at <http://127.0.0.1:3001/d/corebase-provisioning>.

Staging is Docker Compose plus Docker-in-Docker standing in for a control node and a data node. The interface the worker drives is the real one — the Docker Engine API over mutual TLS, no per-node agent (D-052) — so no step of the plan is skipped and nothing is paid for. [STATUS.md §2](STATUS.md) has the details and the environment variables.

## What is built

| | |
|---|---|
| `services/api` | Fastify control-plane API: auth, organizations, invites, project CRUD, project keys and JWKS; the documented `/v1` envelope with `request_id`, keyset pagination, idempotency keys, two-phase enqueue. Also the data-plane auth module at `/auth/v1/*` — signup, password grant, per-project JWKS — which is a different surface for different people |
| `services/worker` | Provisioning worker: job runner with checkpoints, transactional placement, Docker Engine API client over mTLS, the eight-step provisioning saga |
| `packages/crypto` | Envelope encryption — per-secret data key wrapped by a master key that never enters the database |
| `packages/secrets` | Credential persistence; enforces store-then-apply so a crash cannot lose a password |
| `packages/audit` | The audit writer: joins the caller's transaction, redacts secrets on the way in, truncates rather than rejects |
| `packages/jwt` | ES256 sign/verify, hand-written to support exactly one algorithm — a wrong `alg` is rejected before a signature is computed |
| `packages/queue` `packages/migrate` `packages/types` | BullMQ wiring (provisioning and auth-email queues), the SQL migration runner, shared types and prefixed transport ids |
| `packages/email` | The `EmailProvider` seam, a hand-written SMTP client, six auth templates rendering both MIME parts, and the per-project send caps |
| `infra/docker/postgres` | The per-project database image: extension allowlist enforced by absence, no `trust` auth anywhere, RLS on at table creation |
| `infra/docker/pgbouncer` | The per-project pooler image: transaction mode, `auth_query` against a lookup that allowlists one role, every rule baked in |
| `infra/docker/staging` | The local stand-in for staging, including Prometheus, Loki, Alloy and Grafana with the dashboard provisioned as code |
| `packages/metrics` | A Prometheus registry — counters, gauges, histograms, with label sets declared up front so the cardinality budget is hard to break |
| `apps/dashboard` | The dashboard shell: login, signup, org switcher, projects grid, create-project flow, project overview — Next.js App Router, TanStack Query, session cookies, no BFF |
| `demo/auth` | The Phase 4 demo: a plain HTML page that signs up, verifies from a real email, logs in and explains the JWT claims — the auth API's first browser client |
| `.github/workflows` | CI in two lanes — a one-minute unit lane run against dead database ports, and an integration lane that stands up the whole Docker stack — plus the nightly crash, lifecycle and reboot drills |

## The planning corpus

Everything lives under [docs/](docs/INDEX.md). Start there — [docs/INDEX.md](docs/INDEX.md) gives the full map and a recommended reading order.

The corpus covers, A to Z:

| Section | What it plans |
|---|---|
| [00-foundation](docs/00-foundation/01-vision-and-principles.md) | Vision, principles, competitive analysis, critical review of the original proposal, glossary, decision log |
| [01-architecture](docs/01-architecture/01-system-architecture.md) | System architecture, control/data plane split, multi-tenancy, domains/regions, repo layout |
| [02-control-plane](docs/02-control-plane/01-data-model.md) | Control-plane data model, platform API, provisioning state machine, job queue, audit |
| [03-database-platform](docs/03-database-platform/01-postgres-provisioning.md) | Postgres provisioning, pooling, credentials, migrations, backups/PITR, extensions & upgrades |
| [04-data-api](docs/04-data-api/01-rest-api-design.md) | Auto-generated REST API, request pipeline, API keys & roles |
| [05-auth](docs/05-auth/01-auth-architecture.md) | Auth architecture, sessions & tokens, flows, email infrastructure, OAuth roadmap |
| [06-security](docs/06-security/01-threat-model.md) | Threat model, RLS design, tenant-isolation test suite, platform security |
| [07-storage](docs/07-storage/01-storage-architecture.md) | Object storage architecture, API and access policies |
| [08-realtime](docs/08-realtime/01-realtime-architecture.md) | Realtime architecture (post-V1), channels/broadcast/presence |
| [09-dashboard](docs/09-dashboard/01-dashboard-ia.md) | Dashboard IA, table editor, SQL editor, [design system](docs/09-dashboard/04-design-system.md) |
| [10-cli-and-sdk](docs/10-cli-and-sdk/01-cli-spec.md) | CLI spec, local development, SDK spec |
| [11-infrastructure](docs/11-infrastructure/01-infra-phases.md) | Infra phases, IaC & CI/CD, observability, disaster recovery |
| [12-business](docs/12-business/01-cost-model.md) | Cost model, pricing & plans, abuse prevention, open-source strategy |
| [13-quality](docs/13-quality/01-testing-strategy.md) | Testing strategy, release & versioning policy |
| [14-roadmap](docs/14-roadmap/01-phase-plan.md) | Full phase plan, V1 scope & cut list, post-V1 roadmap, Milestone 0 |
| [15-risks](docs/15-risks/01-risk-register.md) | Risk register, open questions |

## Two registers keep the corpus honest

- **[Decision log](docs/00-foundation/05-decision-log.md)** — every binding decision (D-001…D-210) with its rationale. If two documents disagree, this log wins. Overturned decisions are annotated, never deleted, so the reasoning stays auditable — D-083's FORCE-RLS half, for instance, is annotated as superseded by D-191, which the build discovered by breaking a customer's first `INSERT`.
- **[Open questions](docs/15-risks/02-open-questions.md)** — 142 questions left deliberately unresolved, each with an owning document and a decide-by trigger.
- **[Measurement log](docs/14-roadmap/05-measurements.md)** — every number the plan assumed and the build later measured, append-only, and each entry states what it does **not** license. The drift between assumption and reality is the finding; the [Milestone-0 retro](docs/14-roadmap/06-milestone-0-retro.md) is where that drift was acted on.

## The design system

Accent is **Electric Violet** — `#7C3AED` light, `#8B5CF6` dark — on cool violet-tinted neutrals. It was chosen over coral, emerald, deep forest and cyan for two reasons that outlived taste: it is the only candidate where white text clears AA contrast on the accent in *both* themes, and it collides with no semantic colour. In a product whose scariest button is *Delete project*, the brand hue must never be confusable with the error hue.

The written spec is [docs/09-dashboard/04-design-system.md](docs/09-dashboard/04-design-system.md). The artefacts are under [design-exports/](design-exports/INDEX.md):

| Folder | What's in it |
|---|---|
| [`06-tokens/`](design-exports/06-tokens) | `tokens.css` (both themes), `colours.json`, `typography.json` |
| [`07-html/`](design-exports/07-html) | Live reference: all 43 components with their markup, plus one standalone file per component |
| `00-boards/` … `05-palette/` | 142 PNGs at 2x — full boards, sections, every component cropped alone, font specimens, palette ramps |

Open the HTML reference with a local server so the relative CSS resolves:

```bash
cd design-exports/07-html && python3 -m http.server 8000
```

Three rules in the token layer are load-bearing, and a naive light-to-dark inversion breaks all three:

- Components reference **role** tokens (`--cb-surface`, `--cb-text`, `--cb-accent`), never ramp steps — which is why flipping `data-theme` is the entire implementation of dark mode.
- The accent **lifts one ramp step** in dark, or it disappears into the surface.
- Danger *fill* stays darker than error *text* in dark, so white labels on destructive buttons keep their contrast.

There is no shadow scale. Elevation is surface tint plus border weight.

## North star

Make one developer love using Corebase. Then 10. Then 100. Then 1,000. The infrastructure evolves alongside the users rather than being built entirely in advance.
