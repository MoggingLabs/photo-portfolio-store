// F4.12 — SMS quiet-hours check.
//
// No SMS before 8am / after 9pm in the participant's local time. We don't store
// a timezone, so a coarse locale -> UTC-offset map is used (best-effort; the
// default is UTC). When in quiet hours, callers defer SMS to the next 8am local.

const QUIET_START_HOUR = 21; // 9pm
const QUIET_END_HOUR = 8; // 8am

// Coarse locale/region -> UTC offset (hours). Extend as needed; unknown -> 0.
const LOCALE_OFFSETS: Record<string, number> = {
  'en-US': -6,
  'en-us': -6,
  us: -6,
  'pt-BR': -3,
  'pt-br': -3,
  br: -3,
  'en-GB': 0,
  gb: 0,
  'es-ES': 1,
  es: 1,
  'fr-FR': 1,
  fr: 1,
};

export const localeOffsetHours = (locale: string | null | undefined): number => {
  if (!locale) return 0;
  if (locale in LOCALE_OFFSETS) return LOCALE_OFFSETS[locale] as number;
  const region = locale.split('-')[1]?.toLowerCase();
  if (region && region in LOCALE_OFFSETS) return LOCALE_OFFSETS[region] as number;
  const lang = locale.split('-')[0]?.toLowerCase();
  if (lang && lang in LOCALE_OFFSETS) return LOCALE_OFFSETS[lang] as number;
  return 0;
};

export const localHour = (nowUtc: Date, locale: string | null | undefined): number => {
  const offset = localeOffsetHours(locale);
  return (((nowUtc.getUTCHours() + offset) % 24) + 24) % 24;
};

export const isQuietHours = (nowUtc: Date, locale: string | null | undefined): boolean => {
  const hour = localHour(nowUtc, locale);
  return hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR;
};
