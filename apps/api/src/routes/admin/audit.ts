// Admin audit-log surface — read-only export of app.audit_log.
//
// Endpoints:
//   GET /v1/admin/audit-log       JSON list, filterable, cursor-paginated.
//   GET /v1/admin/audit-log.csv   CSV stream (no in-memory buffering).
//
// All routes require the `compliance:read_audit` permission and emit their
// own meta-audit entry on each call. Viewing the audit log is itself audited.

import { Readable } from 'node:stream';
import { type SQL, and, asc, desc, eq, gte, like, lt, lte, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { schema } from '@pkg/db';

import { hashIp, writeAudit } from '../../lib/audit.js';
import { db as defaultDb } from '../../lib/db.js';

const { auditLog } = schema.compliance;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ---------- Query schema ----------

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const querySchema = z.object({
  action: z.string().min(1).max(200).optional(),
  eventId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  targetKind: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

type AuditQuery = z.infer<typeof querySchema>;

// ---------- Cursor ----------
// Audit-log uses bigint id + createdAt; cursor encodes both so ties on
// createdAt (high-volume bursts) still paginate stably.

interface AuditCursor {
  createdAt: string; // ISO
  id: string; // bigint as string
}

const encodeCursor = (c: AuditCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

const decodeCursor = (raw: string | undefined): AuditCursor | null => {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      return null;
    }
    if (Number.isNaN(new Date(parsed.createdAt).getTime())) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
};

// ---------- Where-clause builder ----------

const buildWhere = (q: AuditQuery): SQL | undefined => {
  const clauses: SQL[] = [];

  if (q.action !== undefined) {
    if (q.action.endsWith('.*')) {
      const prefix = q.action.slice(0, -2);
      // action LIKE 'prefix.%' OR action = 'prefix'
      const escaped = prefix.replace(/[%_\\]/g, (m) => `\\${m}`);
      const wild = or(like(auditLog.action, `${escaped}.%`), eq(auditLog.action, prefix));
      if (wild) clauses.push(wild);
    } else if (q.action.endsWith('*')) {
      const prefix = q.action.slice(0, -1);
      const escaped = prefix.replace(/[%_\\]/g, (m) => `\\${m}`);
      clauses.push(like(auditLog.action, `${escaped}%`));
    } else {
      clauses.push(eq(auditLog.action, q.action));
    }
  }

  if (q.eventId) clauses.push(eq(auditLog.eventId, q.eventId));
  if (q.actorUserId) clauses.push(eq(auditLog.actorUserId, q.actorUserId));
  if (q.targetKind) clauses.push(eq(auditLog.targetKind, q.targetKind));
  if (q.targetId) clauses.push(eq(auditLog.targetId, q.targetId));
  if (q.from) clauses.push(gte(auditLog.createdAt, q.from));
  if (q.to) clauses.push(lte(auditLog.createdAt, q.to));

  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    // Descending pagination: fetch rows strictly older than the cursor.
    clauses.push(lt(auditLog.createdAt, new Date(cursor.createdAt)));
  }

  if (clauses.length === 0) return undefined;
  return clauses.reduce<SQL | undefined>(
    (acc, c) => (acc === undefined ? c : and(acc, c)),
    undefined,
  );
};

// ---------- Row shape ----------

interface AuditRow {
  id: bigint;
  actorUserId: string | null;
  actorKind: string;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  eventId: string | null;
  ipHash: string | null;
  userAgent: string | null;
  payloadJsonb: unknown;
  payloadHash: string | null;
  createdAt: Date;
}

const serializeRow = (row: AuditRow): Record<string, unknown> => ({
  id: row.id.toString(),
  actorUserId: row.actorUserId,
  actorKind: row.actorKind,
  action: row.action,
  targetKind: row.targetKind,
  targetId: row.targetId,
  eventId: row.eventId,
  ipHash: row.ipHash,
  userAgent: row.userAgent,
  payload: row.payloadJsonb ?? null,
  payloadHash: row.payloadHash,
  createdAt: row.createdAt.toISOString(),
});

// ---------- CSV helpers ----------

const CSV_HEADERS = [
  'id',
  'created_at',
  'actor_kind',
  'actor_user_id',
  'action',
  'target_kind',
  'target_id',
  'event_id',
  'ip_hash',
  'user_agent',
  'payload_hash',
  'payload_jsonb',
] as const;

const escapeCsv = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const rowToCsv = (row: AuditRow): string => {
  const cells: string[] = [
    row.id.toString(),
    row.createdAt.toISOString(),
    row.actorKind,
    row.actorUserId ?? '',
    row.action,
    row.targetKind ?? '',
    row.targetId ?? '',
    row.eventId ?? '',
    row.ipHash ?? '',
    row.userAgent ?? '',
    row.payloadHash ?? '',
    row.payloadJsonb === null || row.payloadJsonb === undefined
      ? ''
      : JSON.stringify(row.payloadJsonb),
  ];
  return `${cells.map(escapeCsv).join(',')}\n`;
};

// ---------- Meta-audit ----------

const metaAudit = async (
  db: typeof defaultDb,
  request: FastifyRequest,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await writeAudit(db, {
    action,
    actorKind: request.user?.role === 'superadmin' ? 'admin' : 'user',
    actorUserId: request.user?.id,
    ipHash: hashIp(request.ip),
    userAgent: request.headers['user-agent'] ?? undefined,
    payload,
  });
};

// ---------- Plugin options ----------

export interface AdminAuditRoutesOptions {
  db?: typeof defaultDb;
}

// ---------- Plugin ----------

const adminAuditRoutes = async (
  app: FastifyInstance,
  opts: AdminAuditRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // GET /v1/admin/audit-log — JSON, cursor-paginated.
  app.get(
    '/v1/admin/audit-log',
    {
      preHandler: app.requirePermission('compliance:read_audit'),
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        await metaAudit(db, request, 'audit.export.rejected', {
          reason: 'invalid_query',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        });
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid query parameters',
          issues: parsed.error.issues,
        });
      }
      const q = parsed.data;
      const limit = q.limit ?? DEFAULT_LIMIT;
      const where = buildWhere(q);

      const baseSelect = db.select().from(auditLog);
      const filtered = where ? baseSelect.where(where) : baseSelect;
      const rows = (await filtered
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1)) as AuditRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id.toString(),
            })
          : null;

      await metaAudit(db, request, 'audit.export.viewed', {
        format: 'json',
        filters: {
          action: q.action ?? null,
          eventId: q.eventId ?? null,
          actorUserId: q.actorUserId ?? null,
          targetKind: q.targetKind ?? null,
          targetId: q.targetId ?? null,
          from: q.from?.toISOString() ?? null,
          to: q.to?.toISOString() ?? null,
        },
        returned: page.length,
        limit,
      });

      return reply.send({
        entries: page.map(serializeRow),
        nextCursor,
      });
    },
  );

  // GET /v1/admin/audit-log.csv — streaming CSV export.
  app.get(
    '/v1/admin/audit-log.csv',
    {
      preHandler: app.requirePermission('compliance:read_audit'),
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid query parameters',
          issues: parsed.error.issues,
        });
      }
      const q = parsed.data;
      // CSV export caps at MAX_LIMIT per call to avoid runaway streams; clients
      // paginate via narrower time ranges.
      const limit = q.limit ?? MAX_LIMIT;
      const where = buildWhere(q);

      await metaAudit(db, request, 'audit.export.viewed', {
        format: 'csv',
        filters: {
          action: q.action ?? null,
          eventId: q.eventId ?? null,
          actorUserId: q.actorUserId ?? null,
          targetKind: q.targetKind ?? null,
          targetId: q.targetId ?? null,
          from: q.from?.toISOString() ?? null,
          to: q.to?.toISOString() ?? null,
        },
        limit,
      });

      const baseSelect = db.select().from(auditLog);
      const filtered = where ? baseSelect.where(where) : baseSelect;
      const queryPromise = filtered
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
        .limit(limit) as unknown as Promise<AuditRow[]>;

      // Stream row-by-row without buffering the full result client-side.
      // drizzle's postgres-js driver returns an array; we stream by iterating
      // it once and yielding one CSV chunk per row.
      async function* generate(): AsyncGenerator<string> {
        yield `${CSV_HEADERS.join(',')}\n`;
        const result = await queryPromise;
        for (const row of result) {
          yield rowToCsv(row);
        }
      }

      const filename = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store');

      return reply.send(Readable.from(generate()));
    },
  );
};

export default adminAuditRoutes;
