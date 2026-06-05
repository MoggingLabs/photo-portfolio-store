// F5.5 — photographer quality-filter settings + manual rejection override.
//
// Settings are per-photographer (keyed by user id). The override clears a photo's
// auto_rejected flag and stamps rejection_overridden_at so the quality worker
// never re-rejects it. Both are owner-scoped to the authenticated photographer.

import { type DbClient, schema } from '@pkg/db';
import { eq } from 'drizzle-orm';

const { photographerSettings } = schema.photographerSettings;
const { photos } = schema.photos;

const DEFAULT_THRESHOLD = 0.5;

export interface QualitySettings {
  enabled: boolean;
  threshold: number;
}

export const getQualitySettings = async (
  db: DbClient,
  userId: string,
): Promise<QualitySettings> => {
  const rows = await db
    .select({
      enabled: photographerSettings.qualityFilterEnabled,
      threshold: photographerSettings.qualityThreshold,
    })
    .from(photographerSettings)
    .where(eq(photographerSettings.photographerUserId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return { enabled: false, threshold: DEFAULT_THRESHOLD };
  return { enabled: row.enabled, threshold: Number(row.threshold) };
};

export const updateQualitySettings = async (
  db: DbClient,
  userId: string,
  input: { enabled?: boolean; threshold?: number },
  now: Date = new Date(),
): Promise<QualitySettings> => {
  const current = await getQualitySettings(db, userId);
  const enabled = input.enabled ?? current.enabled;
  const threshold = input.threshold ?? current.threshold;
  await db
    .insert(photographerSettings)
    .values({
      photographerUserId: userId,
      qualityFilterEnabled: enabled,
      qualityThreshold: threshold.toFixed(2),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: photographerSettings.photographerUserId,
      set: {
        qualityFilterEnabled: enabled,
        qualityThreshold: threshold.toFixed(2),
        updatedAt: now,
      },
    });
  return { enabled, threshold };
};

// Owner-gated republish. Returns false (-> 404, anti-enumeration) when the photo
// is missing or not the caller's; otherwise clears the rejection and stamps the
// override so a re-run of the quality worker leaves it published.
export const overrideRejection = async (
  db: DbClient,
  photoId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> => {
  const rows = await db
    .select({ photographerUserId: photos.photographerUserId })
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);
  const row = rows[0];
  if (!row || row.photographerUserId !== userId) return false;
  await db
    .update(photos)
    .set({ autoRejected: false, rejectionOverriddenAt: now, updatedAt: now })
    .where(eq(photos.id, photoId));
  return true;
};
