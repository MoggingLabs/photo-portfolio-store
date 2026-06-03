// F4.2 — SFTP staged-upload ingest (the watcher's enqueue half).
//
// A stable upload (size settled, no open handle — determined by the watcher) is
// passed here as { eventId, path, contentHash }. We dedup on (event, content
// hash) via sftp_uploads so resumed/duplicate uploads enqueue exactly one
// ingest job, then hand off to the ingest queue. The inotify watcher + the
// staging->permanent move + virus scan are deploy-side infra (see
// docs/integrations/sftp.md); this function is the testable enqueue core.

import { type DbClient, schema } from '@pkg/db';
import type { Queue } from 'bullmq';

const { sftpUploads } = schema.sftp;

export interface StableUpload {
  eventId: string;
  path: string;
  contentHash: string;
}

export interface SftpIngestJobData {
  eventId: string;
  path: string;
  contentHash: string;
}

export interface SftpIngestDeps {
  // Where ingest jobs are enqueued. Injectable for tests.
  queue: Pick<Queue<SftpIngestJobData>, 'add'>;
}

export interface SftpIngestResult {
  processed: number;
  enqueued: number;
  duplicates: number;
}

export const enqueueStableUploads = async (
  db: DbClient,
  uploads: StableUpload[],
  deps: SftpIngestDeps,
): Promise<SftpIngestResult> => {
  const result: SftpIngestResult = { processed: 0, enqueued: 0, duplicates: 0 };

  for (const u of uploads) {
    result.processed += 1;
    // Atomic dedup: insert wins exactly once per (event, hash).
    const inserted = await db
      .insert(sftpUploads)
      .values({ eventId: u.eventId, contentHash: u.contentHash, path: u.path })
      .onConflictDoNothing({ target: [sftpUploads.eventId, sftpUploads.contentHash] })
      .returning({ id: sftpUploads.id });

    if (inserted.length === 0) {
      result.duplicates += 1;
      continue;
    }

    // Stable job id keeps the queue idempotent even if this runs twice.
    await deps.queue.add(
      'sftp-ingest',
      { eventId: u.eventId, path: u.path, contentHash: u.contentHash },
      { jobId: `sftp:${u.eventId}:${u.contentHash}` },
    );
    result.enqueued += 1;
  }

  return result;
};
