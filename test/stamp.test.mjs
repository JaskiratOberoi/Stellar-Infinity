import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { DEFAULTS, SealError, normalizeOptions, normalizeRows, seal } from '../lib/stamp.mjs';

async function threePages() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]);
  const rotated = doc.addPage([595.28, 841.89]);
  rotated.setRotation(degrees(90));
  return doc.save();
}

const xobjectCount = (page) => {
  const xo = page.node.Resources()?.lookup(PDFName.of('XObject'));
  if (!xo) return 0;
  return new Set(xo.keys().map((k) => String(xo.get(k)))).size;
};

test('defaults survive nonsense input', () => {
  const o = normalizeOptions({ mark: 'moon', markSize: '999', qrSize: 'abc', numbers: 'up', margin: '-4', cert: 'MC‑1234' });
  assert.equal(o.mark, DEFAULTS.mark);
  assert.equal(o.markSize, 40);
  assert.equal(o.qrSize, DEFAULTS.qrSize);
  assert.equal(o.numbers, DEFAULTS.numbers);
  assert.equal(o.margin, 3);
  assert.equal(o.cert, 'MC1234');
});

test('seals every page, keeps the page count, embeds the two images once', async () => {
  const input = await threePages();
  const { bytes, pages, stamped } = await seal(input, { cert: 'MC-0001' }, { qrUrl: 'https://example.org/r/ABCDEFGHJK?t=tok' });
  assert.equal(pages, 3);
  assert.deepEqual(stamped, { mark: true, qr: true, rows: 0, qrReplaced: 0 });
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 3);
  for (const p of out.getPages()) assert.equal(xobjectCount(p), 2, 'symbol and qr on each page');
  // One image object each, shared: count image XObjects in the whole file.
  let images = 0;
  for (const [, obj] of out.context.enumerateIndirectObjects()) {
    if (obj?.dict?.get?.(PDFName.of('Subtype')) === PDFName.of('Image')) images++;
  }
  // symbol (RGB + its alpha SMask) and the QR.
  assert.ok(images >= 2 && images <= 3, `expected 2-3 image objects, saw ${images}`);
  assert.equal(out.getPage(2).getRotation().angle, 90, 'rotation preserved');
});

test('first-page-only and off are honoured', async () => {
  const input = await threePages();
  const { bytes, stamped } = await seal(input, { markPages: 'first', qr: 'off', numbers: 'off' }, { qrUrl: 'https://example.org/x' });
  assert.deepEqual(stamped, { mark: true, qr: false, rows: 0, qrReplaced: 0 });
  const out = await PDFDocument.load(bytes);
  assert.equal(xobjectCount(out.getPage(0)), 1);
  assert.equal(xobjectCount(out.getPage(1)), 0);
});

test('row marks: drawn on their page, shared image, tolerant of junk', async () => {
  const input = await threePages();
  const rows = [
    { page: 1, x: 48, y: 600, w: 60, h: 10 },
    { page: 1, x: 48, y: 580, w: 60, h: 10 },
    { page: 2, x: 48, y: 500, w: 60, h: 10 },       // the rotated page
    { page: 9, x: 48, y: 500, w: 60, h: 10 },       // no such page
    { page: 0, x: 'x', y: 500 },                    // not numbers
  ];
  assert.equal(normalizeRows(rows, 3).length, 3);
  const { bytes, stamped } = await seal(input, { mark: 'off', qr: 'off', numbers: 'off' }, { rows });
  assert.deepEqual(stamped, { mark: false, qr: false, rows: 3, qrReplaced: 0 });
  const out = await PDFDocument.load(bytes);
  assert.equal(xobjectCount(out.getPage(0)), 0);
  assert.equal(xobjectCount(out.getPage(1)), 1, 'one shared symbol on page 2');
  assert.equal(xobjectCount(out.getPage(2)), 1);
});

test('the usual defaults: symbol beside and qr in place of the report\'s own, no certificate number', () => {
  const o = normalizeOptions({});
  assert.equal(o.cert, '');
  assert.equal(o.mark, 'original');
  assert.equal(o.qr, 'original');
  assert.equal(o.rowSize, DEFAULTS.rowSize);
});

/* A page carrying a QR of its own: the seal's QR takes its box and the symbol
   sits beside it; a page without one gets the bottom-centre fallback. */
test('original placement replaces the report\'s own qr where there is one', async () => {
  const { analyze } = await import('../lib/analyze.mjs');
  const { qrPng } = await import('../lib/links.mjs');
  const doc = await PDFDocument.create();
  const own = await doc.embedPng(await qrPng('https://example.org/verify/1'));
  const first = doc.addPage([595.28, 841.89]);
  first.drawImage(own, { x: 280, y: 126, width: 36, height: 36 });   // the report's verify code
  doc.addPage([595.28, 841.89]);                                       // a continuation sheet, no QR
  const input = await doc.save();

  const { qrs } = await analyze(input);
  assert.equal(qrs.length, 1);
  assert.equal(qrs[0].page, 0);
  assert.ok(Math.abs(qrs[0].x - 280) < 1 && Math.abs(qrs[0].y - 126) < 1 && Math.abs(qrs[0].w - 36) < 1);

  const { bytes, stamped } = await seal(input, { numbers: 'off' }, { qrUrl: 'https://example.org/r/ABCDEFGHJK?t=tok', qrBoxes: qrs });
  assert.equal(stamped.qrReplaced, 1);
  const out = await PDFDocument.load(bytes);
  // Page 1: the report's own image, the symbol and the seal's QR.
  assert.equal(xobjectCount(out.getPage(0)), 3);
  // Page 2 fell back to the bottom centre: symbol and QR only.
  assert.equal(xobjectCount(out.getPage(1)), 2);
});

test('no qr url means no qr', async () => {
  const { stamped } = await seal(await threePages(), {}, {});
  assert.equal(stamped.qr, false);
  assert.equal(stamped.rows, 0);
});

test('refuses what is not a pdf', async () => {
  await assert.rejects(() => seal(Buffer.from('hello'), {}, {}), SealError);
});
