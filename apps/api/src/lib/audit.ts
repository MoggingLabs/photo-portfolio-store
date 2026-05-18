// Centralized audit-log writer for app.audit_log.
//
// Every privacy / biometric / admin / rbac action MUST funnel through
// writeAudit(). Audit writes are best-effort: insert failures are logged and
// swallowed so user-facing flows are never blocked by audit infrastructure.
//
// AuditEntry is intentionally a thin, additive shape: other agents may extend
// it with extra optional fields, but the existing fields and their meaning
// must remain stable so callers don't break.

import { createHash } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

import { canonicalize } from './canonical-json.js';

const { auditLog } = schema.compliance;

export type AuditActorKind = 'user' | 'system' | 'cron' | 'admin' | 'webhook';

export interface AuditEntry {
  action: string;
  actorKind: AuditActorKind;
  actorUserId?: string;
  targetKind?: string;
  targetId?: string;
  eventId?: string;
  ipHash?: string;
  userAgent?: string;
  payload?: Record<string, unknown>;
}

const computePayloadHash = (payload: Record<string, unknown> | undefined): string | null => {
  if (!payload) return null;
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
};

/**
 * SHA-256 of an IP address, hex-encoded. Returns undefined for falsy input.
 * Centralized so all callers hash identically.
 */
export const hashIp = (ip: string | null | undefined): string | undefined => {
  if (!ip) return undefined;
  return createHash('sha256').update(ip, 'utf8').digest('hex');
};

/**
 * Append a row to app.audit_log. Never throws — failures are logged.
 *
 * payload_hash is sha256 of canonical-JSON(payload); null when payload is
 * absent. The hash provides tamper-detection for the JSON payload column.
 */
export const writeAudit = async (db: DbClient, entry: AuditEntry): Promise<void> => {
  try {
    await db.insert(auditLog).values({
      action: entry.action,
      actorKind: entry.actorKind,
      actorUserId: entry.actorUserId ?? null,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      eventId: entry.eventId ?? null,
      ipHash: entry.ipHash ?? null,
      userAgent: entry.userAgent ?? null,
      payloadJsonb: entry.payload ?? null,
      payloadHash: computePayloadHash(entry.payload),
    });
  } catch (error) {
    // Audit must not break user-facing flows.
    // eslint-disable-next-line no-console
    console.error('[audit] insert failed', {
      action: entry.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Soft startup guard: verify that the database refuses UPDATE/DELETE against
 * app.audit_log. DB-level enforcement (trigger) lands in a future migration;
 * until then this is best-effort and only logs a warning. Never throws.
 *
 * Implementation: runs `EXPLAIN` on representative UPDATE and DELETE
 * statements. If EXPLAIN succeeds (no trigger installed yet), logs a warning.
 */
export const assertAuditLogAppendOnly = async (db: DbClient): Promise<void> => {
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.warn(`[audit] append-only check: ${msg}`);
  };
  try {
    await db.execute(sql`explain update app.audit_log set action = action where id = -1`);
    log(
      'UPDATE against app.audit_log is not rejected by the database — append-only trigger missing. Add the trigger in a future migration.',
    );
  } catch {
    // Trigger present (or table missing); nothing to do.
  }
  try {
    await db.execute(sql`explain delete from app.audit_log where id = -1`);
    log(
      'DELETE against app.audit_log is not rejected by the database — append-only trigger missing. Add the trigger in a future migration.',
    );
  } catch {
    // Trigger present (or table missing); nothing to do.
  }
};
