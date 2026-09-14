/* The sealing page. Plain DOM; nothing here needs a framework. */
const $ = (s) => document.querySelector(s);

const form = $('#form');
const drop = $('#drop');
const input = $('#file');
const fileCard = $('#fileCard');
const rowsCard = $('#rowsCard');
const rowsBox = $('#rows');
const rowsNote = $('#rowsNote');
const rowsCount = $('#rowsCount');
const go = $('#go');
const status = $('#status');
const errorBox = $('#error');
const empty = $('#empty');
const result = $('#result');

/** The upload as the server described it: id, pages, and the text lines found. */
let upload = null;
/** Indices into upload.lines that will get the row mark. */
const selected = new Set();
let showAll = false;

/* ---------------------------------------------------------------- limits -- */
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h.maxUploadMb) $('#maxMb').textContent = String(h.maxUploadMb);
}).catch(() => {});

/* ------------------------------------------------------------------ file -- */
const fmtSize = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function setFile(f) {
  if (!f) return;
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  if (!isPdf) { showError('That is not a PDF. Export or print the report to PDF first, then drop it here.'); return; }
  hideError();
  $('#fileName').textContent = f.name;
  $('#fileInfo').textContent = `${fmtSize(f.size)} · reading…`;
  fileCard.hidden = false;
  drop.hidden = true;
  status.textContent = 'Reading the report…';
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(f.name) },
      body: f,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The file could not be read (HTTP ${res.status}).`);
    upload = body;
    selected.clear();
    body.lines.forEach((l, i) => { if (l.likely) selected.add(i); });
    const likely = body.lines.filter((l) => l.likely).length;
    $('#fileInfo').textContent = `${fmtSize(f.size)} · ${plural(body.pages, 'page')} · ${plural(likely, 'result row')} found`;
    renderRows();
    rowsCard.hidden = false;
    go.disabled = false;
    status.textContent = '';
  } catch (err) {
    showError(err instanceof Error ? err.message : 'The file could not be read.');
    clearFile();
  }
}

function clearFile() {
  upload = null;
  selected.clear();
  input.value = '';
  fileCard.hidden = true;
  rowsCard.hidden = true;
  drop.hidden = false;
  go.disabled = true;
  status.textContent = '';
}

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => setFile(input.files?.[0]));
$('#clear').addEventListener('click', clearFile);

for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drop--over'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drop--over'); });
}
drop.addEventListener('drop', (e) => { e.stopPropagation(); setFile(e.dataTransfer?.files?.[0]); });

// A file dropped anywhere on the page lands in the drop zone too.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (!upload) setFile(e.dataTransfer?.files?.[0]); });

/* ------------------------------------------------------------------ rows -- */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function updateCount() {
  const total = upload ? upload.lines.length : 0;
  rowsCount.textContent = `${plural(selected.size, 'line')} will carry the mark · ${plural(total, 'line')} in the document`;
}

function renderRows() {
  rowsBox.replaceChildren();
  rowsNote.hidden = true;
  if (!upload) return;

  if (upload.analysisError) {
    rowsNote.textContent = upload.analysisError;
    rowsNote.hidden = false;
  } else if (upload.lines.length === 0) {
    rowsNote.textContent = 'No text was found in this PDF, so there are no lines to mark. It may be a scanned image. The foot mark and the QR will still be added.';
    rowsNote.hidden = false;
  } else if (!upload.lines.some((l) => l.likely) && !showAll) {
    rowsNote.textContent = 'No line looked like a result row. Tick "Show every line" to choose by hand.';
    rowsNote.hidden = false;
  }
  if (upload.truncated) {
    rowsNote.textContent += ' Only the first part of a very long document was read.';
    rowsNote.hidden = false;
  }

  let currentPage = -1;
  upload.lines.forEach((l, idx) => {
    if (!l.likely && !showAll) return;
    if (l.page !== currentPage) {
      currentPage = l.page;
      rowsBox.append(el('div', 'rows__page', `Page ${l.page + 1}`));
    }
    const label = el('label', `row${l.likely ? '' : ' row--dim'}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(idx);
    cb.addEventListener('change', () => { if (cb.checked) selected.add(idx); else selected.delete(idx); updateCount(); });
    label.append(cb, el('span', 'row__text', l.text));
    rowsBox.append(label);
  });
  updateCount();
}

$('#rowsAll').addEventListener('click', () => {
  upload?.lines.forEach((l, i) => { if (l.likely || showAll) selected.add(i); });
  renderRows();
});
$('#rowsNone').addEventListener('click', () => { selected.clear(); renderRows(); });
$('#rowsShowAll').addEventListener('change', (e) => { showAll = e.target.checked; renderRows(); });

/* ---------------------------------------------------------------- ranges -- */
for (const out of document.querySelectorAll('output[data-for]')) {
  const range = form.elements[out.dataset.for];
  const show = () => { out.textContent = `${range.value} mm`; };
  range.addEventListener('input', show);
  show();
}

/* --------------------------------------------------------------- feedback -- */
function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
function hideError() { errorBox.hidden = true; }

/* ------------------------------------------------------------------ seal -- */
const OPTION_FIELDS = ['cert', 'mark', 'markPages', 'markSize', 'rowSize', 'qr', 'qrPages', 'qrSize', 'caption', 'numbers', 'margin'];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!upload) return;
  hideError();
  go.disabled = true;
  status.textContent = 'Sealing…';

  const options = {};
  for (const name of OPTION_FIELDS) options[name] = form.elements[name].value;
  const rows = [...selected].sort((a, b) => a - b).map((i) => {
    const l = upload.lines[i];
    return { page: l.page, x: l.x, y: l.y, w: l.w, h: l.h };
  });

  try {
    const res = await fetch('/api/seal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: upload.uploadId, options, rows }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Sealing failed (HTTP ${res.status}).`);
    showResult(body);
    status.textContent = '';
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Sealing failed.');
    status.textContent = '';
    go.disabled = false;
  }
});

const POS = {
  'header-left': 'top left', 'header-center': 'top centre', 'header-right': 'top right',
  'footer-left': 'bottom left', 'footer-center': 'bottom centre', 'footer-right': 'bottom right',
};
const PAGES = { all: 'every page', first: 'the first page', last: 'the last page' };

function summary(r) {
  const parts = [];
  const o = r.options;
  if (r.stamped.rows) parts.push(`${plural(r.stamped.rows, 'parameter')} marked`);
  if (r.stamped.mark) parts.push(`foot mark ${POS[o.mark]} on ${PAGES[o.markPages]}`);
  if (o.cert && (r.stamped.rows || r.stamped.mark)) parts.push(o.cert);
  if (r.stamped.qr) parts.push(`QR ${POS[o.qr]} on ${PAGES[o.qrPages]}`);
  if (o.numbers !== 'off') parts.push('pages numbered');
  return `${plural(r.pages, 'page')} · ${parts.join(' · ') || 'nothing stamped'} · ${fmtSize(r.sealedBytes)}`;
}

function showResult(r) {
  $('#rid').textContent = r.id;
  $('#summary').textContent = summary(r);
  $('#preview').src = r.viewUrl;
  $('#qr').src = r.qrImageUrl;
  const link = $('#plink');
  link.href = r.publicUrl;
  link.textContent = r.publicUrl;
  const dl = $('#dl');
  dl.href = r.downloadUrl;
  dl.setAttribute('download', `${(r.originalName || 'report').replace(/\.pdf$/i, '')}-sealed.pdf`);
  empty.hidden = true;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#copy').addEventListener('click', async () => {
  const btn = $('#copy');
  try {
    await navigator.clipboard.writeText($('#plink').href);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Select the link and copy it';
  }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 1800);
});

$('#again').addEventListener('click', () => {
  clearFile();
  $('#preview').src = 'about:blank';
  result.hidden = true;
  empty.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
