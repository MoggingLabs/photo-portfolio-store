-- M3 Wave 3 — F3.12 photo quality flags (blur / near-duplicate / eyes-closed).
-- Advisory only; no auto-hide. Computed once by the quality worker after
-- derivative generation and reused at query time (never recomputed).

-- quality_flags holds the structured advisory result, e.g.
--   { "blur": true, "near_duplicate_of": "<uuid>", "duplicate_group_id": "<uuid>",
--     "eyes_closed": { "faces": 2 } }
-- null until the photo has been scored.
ALTER TABLE "app"."photos" ADD COLUMN "quality_flags" jsonb;

-- Laplacian variance on the luma channel (higher = sharper).
ALTER TABLE "app"."photos" ADD COLUMN "blur_score" numeric(10, 2);

-- 64-bit perceptual hash (DCT-based pHash). Signed bigint storage; the worker
-- computes Hamming distance against other photos in the same event window.
ALTER TABLE "app"."photos" ADD COLUMN "phash" bigint;

-- Supports near-duplicate candidate scans scoped to an event and exact-phash
-- dedup. A bk-tree / bucketed-prefix index is a future optimization for true
-- Hamming-distance nearest-neighbour lookup.
CREATE INDEX "photos_phash_idx" ON "app"."photos" ("event_id", "phash");
