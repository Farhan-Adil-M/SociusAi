import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { extractPptx, extractSlideText, slideNumberFromPath } from '../server/services/extract/pptx.js';
import { extractWebpage, normalizeWebpageText } from '../server/services/extract/webpage.js';

// Build a minimal but structurally valid .pptx in memory.
function buildPptx(slides) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  slides.forEach((text, i) => {
    zip.addFile(
      `ppt/slides/slide${i + 1}.xml`,
      Buffer.from(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    );
  });
  return zip.toBuffer();
}

test('slideNumberFromPath only matches slide entries', () => {
  assert.equal(slideNumberFromPath('ppt/slides/slide12.xml'), 12);
  assert.equal(slideNumberFromPath('ppt/slides/_rels/slide1.xml.rels'), null);
  assert.equal(slideNumberFromPath('ppt/media/image1.png'), null);
});

test('extractSlideText joins text runs and decodes XML entities', () => {
  const xml = '<a:r><a:t>Recursion &amp; base cases</a:t></a:r><a:r><a:t> explained</a:t></a:r>';
  assert.equal(extractSlideText(xml), 'Recursion & base cases explained');
});

test('extractPptx returns per-slide segments with slide numbers', () => {
  const buffer = buildPptx([
    'Photosynthesis converts light energy into chemical energy.',
    'The light-dependent reactions happen in the thylakoid membrane &amp; beyond.',
  ]);
  const { segments, slideCount, pageCount } = extractPptx(buffer);
  assert.equal(slideCount, 2);
  assert.equal(pageCount, null);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].location, { slide: 1 });
  assert.deepEqual(segments[1].location, { slide: 2 });
  assert.ok(segments[1].text.includes('thylakoid membrane & beyond'));
});

test('extractPptx skips image-only slides but counts them', () => {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  // Slide 1 has a graphic frame but no <a:t> text runs at all.
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><p:graphicFrame/></p:sld>'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>Only slide two has words.</a:t></p:sld>'));
  const { segments, slideCount } = extractPptx(zip.toBuffer());
  assert.equal(slideCount, 2);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].location, { slide: 2 });
});

test('extractPptx rejects non-zip buffers', () => {
  assert.throws(() => extractPptx(Buffer.from('not a zip at all')), { code: 'VALIDATION_ERROR' });
});

test('normalizeWebpageText splits paragraphs and collapses whitespace', () => {
  const paragraphs = normalizeWebpageText('First   para.\nwith wrap.\n\nSecond para.');
  assert.deepEqual(paragraphs, ['First para. with wrap.', 'Second para.']);
});

test('extractWebpage validates URL and text, keeps paragraph numbers', () => {
  const good = extractWebpage({
    url: 'https://example.org/lesson',
    title: '',
    text: 'Paragraph one about cells.\n\nParagraph two about nuclei.\n\nParagraph three finishes it.',
  });
  assert.equal(good.title, 'example.org'); // hostname fallback
  assert.equal(good.segments.length, 3);
  assert.deepEqual(good.segments[1].location, { paragraph: 2 });

  assert.throws(() => extractWebpage({ url: 'ftp://x', text: 'a'.repeat(60) }), { code: 'INVALID_URL' });
  assert.throws(() => extractWebpage({ url: 'https://x.org', text: 'too short' }), { code: 'VALIDATION_ERROR' });
});
