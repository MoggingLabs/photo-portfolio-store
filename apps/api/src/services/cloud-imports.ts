// F4.4 — cloud-import binding + progress.
//
// createCloudImport binds a remote folder to an event and queues a sync (the
// worker sweep does the listing/downloading). It denormalizes the event's org
// onto the row so the worker can resolve the org's connection, and requires an
// enabled connection for the provider up front (409 otherwise).

import { type DbClient, schema } from '@pkg/db';
import type { CloudProvider } from '@pkg/integrations';
import { and, eq } from 'drizzle-orm';

const { cloudImports } = schema.cloudImports;
const { integrationConfigs } = schema.integrations;
const { events } = schema.events;

export class CloudImportError extends Error {
  constructor(
    public readonly code: 'not_connected' | 'event_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'CloudImportError';
  }
}

export interface CreateImportInput {
  eventId: string;
  userId: string;
  provider: CloudProvider;
  remoteFolderId: string;
}

export interface CreateImportResult {
  importId: string;
  status: 'pending';
}

export const createCloudImport = async (
  db: DbClient,
  input: CreateImportInput,
): Promise<CreateImportResult> => {
  const evRows = await db
    .select({ orgId: events.orgId })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  const ev = evRows[0];
  if (!ev) throw new CloudImportError('event_not_found', 'event not found');

  const cfgRows = await db
    .select({
      enabled: integrationConfigs.enabled,
      encrypted: integrationConfigs.encryptedCredentials,
    })
    .from(integrationConfigs)
    .where(and(eq(integrationConfigs.orgId, ev.orgId), eq(integrationConfigs.type, input.provider)))
    .limit(1);
  const cfg = cfgRows[0];
  if (!cfg || !cfg.enabled || !cfg.encrypted) {
    throw new CloudImportError('not_connected', 'provider not connected for this org');
  }

  const inserted = await db
    .insert(cloudImports)
    .values({
      eventId: input.eventId,
      orgId: ev.orgId,
      photographerUserId: input.userId,
      provider: input.provider,
      remoteFolderId: input.remoteFolderId,
      status: 'pending',
    })
    .returning({ id: cloudImports.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error('cloud_import insert returned no id');
  return { importId: id, status: 'pending' };
};

export interface ImportProgress {
  id: string;
  status: string;
  provider: string;
  remoteFolderId: string;
  totalFiles: number | null;
  importedFiles: number;
  failedFiles: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  etaSeconds: number | null;
}

interface ProgressRow {
  id: string;
  status: string;
  provider: string;
  remoteFolderId: string;
  totalFiles: number | null;
  importedFiles: number;
  failedFiles: number;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

// Linear estimate from elapsed time and processed count. Null until the folder
// has been listed (total known) and at least one file has been processed.
const computeEta = (r: ProgressRow, nowDate: Date): number | null => {
  if (r.status !== 'running' || r.totalFiles == null || r.startedAt == null) return null;
  // Clock skew (startedAt in the future) would yield a misleadingly low ETA.
  if (r.startedAt > nowDate) return null;
  const done = r.importedFiles + r.failedFiles;
  const remaining = r.totalFiles - done;
  if (remaining <= 0) return 0;
  if (done <= 0) return null;
  const elapsedSec = Math.max((nowDate.getTime() - r.startedAt.getTime()) / 1000, 1);
  return Math.round(remaining / (done / elapsedSec));
};

export const getCloudImportProgress = async (
  db: DbClient,
  eventId: string,
  importId: string,
  now?: () => Date,
): Promise<ImportProgress | null> => {
  const rows = (await db
    .select({
      id: cloudImports.id,
      status: cloudImports.status,
      provider: cloudImports.provider,
      remoteFolderId: cloudImports.remoteFolderId,
      totalFiles: cloudImports.totalFiles,
      importedFiles: cloudImports.importedFiles,
      failedFiles: cloudImports.failedFiles,
      startedAt: cloudImports.startedAt,
      completedAt: cloudImports.completedAt,
      lastError: cloudImports.lastError,
    })
    .from(cloudImports)
    .where(and(eq(cloudImports.id, importId), eq(cloudImports.eventId, eventId)))
    .limit(1)) as ProgressRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    provider: r.provider,
    remoteFolderId: r.remoteFolderId,
    totalFiles: r.totalFiles,
    importedFiles: r.importedFiles,
    failedFiles: r.failedFiles,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    lastError: r.lastError,
    etaSeconds: computeEta(r, now ? now() : new Date()),
  };
};
