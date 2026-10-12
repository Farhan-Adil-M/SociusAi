import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdf } from '../server/services/extract/pdf.js';

// Builds a minimal, structurally valid PDF with one text line per page.
export function buildPdf(pageTexts) {
  const pageIds = pageTexts.map((_, i) => 3 + i * 2); // page obj, content obj per page
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  };
  pageTexts.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 999 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objs[contentId] = `<< /Length ${stream.length} >> stream\n${stream}\nendstream`;
  });
  objs[999] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = {};
  for (const id of Object.keys(objs).map(Number).sort((a, b) => a - b)) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefStart = out.length;
  const maxId = Math.max(...Object.keys(objs).map(Number));
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('extractPdf returns per-page text with page numbers', async () => {
  const buffer = buildPdf([
    'Mitochondria are the powerhouse of the cell.',
    'Ribosomes assemble proteins from amino acids.',
  ]);
  const { segments, pageCount, slideCount } = await extractPdf(buffer);
  assert.equal(pageCount, 2);
  assert.equal(slideCount, null);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].location, { page: 1 });
  assert.ok(segments[0].text.includes('powerhouse'));
  assert.deepEqual(segments[1].location, { page: 2 });
  assert.ok(segments[1].text.includes('Ribosomes'));
});

test('extractPdf skips pages with no extractable text', async () => {
  // Page 2 has no text-drawing operators at all.
  const buffer = buildPdf(['Only the first page has words.', '']);
  const { segments, pageCount } = await extractPdf(buffer);
  assert.equal(pageCount, 2);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].location, { page: 1 });
});

test('extractPdf rejects data that is not a PDF', async () => {
  await assert.rejects(() => extractPdf(Buffer.from('definitely not a pdf')), { code: 'VALIDATION_ERROR' });
});
