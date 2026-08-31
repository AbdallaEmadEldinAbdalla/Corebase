import type { Pool, PoolClient } from 'pg';

/**
 * The audit writer (§59, D-039).
 *
 * One rule shapes the whole module: **an audit row is written in the same
 * transaction as the mutation it describes.** Not after it, not best-effort. A
 * mutation that can succeed without its audit row produces exactly the history
 * you cannot trust — the one where absence of evidence means nothing, because
 * absence is also what a crashed process looks like. So `writeAudit` takes the
 * caller's client rather than a pool of its own, and joining the transaction is
 * the only supported use.
 *
 * The second rule: **metadata never contains a secret.** Not because callers are
 * careless, but because they will one day pass a whole request body, and
 * audit_logs is append-only — a secret written here cannot be deleted. Redaction
 * therefore looks at values as well as keys, since keys get renamed and values
 * keep their shape.
 */

/** Anything that can run a query: a pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

export type ActorType = 'user' | 'system' | 'operator' | 'api_key';

export interface Actor {
  type: ActorType;
  /** NULL for system, operator tokens and API keys. */
  userId?: string | null;
  ip?: string | null;
  /** D-032 correlation: ties the audit row to the request and its log lines. */
  requestId?: string | null;
}

export interface AuditEvent {
  /** Dotted and past-tense: `project.created`, `secret.updated`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

/** The system actor, for state changes no human asked for directly. */
export const SYSTEM: Actor = { type: 'system', userId: null };

/**
 * Keys whose values are never recorded. Matched loosely on purpose — a key
 * called `db_password_new` is exactly as dangerous as one called `password`.
 */
const SECRET_KEY = /pass|secret|token|credential|authorization|cookie|private|_key$|^key$|dek|kek/i;

/**
 * Names that match the pattern above but hold no secret material. Without this
 * list the redactor eats exactly the fields an audit row is read for — the first
 * live trail showed `idempotency_key: "[redacted]"`, which loses the answer to
 * "which retry created this project" for no benefit at all.
 *
 * The bar for adding a name here: it identifies something rather than granting
 * access to it. `kek_id` names a key file; it is not the key.
 */
const NOT_SECRET_KEY = new Set([
  'idempotency_key', 'kek_id', 'key_prefix', 'key_id', 'public_key', 'ssh_key_fingerprint',
]);

/**
 * Values that look like secrets regardless of the key they arrived under. This
 * is the half that keeps working after someone renames a field.
 */
const SECRET_VALUE: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'pem-private-key'],
  [/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'jwt'],
  [/^[A-Za-z0-9_-]{43}$/, 'generated-secret'],          // packages/crypto's shape
  [/^postgres(ql)?:\/\/[^:]+:[^@]+@/, 'connection-string-with-password'],
];

export const REDACTED = '[redacted]';

/** Serialized metadata cap. Append-only plus unbounded is a disk problem. */
const MAX_METADATA_BYTES = 8 * 1024;

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    for (const [pattern, label] of SECRET_VALUE) {
      if (pattern.test(value)) return `${REDACTED}:${label}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return redact(value as Record<string, unknown>);
  return value;
}

/** Deep-redact by key name and by value shape. Exported so callers can test it. */
export function redact(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const named = SECRET_KEY.test(key) && !NOT_SECRET_KEY.has(key.toLowerCase());
    // Even an allowlisted key still gets its *value* checked: a field called
    // `key_prefix` holding a whole JWT is a mistake worth catching.
    out[key] = named ? REDACTED : redactValue(value);
  }
  return out;
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '{}';
  const json = JSON.stringify(redact(metadata));
  if (Buffer.byteLength(json) <= MAX_METADATA_BYTES) return json;
  // Truncate rather than reject: losing the audit row entirely because its
  // metadata was fat is a worse outcome than losing the metadata.
  return JSON.stringify({
    truncated: true,
    reason: `metadata exceeded ${MAX_METADATA_BYTES} bytes`,
    bytes: Buffer.byteLength(json),
    preview: json.slice(0, 512),
  });
}

/**
 * Write one audit row.
 *
 * Pass the client of the transaction performing the mutation. Passing a pool
 * works and is correct for events that have no transaction to join (a worker
 * state change, say), but it means the row can exist without the mutation and
 * vice versa — so prefer the client wherever one exists.
 */
export async function writeAudit(
  q: Queryable, actor: Actor, event: AuditEvent,
): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs
       (organization_id, project_id, actor_user_id, actor_type,
        action, resource_type, resource_id, metadata, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      event.organizationId ?? null,
      event.projectId ?? null,
      actor.userId ?? null,
      actor.type,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      serializeMetadata(event.metadata),
      actor.ip ?? null,
      actor.requestId ?? null,
    ]);
}

/**
 * Read an entity's history, newest first. Exists so the dashboard and support do
 * not each invent a query over an append-only table with two indexes.
 */
export interface AuditRow {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_type: ActorType;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
}

export async function readProjectAudit(
  q: Queryable, projectId: string, limit = 50,
): Promise<AuditRow[]> {
  const { rows } = await q.query<AuditRow>(
    `SELECT id::text, action, resource_type, resource_id, actor_type, actor_user_id,
            metadata, request_id,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS created_at
       FROM audit_logs
      WHERE project_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`, [projectId, Math.min(limit, 200)]);
  return rows;
}
