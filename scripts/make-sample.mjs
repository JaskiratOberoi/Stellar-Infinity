/**
 * A stand-in laboratory report to try the sealer on: two portrait pages of
 * results and a landscape attachment, written to data/sample-report.pdf.
 * Invented names throughout.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.env.DATA_DIR ?? path.join(here, '..', 'data'), 'sample-report.pdf');

const A4 = [595.28, 841.89];
const ink = rgb(0.1, 0.1, 0.12);
const grey = rgb(0.45, 0.47, 0.52);
const rule = rgb(0.82, 0.84, 0.88);

const doc = await PDFDocument.create();
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function header(page, title) {
  const { width, height } = page.getSize();
  page.drawText('Riverside Clinical Laboratory', { x: 48, y: height - 60, size: 16, font: bold, color: ink });
  page.drawText('14 Harbour Road · Sample City · Tel 000 0000', { x: 48, y: height - 78, size: 9, font: helv, color: grey });
  page.drawLine({ start: { x: 48, y: height - 92 }, end: { x: width - 48, y: height - 92 }, thickness: .8, color: rule });
  page.drawText(title, { x: 48, y: height - 118, size: 12, font: bold, color: ink });
}

function patientBlock(page) {
  const { height } = page.getSize();
  const rows = [
    ['Patient', 'A. Example (F, 34 y)'], ['Sample', 'SR-2026-000123'],
    ['Collected', '12 Sep 2026 08:40'], ['Reported', '12 Sep 2026 17:05'],
    ['Referred by', 'Dr. R. Placeholder'], ['Specimen', 'Serum'],
  ];
  rows.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 48 + col * 260, y = height - 145 - row * 15;
    page.drawText(k, { x, y, size: 9, font: bold, color: grey });
    page.drawText(v, { x: x + 70, y, size: 9, font: helv, color: ink });
  });
}

function table(page, startY, rows) {
  const cols = [48, 260, 340, 420];
  let y = startY;
  ['Test', 'Result', 'Unit', 'Reference'].forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 9, font: bold, color: grey }));
  y -= 6;
  page.drawLine({ start: { x: 48, y }, end: { x: 547, y }, thickness: .6, color: rule });
  for (const r of rows) {
    y -= 18;
    r.forEach((c, i) => page.drawText(c, { x: cols[i], y, size: 10, font: i === 1 ? bold : helv, color: ink }));
  }
  return y;
}

const p1 = doc.addPage(A4);
header(p1, 'Complete Blood Count');
patientBlock(p1);
let y = table(p1, A4[1] - 210, [
  ['Haemoglobin', '12.8', 'g/dL', '12.0 – 15.5'],
  ['Total leucocyte count', '6.4', 'x10^3/uL', '4.0 – 11.0'],
  ['Platelet count', '245', 'x10^3/uL', '150 – 410'],
  ['Haematocrit', '38.2', '%', '36 – 46'],
  ['MCV', '86', 'fL', '80 – 100'],
  ['MCH', '28.9', 'pg', '27 – 32'],
  ['RDW', '13.1', '%', '11.5 – 14.5'],
]);
p1.drawText('Method: automated cell counter with manual differential where flagged.', { x: 48, y: y - 30, size: 8.5, font: helv, color: grey });

const p2 = doc.addPage(A4);
header(p2, 'Biochemistry');
patientBlock(p2);
y = table(p2, A4[1] - 210, [
  ['Fasting glucose', '92', 'mg/dL', '70 – 99'],
  ['Creatinine', '0.8', 'mg/dL', '0.6 – 1.1'],
  ['Urea', '24', 'mg/dL', '15 – 40'],
  ['Total cholesterol', '182', 'mg/dL', '< 200'],
  ['HDL cholesterol', '58', 'mg/dL', '> 40'],
  ['LDL cholesterol', '104', 'mg/dL', '< 130'],
  ['Triglycerides', '98', 'mg/dL', '< 150'],
  ['ALT (SGPT)', '21', 'U/L', '< 35'],
  ['AST (SGOT)', '19', 'U/L', '< 35'],
]);
p2.drawText('--- End of report ---', { x: 240, y: y - 30, size: 9, font: helv, color: grey });
p2.drawText('Dr. S. Example, MD (Pathology)', { x: 380, y: 150, size: 9.5, font: bold, color: ink });
p2.drawText('Consultant Pathologist', { x: 380, y: 137, size: 8.5, font: helv, color: grey });

// A landscape attachment done the way scanners do it: a portrait sheet with
// /Rotate 90, so the sealer's rotation handling gets exercised.
const p3 = doc.addPage(A4);
p3.setRotation(degrees(90));
p3.drawText('Attachment: instrument trace', { x: 60, y: 48, size: 12, font: bold, color: ink, rotate: degrees(90) });
for (let i = 0; i < 40; i++) {
  const x = 100 + i * 12;
  p3.drawLine({ start: { x: 120 + (i % 7) * 30, y: x }, end: { x: 300 + (i % 5) * 40, y: x + 10 }, thickness: .8, color: rule });
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, await doc.save());
console.log(`wrote ${out}`);
