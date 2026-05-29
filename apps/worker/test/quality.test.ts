// F3.12 — quality scoring math (pure functions, no sharp / no DB).

import { describe, expect, it } from 'vitest';

import {
  computePhashFromGray,
  hammingDistance,
  isNearDuplicate,
  laplacianVariance,
} from '../src/lib/quality.js';

const fill = (n: number, value: number): number[] => new Array<number>(n).fill(value);

// Build a size*size grayscale array from a (x,y) -> value generator.
const grid = (size: number, gen: (x: number, y: number) => number): number[] => {
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) out.push(gen(x, y) & 0xff);
  }
  return out;
};

describe('laplacianVariance', () => {
  it('is zero for a perfectly uniform (blurry) image', () => {
    const flat = fill(8 * 8, 120);
    expect(laplacianVariance(flat, 8, 8)).toBe(0);
  });

  it('scores a sharp high-frequency image far above a smooth one', () => {
    const smooth = grid(16, (x) => 100 + x); // gentle gradient
    const checker = grid(16, (x, y) => ((x + y) % 2 === 0 ? 0 : 255)); // max edges
    const smoothScore = laplacianVariance(smooth, 16, 16);
    const sharpScore = laplacianVariance(checker, 16, 16);
    expect(sharpScore).toBeGreaterThan(smoothScore);
    expect(sharpScore).toBeGreaterThan(1000);
  });

  it('returns 0 for degenerate dimensions', () => {
    expect(laplacianVariance([1, 2, 3], 1, 3)).toBe(0);
  });
});

describe('computePhashFromGray', () => {
  it('is deterministic — identical input yields an identical hash', () => {
    const img = grid(32, (x, y) => x * 4 + y * 2);
    expect(computePhashFromGray(img)).toBe(computePhashFromGray(img));
  });

  it('produces zero Hamming distance against itself', () => {
    const img = grid(32, (x, y) => (x * y) % 256);
    const h = computePhashFromGray(img);
    expect(hammingDistance(h, h)).toBe(0);
  });

  it('produces a different hash for a visibly different image', () => {
    const a = computePhashFromGray(grid(32, (x) => x * 8));
    const b = computePhashFromGray(grid(32, (x, y) => (x % 2 === 0 ? 0 : 255) ^ (y * 3)));
    expect(hammingDistance(a, b)).toBeGreaterThan(0);
  });

  it('throws when given fewer bytes than size*size', () => {
    expect(() => computePhashFromGray(fill(10, 0))).toThrow();
  });
});

describe('hammingDistance', () => {
  it('counts differing bits', () => {
    // 0b1011 ^ 0b1110 = 0b0101 -> 2 bits set.
    expect(hammingDistance(0b1011n, 0b1110n)).toBe(2);
  });

  it('is zero for equal hashes', () => {
    expect(hammingDistance(0xdeadbeefn, 0xdeadbeefn)).toBe(0);
  });
});

describe('isNearDuplicate', () => {
  it('is true within the threshold and false beyond it', () => {
    const base = 0b1111_0000n;
    const oneBitOff = 0b1111_0001n;
    expect(isNearDuplicate(base, oneBitOff, 6)).toBe(true);
    expect(isNearDuplicate(base, 0b0000_1111n, 2)).toBe(false);
  });
});
