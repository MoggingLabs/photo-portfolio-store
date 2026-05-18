// Slim audit writer mirroring apps/api/src/lib/audit.ts. Worker actions are
// always actorKind='system'. Failures are swallowed; pipelines must not stall
// on audit infrastructure.

import { createHash } from 'node:crypto';
import { type DbClient, schema } from '@pkg/db';

import { logger } from './logger.js';

const { auditLog } = schema.compliance;

export interface WorkerAuditEntry {
  action: string;
  targetKind?: string;
  targetId?: string;
  eventId?: string;
  payload?: Record<string, unknown>;
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
};

const payloadHash = (payload: Record<string, unknown> | undefined): string | null =>
  payload ? createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex') : null;

export const writeWorkerAudit = async (db: DbClient, entry: WorkerAuditEntry): Promise<void> => {
  try {
    await db.insert(auditLog).values({
      action: entry.action,
      actorKind: 'system',
      actorUserId: null,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      eventId: entry.eventId ?? null,
      ipHash: null,
      userAgent: null,
      payloadJsonb: entry.payload ?? null,
      payloadHash: payloadHash(entry.payload),
    });
  } catch (error) {
    logger.error(
      { action: entry.action, err: error instanceof Error ? error.message : String(error) },
      'audit insert failed',
    );
  }
};
