# Storage API & Policies

## Purpose

The contract of `/storage/v1/*`: the endpoint surface, how authorization is evaluated (RLS on metadata, same pipeline as the data API), signed URLs, MIME/size enforcement, and — treated as a first-class design problem, not a footnote — the **orphaned-object consistency problem** that every metadata-in-Postgres + bytes-in-S3 system has. Physical layout, schema DDL, and upload-path selection are in [01-storage-architecture.md](01-storage-architecture.md) (D-120…D-122).

## Design

### 1. Endpoint surface

All endpoints under `https://<ref>.corebase.co/storage/v1`, authenticated like every data-plane request: `apikey` header (anon/service_role JWT, D-029) plus optional user `Authorization: Bearer` (D-014). Errors use the uniform envelope (D-032). Rate limits per D-033.

| Method & path | Operation | Notes |
|---|---|---|
| `POST /bucket` | Create bucket | Body: `{name, public, file_size_limit?, allowed_mime_types?}` |
| `GET /bucket` | List buckets | RLS-filtered |
| `GET /bucket/:name` | Get bucket config | |
| `PATCH /bucket/:name` | Update bucket config | `public` flips take ≤ 30 s to propagate (config cache) |
| `DELETE /bucket/:name` | Delete bucket | 409 unless empty |
| `POST /object/:bucket/*path` | Upload (≤ 50 MB, proxied) | Body = bytes or `multipart/form-data`; `x-upsert: true` header allows overwrite |
| `PUT /object/:bucket/*path` | Overwrite (≤ 50 MB, proxied) | Same as POST with upsert implied |
| `POST /object/upload/sign/:bucket/*path` | `createSignedUploadUrl` | For > 50 MB (or any size); returns presigned R2 PUT + `upload_id` intent (D-122) |
| `POST /object/upload/complete/:upload_id` | Complete presigned upload | Service HEADs R2, finalizes the metadata row |
| `GET /object/:bucket/*path` | Download (private) | Honors `Range` and conditional (`If-None-Match`) headers — media seeking and resumable download work; streamed from R2 |
| `GET /object/info/:bucket/*path` | Object metadata | No bytes |
| `POST /object/list/:bucket` | List objects | Body: `{prefix?, delimiter?='/', limit?=100, cursor?}`; delimiter gives folder-style `commonPrefixes` |
| `POST /object/move` | Move/rename | `{bucket, from, to}` — R2 copy + delete + row UPDATE (see §5 ordering) |
| `POST /object/copy` | Copy | `{bucket, from, to}` — new row, new R2 object |
| `DELETE /object/:bucket/*path` | Delete one object | |
| `POST /object/delete/:bucket` | Batch delete | Body: `{paths: [...]}` (≤ 1000) |
| `POST /object/sign/:bucket/*path` | `createSignedUrl` | Body: `{expires_in}` (seconds, default 3600, max 604800) |
| `GET /object/sign/:bucket/*path?token=…` | Fetch via signed URL | No `apikey` required — the token is the credential |

Public-bucket reads skip authentication but ride the same origin: `GET /object/public/:bucket/*path` (no `apikey` — full URL `https://<ref>.corebase.co/storage/v1/object/public/<bucket>/<path>`), CDN-cached via a cache rule on that path prefix ([01-storage-architecture.md](01-storage-architecture.md) §5).

### 2. Authorization: RLS on metadata is the permission system

The storage service holds no ACL engine. For every operation it opens a transaction against the project DB through the project pooler and evaluates access **as the caller**, using the identical context-injection pattern as the data API ([request pipeline](../04-data-api/02-request-pipeline.md), D-015):

```sql
BEGIN;
SET LOCAL ROLE authenticated;                          -- or anon / service_role from the verified JWT
SELECT set_config('request.jwt.claims', $claims_json, true);  -- true ⇒ SET LOCAL semantics
-- the operation's metadata query runs here, filtered by the customer's policies
COMMIT;
```

Operation → policy mapping:

| Storage operation | RLS check performed |
|---|---|
| Download / info / signed-URL creation | `SELECT` on the `storage.objects` row |
| Upload (new) | `INSERT` on `storage.objects` (`WITH CHECK`) |
| Upload (upsert) / move / copy-metadata | `UPDATE` (move: on source row with new `name` checked) + `INSERT` for copy |
| Delete | `DELETE` on the row |
| List | `SELECT` — rows the caller can't see simply don't appear |
| Bucket CRUD | Corresponding command on `storage.buckets` |

The bytes follow the metadata verdict: the service touches R2 only after the RLS-checked statement succeeds. `service_role` bypasses RLS per D-029 exactly as it does on customer tables.

Path-prefix helper, shipped in every project's base migration (plain SQL, exportable per D-004/C-1):

```sql
-- First path segment of an object name: storage.prefix_owner('42/photo.png') = '42'
CREATE FUNCTION storage.prefix_owner(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', 1) $$;
```

Policy examples (documented patterns, mirrored in the dashboard policy editor):

```sql
-- 1. Public-read bucket 'assets': anyone may read metadata/objects; only service_role writes.
CREATE POLICY "assets are readable by all"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'assets'));
-- (no INSERT/UPDATE/DELETE policy ⇒ only service_role can write)

-- 2. Avatars: any signed-in user reads; each user writes only under avatars/{auth.uid()}/*
CREATE POLICY "avatars are readable by signed-in users"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'avatars'));

CREATE POLICY "users manage their own avatar folder"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'avatars')
         AND storage.prefix_owner(name) = auth.uid()::text)
  WITH CHECK (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'avatars')
              AND storage.prefix_owner(name) = auth.uid()::text);

-- 3. Org-shared files: membership table in the customer's schema gates a shared bucket,
--    with paths namespaced org-first: '<org_id>/<file>'.
CREATE POLICY "org members access org files"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'org-files')
         AND storage.prefix_owner(name) IN
             (SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()))
  WITH CHECK (bucket_id = (SELECT id FROM storage.buckets WHERE name = 'org-files')
              AND storage.prefix_owner(name) IN
                  (SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()));
```

RLS performance notes (per-statement subselects, policy indexing) follow [RLS design](../06-security/02-rls-design.md); the `objects_bucket_prefix_idx` index in the DDL exists for exactly these patterns.

### 3. Signed URLs

Download signed URLs are **Corebase-HMAC-signed tokens verified by the storage service** — not R2 presigned URLs — so they work through `<ref>.corebase.co`, survive R2 credential rotation, and never expose the physical key layout. (Presigned *upload* URLs from D-122 are the one place raw R2 presigning appears, and those point at R2 directly.)

**Token contents (signed payload):** `project_ref`, `bucket`, `object path`, `exp` (unix), `kid` (signing-key version), and for signed *uploads* additionally the required `content-type` and max size — so a leaked upload URL cannot be repurposed for a different file shape. Encoding: compact JWS-style `base64url(payload).base64url(HMAC-SHA256(payload))`.

**Key derivation:** each project already has signing material managed under D-014/D-035. Because the JWT keypair is asymmetric (ES256) and these tokens need a cheap symmetric verifier held only by the storage service, the key is derived, not reused:

```
storage_signing_key = HKDF-SHA256(ikm = project_master_secret,  info = "corebase/storage/v1",  salt = kid)
```

with `project_master_secret` an envelope-encrypted per-project secret ([credentials & secrets](../03-database-platform/03-credentials-and-secrets.md)). Rotation = new `kid`; old `kid`s verify until their last possible token expiry (≤ 7 d) then retire. Blast radius stays per-project (same argument as D-014).

**Revocability, stated honestly:** a signed URL is a bearer capability. It is **not revocable before `exp`** short of rotating the project's storage `kid`, which invalidates *every* outstanding signed URL for the project. There is no per-URL kill switch in V1 (a denylist check per GET would add a DB/Redis hop on the hottest read path). Therefore: default expiry **1 hour**, hard maximum **7 days**, and the docs say plainly: for revocable access, keep the bucket private and let clients fetch through the RLS-checked endpoint instead.

### 4. MIME validation and size limits — enforcement point (D-123)

All bucket-config enforcement happens **at the storage service**, the only component that sees uploads (R2 enforces nothing but the presigned `content-length-range`).

- **Size:** proxied path — bytes counted as streamed; the stream is aborted (and any partial R2 multipart aborted) the moment `min(bucket.file_size_limit, plan_limit)` is exceeded; nothing is trusted from `Content-Length`. Presigned path — the cap is baked into the presigned policy, and the completion `HEAD` re-checks true size before the row is finalized (violations ⇒ object deleted, upload rejected).
- **MIME — sniff vs trust:** trusting the declared `Content-Type` is free but lets `evil.exe` upload as `image/png`; full sniffing of every type is a rabbit hole of ambiguous formats. Decision: **verify magic bytes against a known-dangerous set, store the declared type.** The service sniffs the first 512 bytes and rejects the upload if the content matches executable/active signatures (PE `MZ`, ELF, Mach-O, Java class, plus `<script`/`<?php` when the declared type claims an image) or if a bucket's `allowed_mime_types` names an image/media type the magic bytes contradict. Otherwise the declared type is stored and served. Presigned-path uploads get the same sniff at completion time (ranged GET of the first bytes), with rejection deleting the object.
- **Serving hygiene** (independent of validation): all downloads are served with `X-Content-Type-Options: nosniff`, and `text/html`/`image/svg+xml` are served with `Content-Disposition: attachment` plus a restrictive CSP on public-object responses — stored-XSS via served objects is the actual attack this stack must kill ([platform security](../06-security/04-platform-security.md)). Note the separate-host defense is **unavailable in V1**: public objects serve from the project origin `<ref>.corebase.co` because the dedicated storage host is dropped by the [domain & region model](../01-architecture/04-domain-and-region-model.md) (D-057 — the wildcard covers one label). The forced `nosniff` + attachment-disposition serving is therefore load-bearing, not defense-in-depth; a dedicated storage host returns with the custom-domain/PSL work (OQ-057/OQ-062).

### 5. The orphaned-object consistency problem (D-124)

Postgres and R2 do not share a transaction. Every mutation is two writes against two systems, and one of them can fail. **The chosen write orderings plus the reconciliation sweep ARE the consistency model** — there is no hidden transactional layer, and this section is the complete honest statement of it.

Invariant chosen: **a metadata row must never reference bytes that don't exist** (a broken row is a visible 500 and a false quota charge); **bytes without a row are invisible garbage** (cost, not correctness) that sweeps collect.

Failure matrix:

| # | Flow & ordering | Crash point | Resulting state | Visible symptom | Remedy |
|---|---|---|---|---|---|
| F1 | Upload: **PUT object to R2 first, then INSERT row** | After PUT, before INSERT | Object without row (orphan) | None — object is unreachable | Daily sweep deletes it after 24 h grace |
| F2 | Upload, same ordering | INSERT violates RLS/unique | Same as F1 | Client gets 4xx | Service best-effort deletes the object immediately; sweep is the backstop |
| F3 | Upload with row-first ordering | *(rejected design)* | Row without object | Download 500s; quota overcounts | — this is why object-first is mandatory |
| F4 | Presigned upload (D-122) | Client never calls complete | Intent row (pending) + maybe object | None | Sweep expires intents > 24 h: delete object if present, delete intent |
| F5 | Delete: **DELETE row first, then delete object** | After row delete, before R2 delete | Object without row (orphan) | None — already invisible to clients | Sweep collects it |
| F6 | Delete with object-first ordering | *(rejected design)* | Row without object | Download 500s | — this is why row-first delete is mandatory |
| F7 | Overwrite (upsert) | After new PUT, before row UPDATE | Old row + new bytes at same key | Stale etag/size served briefly | Row UPDATE retried by request; R2 PUT is idempotent at the same key; sweep can't help (key occupied) — etag mismatch surfaces in true-up audit |
| F8 | Move: PUT copy → UPDATE row → DELETE old object | Between any steps | Extra copy or leftover source object | None | Sweep collects whichever key has no row |
| F9 | Bucket/project deletion (D-038) | Mid batch-delete | Partial prefix remains, rows gone | None | Deletion job is resumable (idempotent, D-018); sweep is the final guarantee |

**The reconciliation sweep** (daily per region, a BullMQ repeatable job):

1. List R2 under `projects/<ref>/` (paged) for each active project.
2. Anti-join against `storage.objects` (derived keys) and pending upload intents.
3. Delete R2 objects with no row/intent **and** `LastModified` older than 24 h — the grace window keeps the sweep from racing in-flight uploads.
4. Inverse pass: rows whose `HEAD` 404s are counted, alerted on (this should be ~zero given the orderings; nonzero = bug), and quarantined for operator review rather than auto-deleted.
5. Emit metrics: orphans collected, bytes reclaimed, rows-without-objects found ([observability](../11-infrastructure/03-observability.md)).

Cross-project listing cost of the sweep at fleet scale is OQ-124.

### 6. Per-project storage quota accounting

Quota = `sum(size)` over `storage.objects`, maintained two ways because each alone is wrong:

- **Fast path — trigger:** a single-row `storage.usage (total_bytes bigint, object_count bigint, updated_at)` table maintained by an `AFTER INSERT OR UPDATE OF size OR DELETE` trigger on `storage.objects`. Reading one row per upload is cheap enough to check inline.
- **Truth path — true-up:** the daily sweep already lists every project's R2 prefix; it recomputes actual stored bytes and overwrites `storage.usage` when drift exceeds 1% or 100 MB (drift sources: F7-class races, sweep deletions, bugs). Metering events for billing flow from the true-up, not the trigger ([pricing & plans](../12-business/02-pricing-and-plans.md)).

**Enforcement at upload:** before accepting bytes (proxied) or issuing a presigned URL, the service checks `usage.total_bytes + declared_size ≤ plan_quota`. Over-quota ⇒ `413` with error code `storage_quota_exceeded` (envelope per D-032). Concurrent uploads can overshoot by at most the in-flight window — accepted; quota is a billing boundary, not a security boundary, and hard precision would need locking on the hot path.

## Decisions

- **D-123 — Bucket size/MIME limits are enforced at the storage service; MIME policy is: verify magic bytes against a known-dangerous signature set (executables, active content masquerading as media), otherwise store and serve the declared content-type; HTML/SVG served with `nosniff` + attachment disposition on shared hosts.** *(Rationale: full content sniffing is unwinnable and mostly pointless; trusting declarations blindly enables malware hosting and stored XSS — the dangerous-set sniff plus serving hygiene kills the real attacks at bounded cost.)*
- **D-124 — Storage consistency model: no cross-system transactions; uploads write object-then-row, deletes write row-then-object, presigned uploads use intent rows, and a daily reconciliation sweep (R2 prefix listing anti-joined to `storage.objects`, 24 h grace) collects orphans — the orderings plus the sweep are the entire consistency guarantee, and rows-without-objects are treated as bugs, alerted, and quarantined.** *(Rationale: the chosen invariant makes every failure mode invisible garbage instead of a visible 500 or a false charge; a 2PC/outbox layer over R2 would add complexity without removing the need for the sweep.)*

## Open Questions

- **OQ-124 — Sweep cost at scale:** full per-project R2 listings daily are O(total objects); at what fleet size does the sweep need to go incremental (R2 event notifications or per-day key partitioning), and does the quota true-up then need its own cheaper source?
- **OQ-125 — Signed-URL revocation demand:** if customers demand pre-expiry revocation, is a Redis denylist on the signed-GET path (one hop per read) acceptable, or should revocable access remain "use a private bucket"? Revisit on first real request.
- **OQ-126 — Multipart resumability surface:** V1 exposes multipart only implicitly (SDK/proxy internals + presigned single PUT). Do large-file users need explicit part-level resume (S3-style UploadPart) before V1.1?

## Dependencies

- Builds on: [01-storage-architecture.md](01-storage-architecture.md) (D-120…D-122), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../04-data-api/03-api-keys-and-roles.md](../04-data-api/03-api-keys-and-roles.md) (D-029), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../05-auth/02-sessions-and-tokens.md](../05-auth/02-sessions-and-tokens.md) (D-014), [../03-database-platform/03-credentials-and-secrets.md](../03-database-platform/03-credentials-and-secrets.md) (D-035), [../02-control-plane/04-job-queue-and-workers.md](../02-control-plane/04-job-queue-and-workers.md) (D-018)
- Feeds: [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md) (`storage.from(...)` surface), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md) (storage cases), [../06-security/04-platform-security.md](../06-security/04-platform-security.md), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md) (metering), [../15-risks/02-open-questions.md](../15-risks/02-open-questions.md) (OQ-120…OQ-126)
