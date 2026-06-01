// F4.6+ — timing-provider public surface.

export * from './types.js';
export { RunSignupAdapter, type RunSignupOptions, parseClockToMs } from './runsignup.js';
export { ChronoTrackAdapter, type ChronoTrackOptions } from './chronotrack.js';

export const TIMING_PROVIDERS = ['runsignup', 'chronotrack', 'mylaps'] as const;

export const isTimingProvider = (v: string): v is (typeof TIMING_PROVIDERS)[number] =>
  (TIMING_PROVIDERS as readonly string[]).includes(v);
