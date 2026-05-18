// F1.14 — watermark worker.
//
// Composites an SVG text watermark onto the `preview` derivative. Pure sharp,
// no FFmpeg. If event_settings.watermark_text is empty, the job is a no-op.

import { Buffer } from 'node:buffer';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import type { Job, Processor } from 'bullmq';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { buckets as defaultBuckets, getS3 } from '../lib/storage.js';
import type { WatermarkJobData } from '../queues/index.js';

const { photos, photoDerivatives } = schema.photos;
const { eventSettings } = schema.events;

export interface WatermarkDeps {
  db?: DbClient;
  s3?: S3Client;
  buckets?: { derivatives: string };
  sharpFactory?: typeof sharp;
}

export interface WatermarkResult {
  status: 'applied' | 'skipped';
  reason?: string;
}

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    body &&
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
      'function'
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const escapeXml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });

const buildWatermarkSvg = (
  text: string,
  width: number,
  height: number,
  opacity: number,
): Buffer => {
  // Font sized to ~6% of the long edge, tiled diagonally would be heavier;
  // a single bottom-right stamp keeps things fast and legible.
  const fontSize = Math.max(18, Math.round(Math.max(width, height) * 0.045));
  const safeText = escapeXml(text);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .wm { font-family: Helvetica, Arial, sans-serif; font-weight: 700; fill: white; fill-opacity: ${opacity}; stroke: black; stroke-opacity: ${Math.min(opacity, 0.35)}; stroke-width: 1; paint-order: stroke fill; }
  </style>
  <text x="${width - 24}" y="${height - 24}" text-anchor="end" font-size="${fontSize}" class="wm">${safeText}</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
};

export const processWatermark = async (
  job: Job<WatermarkJobData>,
  deps: WatermarkDeps = {},
): Promise<WatermarkResult> => {
  const dbClient = deps.db ?? defaultDb;
  const s3 = deps.s3 ?? getS3();
  const bucketCfg = deps.buckets ?? { derivatives: defaultBuckets.derivatives };
  const sharpFn = deps.sharpFactory ?? sharp;
  const { photoId } = job.data;

  try {
    const photoRows = await dbClient
      .select({ id: photos.id, eventId: photos.eventId })
      .from(photos)
      .where(sql`${photos.id} = ${photoId}`)
      .limit(1);
    const photo = photoRows[0];
    if (!photo) {
      logger.warn({ photoId }, 'watermark: photo not found');
      return { status: 'skipped', reason: 'not_found' };
    }

    const settingsRows = await dbClient
      .select({
        watermarkText: eventSettings.watermarkText,
        watermarkOpacity: eventSettings.watermarkOpacity,
      })
      .from(eventSettings)
      .where(sql`${eventSettings.eventId} = ${photo.eventId}`)
      .limit(1);
    const settings = settingsRows[0];
    const text = settings?.watermarkText?.trim();
    if (!text) {
      await writeWorkerAudit(dbClient, {
        action: 'media.watermark.skipped',
        targetKind: 'photo',
        targetId: photoId,
        eventId: photo.eventId,
        payload: { reason: 'no_watermark_text' },
      });
      logger.info({ photoId }, 'watermark: no text configured, skipping');
      return { status: 'skipped', reason: 'no_watermark_text' };
    }
    const opacity = Number.parseFloat(settings?.watermarkOpacity ?? '0.40');

    const previewRows = await dbClient
      .select({ objectKey: photoDerivatives.objectKey })
      .from(photoDerivatives)
      .where(sql`${photoDerivatives.photoId} = ${photoId} and ${photoDerivatives.kind} = 'preview'`)
      .limit(1);
    const preview = previewRows[0];
    if (!preview) {
      logger.warn({ photoId }, 'watermark: preview derivative missing');
      return { status: 'skipped', reason: 'preview_missing' };
    }

    const getRes = await s3.send(
      new GetObjectCommand({ Bucket: bucketCfg.derivatives, Key: preview.objectKey }),
    );
    const previewBuffer = await streamToBuffer(getRes.Body);

    const meta = await sharpFn(previewBuffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) {
      throw new Error(`preview metadata missing dimensions for photo ${photoId}`);
    }

    const overlay = buildWatermarkSvg(
      text,
      width,
      height,
      Number.isFinite(opacity) ? opacity : 0.4,
    );
    const { data, info } = await sharpFn(previewBuffer)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    await s3.send(
      new PutObjectCommand({
        Bucket: bucketCfg.derivatives,
        Key: preview.objectKey,
        Body: data,
        ContentType: 'image/jpeg',
      }),
    );

    await dbClient
      .update(photoDerivatives)
      .set({ watermarked: true, bytes: info.size, width: info.width, height: info.height })
      .where(
        sql`${photoDerivatives.photoId} = ${photoId} and ${photoDerivatives.kind} = 'preview'`,
      );

    await writeWorkerAudit(dbClient, {
      action: 'media.watermark.applied',
      targetKind: 'photo',
      targetId: photoId,
      eventId: photo.eventId,
      payload: { opacity, textLength: text.length },
    });

    logger.info({ photoId }, 'watermark: applied');
    return { status: 'applied' };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'watermark', photoId } });
    logger.error(
      { photoId, err: error instanceof Error ? error.message : String(error) },
      'watermark: failed',
    );
    throw error;
  }
};

export const watermarkProcessor: Processor<WatermarkJobData, WatermarkResult> = (job) =>
  processWatermark(job);
