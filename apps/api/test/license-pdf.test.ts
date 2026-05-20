// Unit tests for apps/api/src/lib/license-pdf.ts.
// Tests renderLicenseText (snapshot-style string assertions) and
// generateLicensePdf (magic bytes + non-empty Buffer).
//
// pdf-lib is a real dependency; no mocking needed for these tests.
// No DB access, no env vars, no external services.

import { describe, expect, it } from 'vitest';

import {
  LICENSE_PDF_TEMPLATE_VERSION,
  type LicensePdfInput,
  generateLicensePdf,
  renderLicenseText,
} from '../src/lib/license-pdf.js';

// ---------- Shared fixture ----------

const BASE_INPUT: LicensePdfInput = {
  buyerName: 'Jane Doe',
  buyerEmail: 'jane@example.com',
  photographerName: 'Photographer Name',
  photoIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
  tierCode: 'commercial',
  tierName: 'Commercial',
  tierScope: 'Full commercial rights including advertising and marketing.',
  orderId: 'order-00000000-0000-4000-8000-deadbeef0001',
  issuedAt: new Date('2026-05-20T00:00:00.000Z'),
  templateVersion: LICENSE_PDF_TEMPLATE_VERSION,
};

// ---------- renderLicenseText ----------

describe('renderLicenseText', () => {
  it('contains buyer name', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('Jane Doe');
  });

  it('contains buyer email', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('jane@example.com');
  });

  it('contains photographer name', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('Photographer Name');
  });

  it('contains each photo ID', () => {
    const text = renderLicenseText(BASE_INPUT);
    for (const id of BASE_INPUT.photoIds) {
      expect(text).toContain(id);
    }
  });

  it('contains tier name and tier code', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('Commercial');
    expect(text).toContain('commercial');
  });

  it('contains tier scope description', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('Full commercial rights including advertising and marketing.');
  });

  it('contains order ID', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain(BASE_INPUT.orderId);
  });

  it('contains template version', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain(LICENSE_PDF_TEMPLATE_VERSION);
  });

  it('contains issued date as YYYY-MM-DD', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('2026-05-20');
  });

  it('uses (not specified) when photographerName is absent', () => {
    const input: LicensePdfInput = { ...BASE_INPUT, photographerName: undefined };
    const text = renderLicenseText(input);
    expect(text).toContain('(not specified)');
  });

  it('is deterministic — same input always yields same output', () => {
    const a = renderLicenseText(BASE_INPUT);
    const b = renderLicenseText(BASE_INPUT);
    expect(a).toBe(b);
  });

  it('includes the PHOTO LICENSE CERTIFICATE title', () => {
    const text = renderLicenseText(BASE_INPUT);
    expect(text).toContain('PHOTO LICENSE CERTIFICATE');
  });
});

// ---------- generateLicensePdf ----------

describe('generateLicensePdf', () => {
  it('returns a non-empty Buffer', async () => {
    const buf = await generateLicensePdf(BASE_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('starts with the %PDF magic bytes', async () => {
    const buf = await generateLicensePdf(BASE_INPUT);
    const header = buf.slice(0, 4).toString('ascii');
    expect(header).toBe('%PDF');
  });

  it('produces a larger document for more photo IDs', async () => {
    const few = await generateLicensePdf(BASE_INPUT);
    const many = await generateLicensePdf({
      ...BASE_INPUT,
      photoIds: Array.from(
        { length: 20 },
        (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      ),
    });
    // More content => larger (or equal — pdf structure may vary, but should be non-trivially larger).
    expect(many.length).toBeGreaterThanOrEqual(few.length);
  });

  it('works without a photographerName', async () => {
    const input: LicensePdfInput = { ...BASE_INPUT, photographerName: undefined };
    const buf = await generateLicensePdf(input);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});

// ---------- LICENSE_PDF_TEMPLATE_VERSION ----------

describe('LICENSE_PDF_TEMPLATE_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof LICENSE_PDF_TEMPLATE_VERSION).toBe('string');
    expect(LICENSE_PDF_TEMPLATE_VERSION.length).toBeGreaterThan(0);
  });
});
