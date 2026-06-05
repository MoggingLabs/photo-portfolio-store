// F4.4 — Google Drive / Dropbox import sweep.
//
// Each tick processes a few pending/running cloud_imports. For a pending import
// we list the folder once and seed a cloud_import_files row per file (the
// listing snapshot is stored on the row so later ticks never re-list); files
// with no size or an unsupported type are pre-failed. Then we process a bounded
// batch of still-pending files: stream the bytes to R2, insert a photos row in
// 'processing', enqueue the ingest fan-out, and only THEN mark the file
// 'imported' — so a crash mid-file simply retries next tick (the unique
// (import, content_hash) index prevents duplicate rows). OAuth tokens are
// decrypted in-process and refreshed (+ re-encrypted) when near expiry.
//
// Live Drive/Dropbox calls are not reachable in this environment; the adapter,
// uploader, ingest queue and token refresh are injected so the whole sweep is
// unit-tested with stubs.

import type { Readable } from 'node:stream';
import { type DbClient, schema } from '@pkg/db';
import {
  type CloudProvider,
  type CloudStorageAdapter,
  CloudStorageError,
  type CloudTokenSet,
  decryptCredentials,
  encryptCredentials,
} from '@pkg/integrations';
import type { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';

import type { IngestJobData } from '../queues/index.js';

const { cloudImports, cloudImportFiles } = schema.cloudImports;
const { integrationConfigs } = schema.integrations;
const { photos } = schema.photos;

// Mirrors the direct-upload pipeline (apps/api uploads service): only these
// types flow through derivatives/quality. Others are recorded as failed.
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/heic']);
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
};

const TOKEN_SKEW_MS = 30_000;
const IMPORTS_PER_TICK = 3;
const FILES_PER_TICK = 25;
const MAX_FILE_ATTEMPTS = 5;

export interface CloudImportDeps {
  masterKey: string;
  adapterFactory: (provider: CloudProvider, accessToken: string) => CloudStorageAdapter;
  refreshToken: (provider: CloudProvider, refreshToken: string) => Promise<CloudTokenSet>;
  uploader: (params: { key: string; body: Readable; contentType: string }) => Promise<void>;
  ingestQueue: Pick<Queue<IngestJobData>, 'add'>;
  now?: () => Date;
}

export interface CloudImportResult {
  importsProcessed: number;
  filesImported: number;
  filesFailed: number;
}

interface ImportRow {
  id: string;
  eventId: string;
  orgId: string;
  photographerUserId: string;
  provider: CloudProvider;
  remoteFolderId: string;
  status: string;
  startedAt: Date | null;
}

interface FileRow {
  id: string;
  remoteFileId: string;
  contentHash: string;
  name: string;
  contentType: string;
  sizeBytes: number | null;
  attempts: number;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

const recordImportError = (
  db: DbClient,
  id: string,
  message: string,
  now: Date,
): Promise<unknown> =>
  db
    .update(cloudImports)
    .set({ lastError: message, updatedAt: now })
    .where(eq(cloudImports.id, id));

const failImport = (db: DbClient, id: string, message: string, now: Date): Promise<unknown> =>
  db
    .update(cloudImports)
    .set({ status: 'failed', lastError: message, completedAt: now, updatedAt: now })
    .where(eq(cloudImports.id, id));

// Load the org's encrypted token, refresh it if near expiry, and build an
// adapter. Returns null (after failing the import) when the org has no enabled
// connection for the provider.
const resolveAdapter = async (
  db: DbClient,
  imp: ImportRow,
  deps: CloudImportDeps,
  now: Date,
): Promise<CloudStorageAdapter | null> => {
  const rows = (await db
    .select({ id: integrationConfigs.id, encrypted: integrationConfigs.encryptedCredentials })
    .from(integrationConfigs)
    .where(
      and(
        eq(integrationConfigs.orgId, imp.orgId),
        eq(integrationConfigs.type, imp.provider),
        eq(integrationConfigs.enabled, true),
      ),
    )
    .limit(1)) as { id: string; encrypted: string | null }[];
  const cfg = rows[0];
  if (!cfg?.encrypted) {
    await failImport(db, imp.id, 'integration_not_connected', now);
    return null;
  }
  let token = JSON.parse(decryptCredentials(cfg.encrypted, deps.masterKey)) as CloudTokenSet;
  if (token.expiresAt * 1000 - now.getTime() < TOKEN_SKEW_MS) {
    token = await deps.refreshToken(imp.provider, token.refreshToken);
    await db
      .update(integrationConfigs)
      .set({
        encryptedCredentials: encryptCredentials(JSON.stringify(token), deps.masterKey),
        updatedAt: now,
      })
      .where(eq(integrationConfigs.id, cfg.id));
  }
  return deps.adapterFactory(imp.provider, token.accessToken);
};

// List the folder once and seed a row per file; flip the import to 'running'. A
// transient list error throws before the flip, so the import stays 'pending' and
// re-lists next tick — the unique (import, content_hash) index makes that
// idempotent (already-seeded rows conflict-skip and remain pending for the batch).
const seedFiles = async (
  db: DbClient,
  imp: ImportRow,
  adapter: CloudStorageAdapter,
  now: Date,
): Promise<void> => {
  const files = await adapter.listFolder(imp.remoteFolderId);
  for (const f of files) {
    const base = {
      cloudImportId: imp.id,
      remoteFileId: f.remoteFileId,
      contentHash: f.contentHash,
      name: f.name,
      contentType: f.contentType,
    };
    const row =
      f.size == null
        ? { ...base, sizeBytes: null, status: 'failed' as const, error: 'missing_size' }
        : !ALLOWED_CONTENT_TYPES.has(f.contentType)
          ? { ...base, sizeBytes: f.size, status: 'failed' as const, error: 'unsupported_type' }
          : { ...base, sizeBytes: f.size, status: 'pending' as const };
    await db
      .insert(cloudImportFiles)
      .values(row)
      .onConflictDoNothing({
        target: [cloudImportFiles.cloudImportId, cloudImportFiles.contentHash],
      });
  }
  await db
    .update(cloudImports)
    .set({
      status: 'running',
      totalFiles: files.length,
      ...(imp.startedAt ? {} : { startedAt: now }),
      updatedAt: now,
    })
    .where(eq(cloudImports.id, imp.id));
};

// Download -> stream to R2 -> photos row -> ingest enqueue -> mark imported.
const importFile = async (
  db: DbClient,
  imp: ImportRow,
  adapter: CloudStorageAdapter,
  deps: CloudImportDeps,
  row: FileRow,
  now: Date,
): Promise<void> => {
  const ext = EXT_BY_CONTENT_TYPE[row.contentType] ?? 'jpg';
  const safeHash = row.contentHash.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `originals/${imp.eventId}/cloud-${safeHash}.${ext}`;
  const dl = await adapter.download(row.remoteFileId);
  await deps.uploader({ key, body: dl.stream, contentType: row.contentType });
  const inserted = (await db
    .insert(photos)
    .values({
      eventId: imp.eventId,
      photographerUserId: imp.photographerUserId,
      originalObjectKey: key,
      originalBytes: BigInt(row.sizeBytes ?? 0),
      contentType: row.contentType,
      status: 'processing',
    })
    .returning({ id: photos.id })) as { id: string }[];
  const photoId = inserted[0]?.id;
  if (!photoId) throw new Error('photo insert returned no id');
  // Stable job id keeps ingest idempotent if this file is reprocessed.
  await deps.ingestQueue.add(
    'ingestFanOut',
    { photoId },
    { jobId: `cloud:${imp.id}:${row.contentHash}` },
  );
  await db
    .update(cloudImportFiles)
    .set({ status: 'imported', photoId, updatedAt: now })
    .where(eq(cloudImportFiles.id, row.id));
};

const processBatch = async (
  db: DbClient,
  imp: ImportRow,
  adapter: CloudStorageAdapter,
  deps: CloudImportDeps,
  now: Date,
): Promise<{ imported: number; failed: number }> => {
  const rows = (await db
    .select({
      id: cloudImportFiles.id,
      remoteFileId: cloudImportFiles.remoteFileId,
      contentHash: cloudImportFiles.contentHash,
      name: cloudImportFiles.name,
      contentType: cloudImportFiles.contentType,
      sizeBytes: cloudImportFiles.sizeBytes,
      attempts: cloudImportFiles.attempts,
    })
    .from(cloudImportFiles)
    .where(and(eq(cloudImportFiles.cloudImportId, imp.id), eq(cloudImportFiles.status, 'pending')))
    .limit(FILES_PER_TICK)) as FileRow[];

  let imported = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await importFile(db, imp, adapter, deps, row, now);
      imported += 1;
    } catch (err) {
      // Provider throttling: stop this tick, leave the rest pending for later.
      if (err instanceof CloudStorageError && err.code === 'rate_limited') {
        await recordImportError(db, imp.id, 'rate_limited', now);
        break;
      }
      const retryable = err instanceof CloudStorageError && err.retryable;
      const attempts = row.attempts + 1;
      if (retryable && attempts < MAX_FILE_ATTEMPTS) {
        await db
          .update(cloudImportFiles)
          .set({ attempts, error: errMsg(err), updatedAt: now })
          .where(eq(cloudImportFiles.id, row.id));
      } else {
        await db
          .update(cloudImportFiles)
          .set({ status: 'failed', attempts, error: errMsg(err), updatedAt: now })
          .where(eq(cloudImportFiles.id, row.id));
        failed += 1;
      }
    }
  }
  return { imported, failed };
};

// Recompute counters from the file rows and finalize when nothing is pending.
const finalize = async (db: DbClient, imp: ImportRow, now: Date): Promise<void> => {
  const rows = (await db
    .select({ status: cloudImportFiles.status })
    .from(cloudImportFiles)
    .where(eq(cloudImportFiles.cloudImportId, imp.id))) as { status: string }[];
  let imported = 0;
  let failed = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.status === 'imported') imported += 1;
    else if (r.status === 'failed') failed += 1;
    else pending += 1;
  }
  await db
    .update(cloudImports)
    .set({
      importedFiles: imported,
      failedFiles: failed,
      ...(pending === 0 ? { status: 'completed' as const, completedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(cloudImports.id, imp.id));
};

export const runCloudImport = async (
  db: DbClient,
  deps: CloudImportDeps,
): Promise<CloudImportResult> => {
  const now = deps.now ?? (() => new Date());
  const result: CloudImportResult = { importsProcessed: 0, filesImported: 0, filesFailed: 0 };

  const imports = (await db
    .select({
      id: cloudImports.id,
      eventId: cloudImports.eventId,
      orgId: cloudImports.orgId,
      photographerUserId: cloudImports.photographerUserId,
      provider: cloudImports.provider,
      remoteFolderId: cloudImports.remoteFolderId,
      status: cloudImports.status,
      startedAt: cloudImports.startedAt,
    })
    .from(cloudImports)
    .where(inArray(cloudImports.status, ['pending', 'running']))
    .limit(IMPORTS_PER_TICK)) as ImportRow[];

  for (const imp of imports) {
    result.importsProcessed += 1;
    const at = now();
    try {
      const adapter = await resolveAdapter(db, imp, deps, at);
      if (!adapter) continue; // import already failed (not connected)
      if (imp.status === 'pending') await seedFiles(db, imp, adapter, at);
      const batch = await processBatch(db, imp, adapter, deps, at);
      result.filesImported += batch.imported;
      result.filesFailed += batch.failed;
      await finalize(db, imp, at);
    } catch (err) {
      const terminal =
        err instanceof CloudStorageError && !err.retryable && err.code !== 'rate_limited';
      if (terminal) await failImport(db, imp.id, errMsg(err), at);
      else await recordImportError(db, imp.id, errMsg(err), at);
    }
  }

  return result;
};
