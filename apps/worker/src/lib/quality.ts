// F3.12 — technical-quality scoring primitives.
//
// Pure functions (no sharp / no DB) so the math is unit-testable on synthetic
// pixel arrays, plus a thin `analyzeImage` wrapper that uses sharp to decode an
// image into the grayscale buffers the math needs. Eyes-closed detection is
// deliberately NOT here — that is delegated to the Python inference /quality
// endpoint (landmarks + eye-aspect-ratio) in a later increment.

import type sharp from 'sharp';

// Long-edge cap for the blur pass. Laplacian variance is scale-sensitive, so we
// normalise every image to the same working resolution before scoring.
const BLUR_WORK_MAX = 1024;
// pHash works on a fixed square; 32x32 DCT, low-frequency 8x8 block -> 64 bits.
const PHASH_SIZE = 32;
const PHASH_LOW_FREQ = 8;

/**
 * Variance of the Laplacian of a single-channel (grayscale) image. This is the
 * classic focus/blur metric: a sharp image has strong high-frequency content
 * (high variance); a blurry one is smooth (low variance). Border pixels are
 * skipped because the 4-neighbour kernel is undefined there.
 */
export const laplacianVariance = (
  gray: Uint8Array | number[],
  width: number,
  height: number,
): number => {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap =
        Number(gray[i - width]) +
        Number(gray[i + width]) +
        Number(gray[i - 1]) +
        Number(gray[i + 1]) -
        4 * Number(gray[i]);
      sum += lap;
      sumSq += lap * lap;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
};

// Memoised DCT-II basis matrices keyed by size. M[k][x] = c(k)*cos(...).
const dctMatrixCache = new Map<number, number[][]>();

const dctMatrix = (n: number): number[][] => {
  const cached = dctMatrixCache.get(n);
  if (cached) return cached;
  const matrix: number[][] = [];
  for (let k = 0; k < n; k += 1) {
    const row: number[] = [];
    const scale = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let x = 0; x < n; x += 1) {
      row.push(scale * Math.cos(((2 * x + 1) * k * Math.PI) / (2 * n)));
    }
    matrix.push(row);
  }
  dctMatrixCache.set(n, matrix);
  return matrix;
};

/**
 * Perceptual hash of a square grayscale image (size*size bytes). Computes a 2D
 * DCT, keeps the low-frequency 8x8 block, and sets each bit when the coefficient
 * is above the block median. Returns a 64-bit value as a bigint. Deterministic:
 * identical input -> identical hash, so Hamming distance is a stable similarity
 * measure.
 */
export const computePhashFromGray = (
  gray: Uint8Array | number[],
  size: number = PHASH_SIZE,
): bigint => {
  if (gray.length < size * size) {
    throw new Error(`computePhashFromGray: expected >= ${size * size} bytes, got ${gray.length}`);
  }
  const m = dctMatrix(size);

  // T = M * A  (rows of M against columns of A).
  const t: number[][] = [];
  for (let k = 0; k < size; k += 1) {
    const mk = m[k] as number[];
    const trow = new Array<number>(size).fill(0);
    for (let j = 0; j < size; j += 1) {
      let acc = 0;
      for (let x = 0; x < size; x += 1) {
        acc += (mk[x] as number) * Number(gray[x * size + j]);
      }
      trow[j] = acc;
    }
    t.push(trow);
  }

  // Low-frequency block F[u][v] for u,v < PHASH_LOW_FREQ, where F = T * M^T.
  const coeffs: number[] = [];
  for (let u = 0; u < PHASH_LOW_FREQ; u += 1) {
    const tu = t[u] as number[];
    const mv = m; // reuse: F[u][v] = sum_j T[u][j] * M[v][j]
    for (let v = 0; v < PHASH_LOW_FREQ; v += 1) {
      const mvRow = mv[v] as number[];
      let acc = 0;
      for (let j = 0; j < size; j += 1) {
        acc += (tu[j] as number) * (mvRow[j] as number);
      }
      coeffs.push(acc);
    }
  }

  const sorted = [...coeffs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);

  let hash = 0n;
  for (let i = 0; i < coeffs.length; i += 1) {
    hash <<= 1n;
    if ((coeffs[i] as number) > median) hash |= 1n;
  }
  return hash;
};

/** Number of differing bits between two 64-bit perceptual hashes. */
export const hammingDistance = (a: bigint, b: bigint): number => {
  let x = a ^ b;
  if (x < 0n) x = -x;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
};

export const isNearDuplicate = (a: bigint, b: bigint, maxDistance: number): boolean =>
  hammingDistance(a, b) <= maxDistance;

export interface ImageQualityScores {
  blurScore: number;
  phash: bigint;
}

/**
 * Decode `buffer` with sharp and compute blur + perceptual hash. Kept thin: all
 * the math lives in the exported pure functions above.
 */
export const analyzeImage = async (
  buffer: Buffer,
  sharpFn: typeof sharp,
): Promise<ImageQualityScores> => {
  const blur = await sharpFn(buffer)
    .greyscale()
    .resize(BLUR_WORK_MAX, BLUR_WORK_MAX, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const blurScore = laplacianVariance(blur.data, blur.info.width, blur.info.height);

  const hashGray = await sharpFn(buffer)
    .greyscale()
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  const phash = computePhashFromGray(hashGray, PHASH_SIZE);

  return { blurScore, phash };
};
