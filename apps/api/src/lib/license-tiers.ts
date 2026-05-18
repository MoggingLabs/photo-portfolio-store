// License tier seed data — the four canonical tiers ship with every
// deployment. Codes are stable identifiers used by API clients; name and
// description are human-facing copy and may be edited per-deployment without
// breaking the API contract.
//
// Adding a tier here does NOT migrate existing deployments; call
// seedDefaultLicenseTiers() on boot and on demand from a CLI admin tool.

export interface LicenseTierSeed {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
}

export const LICENSE_TIER_SEED: ReadonlyArray<LicenseTierSeed> = [
  {
    code: 'personal',
    name: 'Personal use',
    description:
      'For private, non-commercial use only. Print at home, share with friends and family, and keep as a personal memento.',
    sortOrder: 1,
  },
  {
    code: 'social',
    name: 'Social media',
    description:
      'Use on personal social media profiles (Instagram, Facebook, TikTok, X). Not for paid advertising or sponsored posts.',
    sortOrder: 2,
  },
  {
    code: 'editorial',
    name: 'Editorial',
    description:
      'Use in news articles, blogs, and editorial publications. Not for advertising, endorsement, or commercial product promotion.',
    sortOrder: 3,
  },
  {
    code: 'commercial',
    name: 'Commercial',
    description:
      'Full commercial rights including advertising, marketing, sponsorships, merchandise, and product packaging. Subject to release of identifiable persons.',
    sortOrder: 4,
  },
];

// Stable short codes used to compose deterministic SKUs.
export const LICENSE_TIER_SKU_CODE: Readonly<Record<string, string>> = {
  personal: 'per',
  social: 'soc',
  editorial: 'edi',
  commercial: 'com',
};
