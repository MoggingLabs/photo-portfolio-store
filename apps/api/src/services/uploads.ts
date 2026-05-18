// Resumable multipart upload service (F1.11).
//
// Photographer initiates a session, uploads chunks directly to R2 via
// presigned URLs, then calls complete with the per-part ETags. The API never
// proxies chunk bytes.

import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { buckets, s3 } from '../lib/storage.js';

// ---------- Limits & constants ----------

const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB
const MIN_CHUNK_BYTES = 5 * 1024 * 1024; // S3 multipart minimum (last part exempt)
const MAX_CHUNK_BYTES = 50 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PRESIGN_TTL_SECONDS = 60 * 60; // 1 hour

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic'] as const;
type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

const EXT_BY_CONTENT_TYPE: Record<AllowedContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
};

// ---------- Errors ----------

export class UploadValidationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

// ---------- Schemas ----------

export const initUploadInputSchema = z.object({
  filename: z.string().min(1).max(512),
  contentType: z.string().min(1),
  totalBytes: z.number().int().positive(),
  chunkSize: z.number().int().positive().optional(),
});

export type InitUploadInput = z.infer<typeof initUploadInputSchema>;

export const completeUploadInputSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1),
      }),
    )
    .min(1),
});

export type CompleteUploadInput = z.infer<typeof completeUploadInputSchema>;

// ---------- Helpers ----------

const isAllowedContentType = (value: string): value is AllowedContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);

const writeAudit = async (
  db: DbClient,
  action: string,
  payload: {
    actorUserId: string | null;
    targetId: string;
    eventId: string | null;
    payloadJsonb: Record<string, unknown>;
  },
): Promise<void> => {
  await db.insert(schema.compliance.auditLog).values({
    actorUserId: payload.actorUserId,
    actorKind: payload.actorUserId ? 'user' : 'system',
    action,
    targetKind: 'upload_session',
    targetId: payload.targetId,
    eventId: payload.eventId,
    payloadJsonb: payload.payloadJsonb,
  });
};

// ---------- initUpload ----------

export interface InitUploadResult {
  sessionId: string;
  uploadId: string;
  key: string;
  chunkSize: number;
  totalChunks: number;
}

export const initUpload = async (
  db: DbClient,
  eventId: string,
  photographerUserId: string,
  input: InitUploadInput,
  client: S3Client = s3,
): Promise<InitUploadResult> => {
  const parsed = initUploadInputSchema.parse(input);

  if (!isAllowedContentType(parsed.contentType)) {
    throw new UploadValidationError(
      400,
      `Unsupported contentType '${parsed.contentType}'. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
    );
  }

  if (parsed.totalBytes > MAX_TOTAL_BYTES) {
    throw new UploadValidationError(
      400,
      `totalBytes ${parsed.totalBytes} exceeds the 50 MiB limit`,
    );
  }

  const chunkSize = parsed.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) {
    throw new UploadValidationError(
      400,
      `chunkSize must be between ${MIN_CHUNK_BYTES} and ${MAX_CHUNK_BYTES} bytes`,
    );
  }

  const ext = EXT_BY_CONTENT_TYPE[parsed.contentType];
  const objectKey = `originals/${eventId}/${randomUUID()}.${ext}`;

  const createResult = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: buckets.originals,
      Key: objectKey,
      ContentType: parsed.contentType,
    }),
  );

  const uploadId = createResult.UploadId;
  if (!uploadId) {
    throw new Error('R2 CreateMultipartUpload did not return an UploadId');
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const totalChunks = Math.ceil(parsed.totalBytes / chunkSize);

  const inserted = await db
    .insert(schema.photos.uploadSessions)
    .values({
      eventId,
      photographerUserId,
      originalFilename: parsed.filename,
      contentType: parsed.contentType,
      totalBytes: BigInt(parsed.totalBytes),
      r2UploadId: uploadId,
      r2ObjectKey: objectKey,
      chunkSizeBytes: chunkSize,
      status: 'in_progress',
      expiresAt,
    })
    .returning({ id: schema.photos.uploadSessions.id });

  const session = inserted[0];
  if (!session) {
    throw new Error('Failed to insert upload_sessions row');
  }

  await writeAudit(db, 'media.upload.init', {
    actorUserId: photographerUserId,
    targetId: session.id,
    eventId,
    payloadJsonb: {
      filename: parsed.filename,
      contentType: parsed.contentType,
      totalBytes: parsed.totalBytes,
      chunkSize,
      totalChunks,
      objectKey,
    },
  });

  return {
    sessionId: session.id,
    uploadId,
    key: objectKey,
    chunkSize,
    totalChunks,
  };
};

// ---------- presignChunk ----------

export interface PresignChunkResult {
  uploadUrl: string;
  partNumber: number;
  expiresAt: string;
}

const loadSession = async (db: DbClient, sessionId: string) => {
  const rows = await db
    .select()
    .from(schema.photos.uploadSessions)
    .where(eq(schema.photos.uploadSessions.id, sessionId))
    .limit(1);
  return rows[0];
};

export const presignChunk = async (
  db: DbClient,
  sessionId: string,
  partNumber: number,
  client: S3Client = s3,
): Promise<PresignChunkResult> => {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new UploadValidationError(400, 'partNumber must be an integer in [1, 10000]');
  }

  const session = await loadSession(db, sessionId);
  if (!session) {
    throw new UploadValidationError(404, 'Upload session not found');
  }
  if (session.status === 'aborted' || session.status === 'expired') {
    throw new UploadValidationError(410, `Upload session is ${session.status}`);
  }
  if (session.status !== 'in_progress') {
    throw new UploadValidationError(409, `Upload session is ${session.status}`);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UploadValidationError(410, 'Upload session has expired');
  }

  const command = new UploadPartCommand({
    Bucket: buckets.originals,
    Key: session.r2ObjectKey,
    UploadId: session.r2UploadId,
    PartNumber: partNumber,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });

  return {
    uploadUrl,
    partNumber,
    expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
  };
};

// ---------- completeUpload ----------

export interface CompleteUploadResult {
  photoId: string;
  status: 'processing';
}

export const completeUpload = async (
  db: DbClient,
  sessionId: string,
  input: CompleteUploadInput,
  client: S3Client = s3,
): Promise<CompleteUploadResult> => {
  const parsed = completeUploadInputSchema.parse(input);

  const session = await loadSession(db, sessionId);
  if (!session) {
    throw new UploadValidationError(404, 'Upload session not found');
  }
  if (session.status !== 'in_progress') {
    throw new UploadValidationError(409, `Upload session is ${session.status}`);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UploadValidationError(410, 'Upload session has expired');
  }

  // Sort parts and verify contiguous, unique numbering starting at 1.
  const sortedParts = [...parsed.parts].sort((a, b) => a.partNumber - b.partNumber);
  for (let i = 0; i < sortedParts.length; i += 1) {
    const part = sortedParts[i];
    if (!part || part.partNumber !== i + 1) {
      throw new UploadValidationError(
        400,
        'parts must be contiguous starting at partNumber=1 with no gaps or duplicates',
      );
    }
  }

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: buckets.originals,
      Key: session.r2ObjectKey,
      UploadId: session.r2UploadId,
      MultipartUpload: {
        Parts: sortedParts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );

  const completedAt = new Date();

  await db
    .update(schema.photos.uploadSessions)
    .set({
      status: 'completed',
      completedAt,
      chunksReceived: sortedParts.length,
    })
    .where(eq(schema.photos.uploadSessions.id, session.id));

  const insertedPhoto = await db
    .insert(schema.photos.photos)
    .values({
      eventId: session.eventId,
      photographerUserId: session.photographerUserId,
      uploadSessionId: session.id,
      originalObjectKey: session.r2ObjectKey,
      originalBytes: session.totalBytes,
      contentType: session.contentType,
      status: 'processing',
    })
    .returning({ id: schema.photos.photos.id });

  const photo = insertedPhoto[0];
  if (!photo) {
    throw new Error('Failed to insert photos row');
  }

  await writeAudit(db, 'media.upload.completed', {
    actorUserId: session.photographerUserId,
    targetId: session.id,
    eventId: session.eventId,
    payloadJsonb: {
      photoId: photo.id,
      objectKey: session.r2ObjectKey,
      totalBytes: session.totalBytes.toString(),
      partCount: sortedParts.length,
    },
  });

  return { photoId: photo.id, status: 'processing' };
};

// ---------- abortUpload ----------

export const abortUpload = async (
  db: DbClient,
  sessionId: string,
  client: S3Client = s3,
): Promise<void> => {
  const session = await loadSession(db, sessionId);
  if (!session) {
    throw new UploadValidationError(404, 'Upload session not found');
  }

  if (session.status === 'in_progress') {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: buckets.originals,
        Key: session.r2ObjectKey,
        UploadId: session.r2UploadId,
      }),
    );

    await db
      .update(schema.photos.uploadSessions)
      .set({ status: 'aborted' })
      .where(
        and(
          eq(schema.photos.uploadSessions.id, session.id),
          eq(schema.photos.uploadSessions.status, 'in_progress'),
        ),
      );

    await writeAudit(db, 'media.upload.aborted', {
      actorUserId: session.photographerUserId,
      targetId: session.id,
      eventId: session.eventId,
      payloadJsonb: {
        objectKey: session.r2ObjectKey,
        uploadId: session.r2UploadId,
      },
    });
  }
};
