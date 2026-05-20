// License PDF generation. Produces a structured PDF document that serves as
// the buyer's proof of license for purchased photos.
//
// Uses pdf-lib (pure JS, no native deps) so it works on Windows, Linux, and
// macOS without binary pre-builds. The standard Helvetica font is embedded;
// no font files need to be deployed alongside the app.
//
// renderLicenseText is exported separately so unit tests can assert on the
// text content without parsing PDF bytes.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ---------- Constants ----------

export const LICENSE_PDF_TEMPLATE_VERSION = '2026-05-20';

// ---------- Types ----------

export interface LicensePdfInput {
  buyerName: string;
  buyerEmail: string;
  photographerName?: string;
  photoIds: string[];
  tierCode: string;
  tierName: string;
  tierScope: string;
  orderId: string;
  issuedAt: Date;
  templateVersion: string;
}

// ---------- Text renderer ----------

// Returns the deterministic plain-text body drawn into the PDF.
// Snapshot-testable without parsing PDF bytes.
export function renderLicenseText(input: LicensePdfInput): string {
  const formattedDate = input.issuedAt.toISOString().split('T')[0] ?? input.issuedAt.toISOString();
  const photoList = input.photoIds.map((id) => `  - ${id}`).join('\n');
  const photographerLine = input.photographerName
    ? `Photographer:      ${input.photographerName}`
    : 'Photographer:      (not specified)';

  return [
    'PHOTO LICENSE CERTIFICATE',
    '='.repeat(60),
    '',
    `Order ID:          ${input.orderId}`,
    `Issued:            ${formattedDate}`,
    `Template version:  ${input.templateVersion}`,
    '',
    'LICENSEE',
    '-'.repeat(30),
    `Name:              ${input.buyerName}`,
    `Email:             ${input.buyerEmail}`,
    '',
    'LICENSOR',
    '-'.repeat(30),
    photographerLine,
    '',
    'LICENSE GRANT',
    '-'.repeat(30),
    `Tier:              ${input.tierName} (${input.tierCode})`,
    `Scope:             ${input.tierScope}`,
    '',
    'LICENSED PHOTOS',
    '-'.repeat(30),
    photoList,
    '',
    'TERMS',
    '-'.repeat(30),
    'This certificate grants the licensee the rights described under',
    `the "${input.tierName}" license tier for the photos listed above.`,
    'All rights not expressly granted remain with the photographer.',
    'This license is non-transferable and non-exclusive.',
    '',
    '='.repeat(60),
    'This document is an automatically generated license record.',
  ].join('\n');
}

// ---------- PDF generator ----------

export async function generateLicensePdf(input: LicensePdfInput): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([612, 792]); // US Letter in points
  const { width, height } = page.getSize();
  const margin = 60;
  const lineHeight = 16;
  const smallLineHeight = 14;

  let y = height - margin;

  const drawText = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {},
  ): void => {
    const size = opts.size ?? 10;
    const font = opts.bold ? helveticaBold : helvetica;
    const [r, g, b] = opts.color ?? [0, 0, 0];
    page.drawText(text, {
      x: margin,
      y,
      size,
      font,
      color: rgb(r, g, b),
      maxWidth: width - margin * 2,
    });
    y -= opts.size ? opts.size + 6 : lineHeight;
  };

  const drawDivider = (): void => {
    page.drawLine({
      start: { x: margin, y },
      end: { x: width - margin, y },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 10;
  };

  const drawSectionLabel = (label: string): void => {
    y -= 6;
    drawText(label, { bold: true, size: 9, color: [0.4, 0.4, 0.4] });
  };

  // Title
  drawText('PHOTO LICENSE CERTIFICATE', { bold: true, size: 16, color: [0.1, 0.1, 0.4] });
  y -= 4;
  drawDivider();

  // Metadata block
  const formattedDate = input.issuedAt.toISOString().split('T')[0] ?? input.issuedAt.toISOString();
  drawSectionLabel('DOCUMENT');
  drawText(`Order ID:         ${input.orderId}`, { size: 9 });
  drawText(`Issued:           ${formattedDate}`, { size: 9 });
  drawText(`Template version: ${input.templateVersion}`, { size: 9 });
  drawDivider();

  // Licensee block
  drawSectionLabel('LICENSEE');
  drawText(`Name:             ${input.buyerName}`, { size: 9 });
  drawText(`Email:            ${input.buyerEmail}`, { size: 9 });
  drawDivider();

  // Licensor block
  drawSectionLabel('LICENSOR');
  const photographerLine = input.photographerName ?? '(not specified)';
  drawText(`Photographer:     ${photographerLine}`, { size: 9 });
  drawDivider();

  // License tier block
  drawSectionLabel('LICENSE GRANT');
  drawText(`Tier:             ${input.tierName} (${input.tierCode})`, { size: 9, bold: true });
  y -= 2;
  // Wrap scope description across multiple lines if needed
  const scopeWords = input.tierScope.split(' ');
  const maxLineChars = 70;
  let currentLine = 'Scope:            ';
  for (const word of scopeWords) {
    if ((currentLine + word).length > maxLineChars) {
      drawText(currentLine.trimEnd(), { size: 9 });
      currentLine = `                  ${word} `;
    } else {
      currentLine += `${word} `;
    }
  }
  if (currentLine.trim().length > 0) {
    drawText(currentLine.trimEnd(), { size: 9 });
  }
  drawDivider();

  // Photos block
  drawSectionLabel('LICENSED PHOTOS');
  for (const photoId of input.photoIds) {
    drawText(`  ${photoId}`, { size: 8 });
    y -= smallLineHeight - 14; // tighter spacing for photo list
    if (y < margin + 80) {
      // Add new page if running low
      const newPage = pdfDoc.addPage([612, 792]);
      y = newPage.getSize().height - margin;
    }
  }
  drawDivider();

  // Terms block
  drawSectionLabel('TERMS');
  drawText(
    `This certificate grants the licensee the rights described under the "${input.tierName}"`,
    { size: 8 },
  );
  drawText('license tier for the photos listed above. All rights not expressly granted remain', {
    size: 8,
  });
  drawText('with the photographer. This license is non-transferable and non-exclusive.', {
    size: 8,
  });

  // Footer
  y = margin + 20;
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 14;
  page.drawText('This document is an automatically generated license record.', {
    x: margin,
    y,
    size: 7,
    font: helvetica,
    color: rgb(0.5, 0.5, 0.5),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
