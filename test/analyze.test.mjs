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
