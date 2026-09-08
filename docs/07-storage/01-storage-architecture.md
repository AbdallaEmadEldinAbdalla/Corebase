# Storage Architecture

## Purpose

Specifies the object-storage subsystem promised in proposal §21–22: metadata in each project's Postgres, bytes in S3-compatible object storage — **R2 in production, MinIO locally** (D-017, D-023, D-027). This doc fixes the physical bucket layout, the `storage` schema DDL, the storage service's place in the monolith, and the upload/download data paths. The API surface, authorization model, and consistency machinery are in [02-storage-api-and-policies.md](02-storage-api-and-policies.md).

Terminology guard: **"bucket" means two different things here.** A *Steadhold bucket* is a logical namespace a customer creates (`avatars`, `invoices`) and is a row in their project's `storage.buckets`. An *R2 bucket* is the physical Cloudflare resource. The mapping between them is the first design question below.

## Design

### 1. Physical layout: one R2 bucket per region, prefixes per project

Two candidate layouts:

| Criterion | R2 bucket per project | Shared R2 bucket per region, prefix per project |
|---|---|---|
| R2 account limits | Cloudflare caps buckets per account (order of 1,000); dies at ~1k projects — a hard ceiling below our free-tier ambitions | No per-project resource; scales to millions of prefixes |
| Provisioning | One more remote API call in the provisioning saga; one more thing to fail, retry, and reconcile | Zero storage-side provisioning work per project — prefix exists implicitly on first write |
| Credential isolation | Could scope one R2 API token per bucket — but tokens-per-project is its own management burden, and customers never touch R2 anyway (see §3) | One credential per region held by the storage service; isolation enforced in our authorization layer, same trust model as the DB pooler |
| Lifecycle rules | Per-bucket rules possible (nice for per-plan retention) | R2 lifecycle rules apply per bucket but accept **prefix filters**, so per-project/per-plan rules remain expressible; sweeps handle the rest |
| Deletion (D-038) | Delete the bucket — atomic and satisfying | List-and-delete under `projects/<ref>/` — a paged batch job, already required for the reconciliation sweep, so no new machinery |
| Blast radius | A leaked per-bucket token exposes one project | A leaked region token exposes the region — mitigated by the token living only in the storage service (D-035 envelope encryption at rest, memory-only at runtime), never in customer hands |
| Export (D-004) | Trivial per-project listing | Equally trivial: list by prefix |

**Decision: shared bucket per region with per-project prefixes (D-120).** The per-project-bucket ceiling is disqualifying on its own; everything else is a wash or favors shared. Object keys are:

```
projects/<project_ref>/<steadhold_bucket>/<object_path>
```

`project_ref` is the immutable slug from [the control-plane data model](../02-control-plane/01-data-model.md), so keys never need rewriting on project rename. One R2 bucket per region (`steadhold-eu-central-prod`) — exactly one at launch, per D-024.

Isolation consequence, stated plainly: **project isolation in object storage is enforced by the storage service's key construction, not by R2.** The service derives the `projects/<ref>/` prefix from the authenticated project context ([request pipeline](../04-data-api/02-request-pipeline.md)) and never from client input; object paths are normalized and rejected if they contain `..`, empty segments, or encoded separators before key assembly. This is the same trust position the gateway already holds for SQL routing (D-016) and it is covered by the cross-tenant suite in [tenant isolation tests](../06-security/03-tenant-isolation-tests.md).

Per-project encryption: R2 encrypts at rest with provider-managed keys by default. Per-project keys (SSE-C or client-side envelope encryption with per-project data keys under D-035's KMS) would make a leaked region token useless against object *contents* and would give cryptographic-erasure deletion. It also breaks presigned direct uploads (client would need the key) and adds a KMS dependency to every GET. Deferred, not dismissed — tracked as OQ-121.

### 2. The `storage` schema — in each project's database

Object *metadata* lives in the **project's own Postgres**, not the control plane (D-017). This placement is load-bearing twice over:

1. **RLS on files works.** Authorization for storage operations is evaluated by querying these tables under the caller's RLS context — the exact pipeline the data API already has ([RLS design](../06-security/02-rls-design.md)). Policies on `storage.objects` *are* the file-permission system; no parallel ACL engine exists.
2. **Export stays clean (D-004).** `steadhold export` dumps the project DB, and the tarball's dedicated `storage/manifest.jsonl` (the format D-137 specifies) is derived directly from `storage.objects` — a real file in the tarball, but trivially regenerable from the dump. Bytes are fetched by walking `storage.objects` — no control-plane join required.

DDL (part of every project's base migration, alongside the `auth` schema):

```sql
CREATE SCHEMA storage;

CREATE TABLE storage.buckets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE
                       CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  public             boolean NOT NULL DEFAULT false,
  file_size_limit    bigint,          -- bytes; NULL = project plan default
  allowed_mime_types text[],          -- NULL = any; matched against declared type
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage.objects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id    uuid NOT NULL REFERENCES storage.buckets(id),
  name         text NOT NULL            -- full path within the bucket, e.g. 'avatars/42/photo.png'
                 CHECK (name !~ '(^|/)\.\.(/|$)' AND name !~ '^/' AND length(name) <= 1024),
  owner        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  mime_type    text NOT NULL DEFAULT 'application/octet-stream',
  etag         text NOT NULL,           -- from the object store's PUT response
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- user key/value, cache-control, etc.
  version      integer NOT NULL DEFAULT 1,          -- reserved for future object versioning
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);

CREATE INDEX objects_bucket_prefix_idx
  ON storage.objects (bucket_id, name text_pattern_ops);  -- prefix listing
CREATE INDEX objects_owner_idx ON storage.objects (owner);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
-- No default policies: like customer tables, everything is denied to anon/authenticated
-- until the customer writes policies (D-036 applies to storage too). service_role and the
-- storage service's own maintenance role bypass per D-029 semantics.
```

Notes:

- `version` is a placeholder column, not a feature: V1 overwrites in place (new etag, `updated_at` bump). Real versioning would add a `(bucket_id, name, version)` key and R2 key suffixes — modeled now because retrofitting a primary key is expensive (same reasoning as D-031).
- Bucket deletion requires the bucket to be empty (service-enforced), so no `ON DELETE CASCADE` from objects → buckets; a cascade here could orphan up to millions of R2 objects in one statement with no sweep trigger.
- The R2 key is **derived**, never stored: `projects/<ref>/<bucket.name>/<object.name>`. Storing it would denormalize the project ref into every row and complicate export.

### 3. The storage service: a monolith module holding the only R2 credentials

The storage service is a module inside the data-plane monolith, structured exactly like auth (D-013, D-020, [repo layout](../01-architecture/05-repo-and-service-layout.md)): its own routes, its own module boundary, splittable later if bandwidth profiles demand it. It serves:

```
https://<ref>.steadhold.app/storage/v1/*
```

routed by the same gateway → project-resolution → authn pipeline as `/rest/v1` and `/auth/v1` ([request pipeline](../04-data-api/02-request-pipeline.md)).

**Customers never receive raw R2 credentials (D-121).** The region-scoped R2 token is a platform secret under D-035 (envelope-encrypted at rest, decrypted into service memory at boot). Everything a client can do — including "direct" uploads — is mediated by URLs the service signs or requests the service proxies. This is what keeps D-120's shared-bucket trust model sound and keeps the R2 account swappable (provider abstraction, D-023: the service speaks the S3 API, so MinIO locally and any S3-compatible store later).

### 4. Upload path: proxy for small, presigned-direct for large (D-122)

| Criterion | Proxy through storage service | Presigned PUT direct to R2 |
|---|---|---|
| Bandwidth cost | Every byte transits a Hetzner node twice (in from client, out to R2); node NICs and the service become the throughput ceiling | Bytes go client → Cloudflare → R2; near-zero load on our nodes |
| Metadata consistency | Service observes the PUT completing — can write the `storage.objects` row with true size/etag immediately | Service learns of completion only via client callback (lies, crashes) or reconciliation |
| Enforcement (size/MIME) | Inline: stream-count bytes, abort at limit; sniff magic bytes on the first chunk | Size cap via signed `content-length-range` policy; MIME sniffing impossible until after the fact |
| Client complexity | One `POST`, works from a `<form>` | Two round-trips + callback; SDK hides it, raw HTTP users suffer |

Neither answer is right for both a 40 KB avatar and a 4 GB video, so V1 ships both with a hard threshold:

- **≤ 50 MB: proxy.** The service streams the body to R2 (`PUT`, or multipart when the SDK sends chunked), counting bytes against `file_size_limit` and sniffing magic bytes inline, then inserts the metadata row. Covers the overwhelming majority of BaaS uploads with the strongest consistency and enforcement.
- **> 50 MB: presigned direct.** Client calls `createSignedUploadUrl`; the service validates bucket policy *first* (RLS check on the intended path), issues a short-lived presigned R2 PUT with a `content-length-range` cap, and records a **pending-upload intent row**; the client PUTs to R2, then calls a completion callback; the service `HEAD`s the object to read true size/etag and finalizes the row. Abandoned intents (no callback) are cleaned by the same reconciliation sweep that handles orphans ([02-storage-api-and-policies.md](02-storage-api-and-policies.md) §consistency).

50 MB is a tunable constant, not architecture (OQ-122). The cost model for proxy bandwidth at scale lives in the [cost model](../12-business/01-cost-model.md) — note that R2's zero egress (the reason for D-017) does not make *our node* ingress free.

### 5. Public buckets and the CDN path

Objects in buckets with `public = true` are readable without authentication at:

```
https://<ref>.steadhold.app/storage/v1/object/public/<bucket>/<path>
```

- Public objects ride the **project origin**: the [domain & region model](../01-architecture/04-domain-and-region-model.md) drops proposal §61's `<ref>.storage.steadhold.app` host in V1 — a two-label subdomain is not covered by the `*.steadhold.app` wildcard (D-057), and a second wildcard cert plus routing tier buys zero V1 benefit. The dedicated storage host returns with the custom-domain/PSL work (OQ-057/OQ-062).
- Cloudflare caches the public-object paths on the project origin — a cache rule keyed on `/storage/v1/object/public/*` (the rest of the origin stays uncached, like the other API paths): `Cache-Control: public, max-age=3600` default, overridable per object via `metadata`. Cache hits never touch our nodes — this is the free-tier bandwidth story.
- Origin behavior: the storage service verifies `bucket.public` from the project DB (result cached in-process for 30 s), then streams from R2. Public reads deliberately skip per-object RLS — "public bucket" means the *bucket* is the ACL.
- **Cache invalidation:** on object delete or overwrite, the service enqueues a Cloudflare purge-by-URL job (BullMQ, idempotent per D-018). Purge is best-effort and rate-limited by Cloudflare, so the honest contract is: *public-bucket content may be served stale up to `max-age` after overwrite/delete*. Latency-sensitive replacement should upload under a new path (content-hashed filenames — documented as the recommended pattern). Purge-API quota behavior at scale is OQ-123.

### 6. Image transformations: deferred to V1.2

On-the-fly image resizing/format conversion (`?width=200&format=webp`) is explicitly **out of V1** and slotted with the [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md). Two reasons: it is a separate CPU-bound service with its own cache keyspace, and — the abuse note — **transformation endpoints are a free CPU-burning primitive**: anyone can request unbounded distinct `(object, width, quality, format)` tuples, each a fresh decode/encode on our nodes. Shipping it responsibly requires per-project transform quotas, a variant cache, and parameter clamping ([abuse prevention](../12-business/03-abuse-prevention.md)) — none of which V1 should pay for. Until then, resize client-side or store pre-rendered variants.

## Decisions

- **D-120 — One R2 bucket per region; projects are key prefixes (`projects/<ref>/<bucket>/<path>`), not R2 buckets.** *(Rationale: R2 per-account bucket limits are a hard ceiling below free-tier scale; shared-with-prefixes needs zero per-project provisioning, keeps lifecycle rules expressible via prefix filters, and its weaker physical isolation is acceptable because the only R2 credential never leaves the storage service. Per-project encryption keys deferred to OQ-121.)*
- **D-121 — The storage service is a module of the data-plane monolith serving `/storage/v1/*`, and is the sole holder of R2 credentials; customers never receive raw object-store credentials in any form.** *(Rationale: mirrors the auth-module precedent (D-013/D-020); credential confinement is what makes D-120's shared bucket safe and keeps the S3-compatible backend swappable per D-023/D-027.)*
- **D-122 — Dual upload path: proxy-through-service for objects ≤ 50 MB (inline size/MIME enforcement, immediate metadata write); presigned direct-to-R2 PUT with intent row + completion callback + sweep for objects > 50 MB.** *(Rationale: proxying everything makes node bandwidth the ceiling and burns margin; presigning everything forfeits inline enforcement and metadata consistency for the 99% case of small files. The threshold buys each path where it is strong; 50 MB is tunable — OQ-122.)*

## Open Questions

- **OQ-120 — Bucket-level quotas:** should `storage.buckets` grow a `size_limit` (aggregate bytes per bucket) in V1, or is the per-project quota ([02-storage-api-and-policies.md](02-storage-api-and-policies.md)) enough until customers ask?
- **OQ-121 — Per-project object encryption:** adopt SSE-C or client-side envelope encryption with per-project data keys (D-035 KMS) for cryptographic erasure and leaked-token containment, at the cost of breaking presigned direct uploads and adding KMS latency to reads? Decide before any compliance-driven customer segment (V2+).
- **OQ-122 — Proxy/presign threshold:** is 50 MB right? Needs measurement of real node NIC headroom and the p99 upload-size distribution once beta traffic exists; also interacts with R2's 5 MB minimum multipart part size.
- **OQ-123 — Purge-by-URL quotas:** Cloudflare rate-limits purge calls; at what overwrite volume does purging need batching or a switch to content-hashed-key-only guidance?

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-017, D-023, D-024, D-027, D-035, D-038), [../01-architecture/04-domain-and-region-model.md](../01-architecture/04-domain-and-region-model.md), [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../03-database-platform/03-credentials-and-secrets.md](../03-database-platform/03-credentials-and-secrets.md)
- Feeds: [02-storage-api-and-policies.md](02-storage-api-and-policies.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../10-cli-and-sdk/01-cli-spec.md](../10-cli-and-sdk/01-cli-spec.md) (export, D-004), [../12-business/01-cost-model.md](../12-business/01-cost-model.md), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md), [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md) (image transforms, V1.2)
