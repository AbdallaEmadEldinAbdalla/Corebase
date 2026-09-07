-- The `storage` schema (P6a, D-017, D-120, storage architecture §2).
--
-- Object *metadata* lives in the project's own database, not the control plane,
-- and that placement is load-bearing twice: RLS on these tables **is** the file
-- permission system — there is no second ACL engine anywhere — and `corebase
-- export` carries a customer's file inventory out with a plain `pg_dump`.
--
-- In the image rather than in a saga step, for the same three reasons as the auth
-- schema: it is fleet-wide, identical for every project, and initdb is the one
-- moment at which no client can observe a half-created schema.

CREATE SCHEMA IF NOT EXISTS storage;

-- ── buckets ────────────────────────────────────────────────────────────────────
CREATE TABLE storage.buckets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE
                       CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  public             boolean NOT NULL DEFAULT false,
  file_size_limit    bigint CHECK (file_size_limit IS NULL OR file_size_limit > 0),
  allowed_mime_types text[],
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ── objects ────────────────────────────────────────────────────────────────────
--
-- The R2 key is **derived**, never stored: `projects/<ref>/<bucket>/<name>`.
-- Storing it would denormalise the project ref into every row and complicate
-- export, and the ref is immutable so there is nothing to keep in step.
CREATE TABLE storage.objects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id    uuid NOT NULL REFERENCES storage.buckets(id),
  -- The path check is the first line of the isolation argument: object keys are
  -- assembled from the *authenticated* project ref plus this name, so a name
  -- containing `..` or a leading slash is the one input that could climb out of
  -- the prefix. Rejected in the column, not only in the service, because a
  -- service-only check is one refactor away from being skipped.
  name         text NOT NULL
                 CHECK (name !~ '(^|/)\.\.(/|$)' AND name !~ '^/' AND length(name) <= 1024),
  owner        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  mime_type    text NOT NULL DEFAULT 'application/octet-stream',
  etag         text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A placeholder column, not a feature: V1 overwrites in place. Modelled now
  -- because retrofitting a primary key later is expensive.
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);

-- `text_pattern_ops` because prefix listing is `name LIKE 'folder/%'`, and the
-- default opclass cannot serve that under a non-C collation.
CREATE INDEX objects_bucket_prefix_idx
  ON storage.objects (bucket_id, name text_pattern_ops);
CREATE INDEX objects_owner_idx ON storage.objects (owner);

-- No `ON DELETE CASCADE` from objects → buckets, deliberately: a cascade could
-- orphan millions of stored objects in one statement with nothing to trigger a
-- sweep. Bucket deletion requires an empty bucket, enforced by the service.

-- ── presigned-upload intents (D-122) ──────────────────────────────────────────
--
-- The > 50 MB path cannot write a real row until the bytes exist, and the bytes
-- arrive at the object store without us watching. An intent is what makes the
-- gap recoverable: it records what was authorised, so a completion callback can
-- be checked against it and an abandoned upload can be swept.
CREATE TABLE storage.upload_intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id      uuid NOT NULL REFERENCES storage.buckets(id),
  name           text NOT NULL
                   CHECK (name !~ '(^|/)\.\.(/|$)' AND name !~ '^/' AND length(name) <= 1024),
  owner          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- What the presigned URL was signed for. Checked again at completion, so a
  -- leaked URL cannot be repurposed for a different file shape.
  declared_size  bigint NOT NULL CHECK (declared_size >= 0),
  content_type   text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_intents_expiry_idx ON storage.upload_intents (expires_at);

-- ── the path-prefix helper ────────────────────────────────────────────────────
--
-- Every documented policy pattern uses this: `storage.prefix_owner('42/a.png')`
-- is `'42'`, so a policy can say "this user owns their own folder". Plain SQL and
-- IMMUTABLE, so it is exportable (D-004) and the planner can fold it.
CREATE FUNCTION storage.prefix_owner(name text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT split_part(name, '/', 1) $$;

-- ── the bucket lookup a policy can actually perform ───────────────────────────
--
-- Every documented object policy is of the shape
-- `bucket_id = (SELECT id FROM storage.buckets WHERE name = 'avatars')`, and that
-- subselect **runs as the caller**. `storage.buckets` is RLS-enabled with no
-- policies, so as `anon` or `authenticated` it returns no rows, the comparison is
-- against NULL, and the predicate is false for every row.
--
-- The consequence is worse than a refusal: reads return an empty list and writes
-- affect *zero rows without error*, so a customer following the documentation
-- sees a policy that appears to install correctly and silently governs nothing.
--
-- SECURITY DEFINER fixes it the same way P5d's cookbook fixes a policy that must
-- read a membership table the caller cannot: the lookup runs as the owner, so the
-- policy can resolve a bucket name without the caller needing to see the bucket
-- list. That keeps `GET /bucket` RLS-filtered as designed while making the object
-- policies work.
--
-- It leaks nothing an authorised caller could not already learn: a bucket's id
-- for a name they had to know to ask. `search_path` is pinned, as it must be in
-- every SECURITY DEFINER function.
CREATE FUNCTION storage.bucket_id(bucket_name text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$ SELECT id FROM storage.buckets WHERE name = bucket_name $$;

-- The config the *service* enforces with, for the same reason and by the same
-- mechanism (P6c).
--
-- Size limits, the MIME allowlist and the `public` flag are platform enforcement
-- inputs, not the caller's data: the service has to read them to decide whether
-- to accept bytes at all, and it has to read them for an *unauthenticated*
-- request too — a public-bucket GET has no caller identity and still needs to
-- know the bucket is public.
--
-- Reading them as the caller would mean a customer whose object policy permits an
-- upload could still not upload, because their bucket policy happened not to let
-- them see the bucket's row. That is a confusing failure with no good error
-- message, and the enforcement values are not what bucket RLS exists to protect.
--
-- The deliberate leak, stated plainly: this tells anyone who can name a bucket
-- whether it exists and what its limits are. `storage.bucket_id` already leaks
-- existence to the same caller — policies need it to — so the increment is the
-- limits, and a size limit is not a secret.
CREATE FUNCTION storage.bucket_config(bucket_name text)
  RETURNS TABLE (id uuid, is_public boolean, file_size_limit bigint, allowed_mime_types text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT b.id, b.public, b.file_size_limit, b.allowed_mime_types
      FROM storage.buckets b WHERE b.name = bucket_name
  $$;

-- ── quota accounting, fast path ───────────────────────────────────────────────
--
-- One row, maintained by a trigger, so an upload can check quota with a
-- single-row read instead of a `sum()` over every object the project owns. The
-- daily sweep's true-up is the authority when the two disagree; this is the
-- number the hot path is allowed to trust.
CREATE TABLE storage.usage (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),   -- exactly one row
  total_bytes  bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  object_count bigint NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO storage.usage (id) VALUES (true);

-- SECURITY DEFINER, and that is the point: the trigger fires as whichever role
-- inserted the object — `authenticated`, typically — and that role has no
-- business writing the usage table directly. Without DEFINER every upload would
-- fail on a permission error inside the trigger, which reads as the upload being
-- refused rather than the bookkeeping being misconfigured.
--
-- `search_path` is pinned, as it must be in every SECURITY DEFINER function:
-- unpinned, a caller could shadow `storage.usage` and have this run as the owner.
CREATE FUNCTION storage.track_usage() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE storage.usage
       SET total_bytes = total_bytes + NEW.size,
           object_count = object_count + 1,
           updated_at = now();
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE storage.usage
       SET total_bytes = GREATEST(0, total_bytes - OLD.size),
           object_count = GREATEST(0, object_count - 1),
           updated_at = now();
  ELSE
    -- An overwrite keeps the row and changes the bytes, so only the delta moves.
    UPDATE storage.usage
       SET total_bytes = GREATEST(0, total_bytes - OLD.size + NEW.size),
           updated_at = now();
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER objects_track_usage
  AFTER INSERT OR DELETE OR UPDATE OF size ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION storage.track_usage();

-- ── the posture ───────────────────────────────────────────────────────────────
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.upload_intents ENABLE ROW LEVEL SECURITY;

-- No policies. Like a customer's own tables, everything is denied to `anon` and
-- `authenticated` until the customer writes one; `service_role` bypasses by role
-- attribute (D-082).

REVOKE ALL ON SCHEMA storage FROM PUBLIC;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.prefix_owner(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.bucket_id(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.bucket_config(text) TO anon, authenticated, service_role;

-- **Table privileges go to `anon` as well as `authenticated`, which departs from
-- D-108's asymmetry, and the departure is deliberate** (D-391).
--
-- D-108 withholds grants from `anon` on *customer* tables so that a newly created
-- table cannot be publicly dumped by an accidental policy — and there the
-- customer owns the table and can `GRANT` when they mean to. `storage.objects` is
-- platform DDL with a fixed shape, and the documented way to open a bucket to the
-- public is a policy naming `TO anon`. Withholding the grant would make every
-- documented example fail with a privilege error rather than work, and the safety
-- D-108 buys is already provided here by RLS being enabled with zero policies:
-- the table is closed on arrival either way.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.upload_intents TO authenticated, service_role;

-- `storage.usage` is platform bookkeeping, not customer data.
--
-- Write access belongs to nobody: the trigger updates it as its own owner
-- (SECURITY DEFINER above), so a customer cannot fabricate headroom by editing
-- their quota row — enforced by the absence of a grant rather than by a policy,
-- which is the stronger of the two because there is no policy to get wrong.
--
-- Read access belongs to `service_role` alone, and it is not optional: the
-- storage service checks `usage.total_bytes + declared_size <= plan_quota`
-- before accepting a single byte, and it connects as `service_role`. Revoking
-- everything and granting nobody — which is what the first version of this file
-- did — makes every upload fail its quota check on a permission error.
REVOKE ALL ON storage.usage FROM PUBLIC;
GRANT SELECT ON storage.usage TO service_role;
