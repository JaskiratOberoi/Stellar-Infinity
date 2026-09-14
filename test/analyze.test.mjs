import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyze, groupLines } from '../lib/analyze.mjs';

async function reportLike() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const line = (y, cols) => cols.forEach(([x, t]) => page.drawText(t, { x, y, size: 10, font }));
  line(780, [[48, 'Riverside Clinical Laboratory']]);
  line(740, [[48, 'Patient'], [118, 'A. Example (F, 34 y)']]);
  line(700, [[48, 'Test'], [260, 'Result'], [340, 'Unit']]);
  line(680, [[48, 'Haemoglobin'], [260, '12.8'], [340, 'g/dL']]);
  line(660, [[48, 'Total leucocyte count'], [260, '6.4'], [340, 'x10^3/uL']]);
  line(640, [[48, '--- End of report ---']]);
  line(620, [[48, 'Dr. S. Example, MD']]);
  return doc.save();
}

test('analyze finds result rows and leaves the furniture unticked', async () => {
  const { pages, lines } = await analyze(await reportLike());
  assert.equal(pages, 1);
  const byLead = Object.fromEntries(lines.map((l) => [l.text.split('  ')[0], l]));
  assert.equal(byLead['Haemoglobin'].likely, true);
  assert.equal(byLead['Total leucocyte count'].likely, true);
  assert.equal(byLead['Patient'].likely, false);
  assert.equal(byLead['Test'].likely, false);
  assert.equal(byLead['Riverside Clinical Laboratory'].likely, false);
  assert.equal(byLead['--- End of report ---'].likely, false);
  assert.equal(byLead['Dr. S. Example, MD'].likely, false);
  // Positions are raw page points of the leftmost run.
  assert.ok(Math.abs(byLead['Haemoglobin'].x - 48) < 1);
  assert.ok(Math.abs(byLead['Haemoglobin'].y - 680) < 1);
  assert.ok(byLead['Haemoglobin'].w > 40);
});

test('groupLines joins runs on one baseline and spots a row emitted as one run', () => {
  const lines = groupLines([
    { text: '12.8', x: 260, y: 680, w: 20, h: 10 },
    { text: 'Haemoglobin', x: 48, y: 680.4, w: 60, h: 10 },
    { text: 'Platelets    245   x10^3/uL', x: 48, y: 660, w: 200, h: 10 },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Haemoglobin  12.8');
  assert.equal(lines[0].likely, true);
  assert.equal(lines[1].likely, true);
});

/* The shape of an Infinity report, as the HCV one that was read wrongly: a
   patient block whose lines carry dates, a column header, a centred
   department band, ONE qualitative result with no digit on its line, the end
   marker, and a footer with a printed date. Only the result is a row. */
test('a report with a results table is read by region, qualitative values included', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const line = (y, cols) => cols.forEach(([x, t]) => page.drawText(t, { x, y, size: 9, font }));
  line(760, [[39, 'Name'], [110, ':'], [120, 'Mr ASIF'], [300, 'Patient Id'], [380, ':'], [390, '3667104']]);
  line(737, [[39, 'Ordered by'], [110, ':'], [120, 'UPMB1000'], [300, 'Collected'], [380, ':'], [390, '10/09/2026, 11:17:00 pm']]);
  line(689, [[39, 'Collected at'], [110, ':'], [120, 'DUA COLLECTION CENTRE, Moradabad'], [400, 'Ph: 8393841711']]);
  line(650, [[32, 'Test Name'], [200, 'Value'], [280, 'Unit'], [340, 'Biological Ref Interval'], [480, 'Method']]);
  line(634, [[250, 'MOLECULAR BIOLOGY']]);
  line(619, [[33, 'HCV QUANTITATIVE'], [200, 'LOWER THAN THE LINEAR RANGE OF THE ASSAY'], [400, 'IU/mL'], [480, 'RT PCR']]);
  line(600, [[33, 'Colour'], [200, 'PALE YELLOW'], [340, 'Pale'], [480, 'Visual']]);
  line(295, [[260, '*** End of Report ***']]);
  line(129, [[62, 'Dr Jasneet Kaur'], [430, 'Dr. Upinder Singh']]);
  line(104, [[28, 'MC-2547 NABL Accredited - Processed at: Noble Diagnostic, Hari Nagar, New Delhi']]);
  line(93, [[28, 'This is an electronically authenticated report. Report printed date: 13/09/2026, 09:33:55 pm']]);
  const { lines } = await analyze(await doc.save());
  const likely = lines.filter((l) => l.likely).map((l) => l.text.split('  ')[0]);
  assert.deepEqual(likely, ['HCV QUANTITATIVE', 'Colour']);
});

test('a continuation page with no header stays inside the table until the end marker', () => {
  const first = groupLines([
    { text: 'Test Name', x: 32, y: 650, w: 40, h: 9 }, { text: 'Value', x: 200, y: 650, w: 24, h: 9 },
    { text: 'Hemoglobin', x: 33, y: 619, w: 50, h: 9 }, { text: '11.8', x: 200, y: 619, w: 20, h: 9 },
  ], { width: 595 });
  assert.equal(first.filter((l) => l.likely).length, 1);
  const next = groupLines([
    { text: 'Platelet Count', x: 33, y: 780, w: 60, h: 9 }, { text: '201', x: 200, y: 780, w: 20, h: 9 },
    { text: '*** End of Report ***', x: 260, y: 700, w: 90, h: 9 },
    { text: 'This is an electronically authenticated report. Report printed date: 13/09/2026', x: 28, y: 93, w: 300, h: 9 },
  ], { width: 595, carry: true });
  assert.deepEqual(next.map((l) => l.likely), [true, false, false]);
});
