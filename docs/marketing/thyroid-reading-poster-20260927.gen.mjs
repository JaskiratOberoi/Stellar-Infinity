import fs from 'node:fs';
const D = 'C:/Users/QUGENP~1/AppData/Local/Temp/claude/X--/c2ce6b95-f35e-4953-b81b-9af88930dbb0/scratchpad/poster/';
const A = JSON.parse(fs.readFileSync(D + 'assets.json', 'utf8'));
const R = String.raw;

/* ── the figure as it prints: greyscale, subclinical hypothyroidism ── */
const GX = 74, GY = 24, CW = 88, CH = 58, GR = GX + 3 * CW, BX = 440, BW = 250;
const labels = [[['Overactive'], ['High T4,', 'normal TSH'], ['Unusual —', 'needs review']],
  [['Mildly', 'overactive'], ['Normal'], ['Mildly', 'underactive']],
  [['Low TSH', 'and low T4'], ['Low T4,', 'normal TSH'], ['Underactive']]];
const hereR = 1, hereC = 2;
let cells = '';
labels.forEach((row, r) => row.forEach((lines, c) => {
  const here = r === hereR && c === hereC, normal = r === 1 && c === 1;
  const x = GX + c * CW, y = GY + r * CH;
  cells += `<rect x="${x + 1}" y="${y + 1}" width="${CW - 2}" height="${CH - 2}" rx="5" fill="${here ? '#e4e4e7' : normal ? '#fff' : '#fafafa'}" stroke="${here ? '#111827' : normal ? '#3f3f46' : '#c4c7cd'}" stroke-width="${here ? 2.4 : normal ? 1 : 0.8}"${normal ? ' stroke-dasharray="3 2"' : ''}/>`;
  lines.forEach((l, i) => {
    cells += `<text x="${x + CW / 2}" y="${y + CH / 2 + (i - (lines.length - 1) / 2) * 12 + (here ? 7 : 4)}" font-size="${here ? 10.5 : 9.5}" font-weight="${here || normal ? 700 : 500}" fill="${here || normal ? '#111827' : '#3f3f46'}" text-anchor="middle">${l}</text>`;
  });
  if (here) cells += `<rect x="${x + CW / 2 - 31}" y="${y + 4}" width="62" height="12" rx="6" fill="#111827"/><text x="${x + CW / 2}" y="${y + 12.8}" font-size="7.5" font-weight="700" fill="#fff" text-anchor="middle">THIS RESULT</text>`;
}));
const axis = (arr, fn) => arr.map(fn).join('');
const bar = (label, text, word, lo, hi, v, min, max, y, log, off) => {
  const f = (n) => (log ? Math.log10(n) : n);
  const px = (n) => BX + ((f(Math.min(max, Math.max(min, n))) - f(min)) / (f(max) - f(min))) * BW;
  const by = y + 9;
  return `<text x="${BX}" y="${y}" font-size="11" font-weight="700" fill="#111827">${label}</text>${log ? `<text x="${BX + 30}" y="${y}" font-size="8" fill="#595959">· log scale to 100</text>` : ''}
  <text x="${BX + BW}" y="${y}" font-size="11" font-weight="${off ? 700 : 500}" fill="#111827" text-anchor="end">${off ? '▲ ' : ''}${text}<tspan font-weight="400" fill="#3f3f46"> · ${word}</tspan></text>
  <rect x="${BX}" y="${by}" width="${BW}" height="10" rx="5" fill="url(#h)"/><rect x="${px(lo)}" y="${by}" width="${Math.max(2, px(hi) - px(lo))}" height="10" fill="#fff" stroke="#111827" stroke-width="0.9"/><rect x="${BX}" y="${by}" width="${BW}" height="10" rx="5" fill="none" stroke="#9ca3af" stroke-width="0.7"/>
  <path d="M${px(v)} ${by + 1} l-4.5 -7 h9 z" fill="#111827"/><line x1="${px(v)}" y1="${by}" x2="${px(v)}" y2="${by + 10}" stroke="#111827" stroke-width="1.8"/>
  <text x="${px(lo)}" y="${by + 21}" font-size="8.5" fill="#595959" text-anchor="middle">${lo}</text><text x="${px(hi)}" y="${by + 21}" font-size="8.5" fill="#595959" text-anchor="middle">${hi}</text>${log ? `<text x="${px(100)}" y="${by + 21}" font-size="8.5" fill="#595959" text-anchor="end">100</text>` : ''}`;
};
const figure = `<svg viewBox="0 0 700 262" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;font-family:'Liberation Sans',Arial,sans-serif">
<defs><pattern id="h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#f4f4f5"/><line x1="0" y1="0" x2="0" y2="5" stroke="#8a8f98" stroke-width="1.2"/></pattern></defs>
${cells}
${axis(['TSH low', 'TSH normal', 'TSH high'], (t, i) => `<text x="${GX + i * CW + CW / 2}" y="${GY + 3 * CH + 14}" font-size="9.5" font-weight="${i === hereC ? 700 : 500}" fill="${i === hereC ? '#111827' : '#3f3f46'}" text-anchor="middle">${i === hereC ? '▸ ' : ''}${t}</text>`)}
<text x="${GX + 1.5 * CW}" y="${GY + 3 * CH + 27}" font-size="8.5" fill="#595959" text-anchor="middle">TSH — the pituitary’s signal to the thyroid →</text>
${axis(['T4 high', 'T4 normal', 'T4 low'], (t, i) => `<text x="${GX - 8}" y="${GY + i * CH + CH / 2 + 3.5}" font-size="9.5" font-weight="${i === hereR ? 700 : 500}" fill="${i === hereR ? '#111827' : '#3f3f46'}" text-anchor="end">${t}${i === hereR ? ' ▸' : ''}</text>`)}
<text x="2" y="${GY - 9}" font-size="8.5" fill="#595959">↑ T4 — what the thyroid makes</text>
${axis(['T3 high', 'T3 normal', 'T3 low'], (t, i) => `<text x="${GR + 8}" y="${GY + i * CH + CH / 2 + 3.5}" font-size="9.5" font-weight="${i === 1 ? 700 : 500}" fill="${i === 1 ? '#111827' : '#3f3f46'}">${i === 1 ? '◂ ' : ''}${t}</text>`)}
<text x="${GR + 8}" y="${GY - 9}" font-size="8.5" fill="#595959">↑ T3 — usually moves with T4</text>
${bar('TSH', '8.62 uIU/ml', 'above range', 0.35, 5.5, 8.62, 0.05, 100, GY + 4, true, true)}
${bar('T4', '6.1 ug/dl', 'within range', 3.4, 12.6, 6.1, 3.4 - 0.6 * 9.2, 12.6 + 0.6 * 9.2, GY + 54, false, false)}
${bar('T3', '1.05 ng/ml', 'within range', 0.6, 1.81, 1.05, 0, 1.81 + 0.6 * 1.21, GY + 104, false, false)}
<text x="${BX}" y="${GY + 4 + 150 - 6}" font-size="8.5" fill="#595959">clear: within the reference band · hatched: below or above it</text>
<line x1="0" y1="236" x2="700" y2="236" stroke="#9ca3af" stroke-width="0.8"/><rect x="0" y="243" width="6" height="14" rx="1.5" fill="#111827"/>
<text x="12" y="254.5" font-size="11.5" font-weight="700" fill="#111827">Pattern: Mildly underactive (subclinical hypothyroidism)</text>
</svg>`;

const ico = {
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="#fff" stroke="none"/></svg>`,
  bands: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M3 7h18M3 12h18M3 17h18"/><circle cx="9" cy="7" r="2.2" fill="#fff" stroke="none"/><circle cx="15" cy="12" r="2.2" fill="#fff" stroke="none"/><circle cx="7" cy="17" r="2.2" fill="#fff" stroke="none"/></svg>`,
  words: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M4 5h16M4 10h12M4 15h16M4 20h8"/></svg>`,
  print: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>`,
  free: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2" fill="#fff"/></svg>`,
  doctor: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/><path d="M8 11h8M8 14h5"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="#5b2bb5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2" fill="#5b2bb5"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" fill="none" stroke="#5b2bb5" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="#5b2bb5" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>`,
};

const PAT = [
  ['Overactive thyroid', 'hyperthyroidism', 'r'], ['High T4, normal TSH', 'binding proteins · early overactivity', 'a'], ['Unusual — needs review', 'test interference · rare pituitary causes', 'a'],
  ['Mildly overactive', 'subclinical hyperthyroidism', 'a'], ['Normal thyroid function', 'TSH and T4 in balance', 'g'], ['Mildly underactive', 'subclinical hypothyroidism', 'a'],
  ['Low TSH and low T4', 'pituitary · recent illness', 'a'], ['Low T4, normal TSH', 'pituitary · medicines', 'a'], ['Underactive thyroid', 'primary hypothyroidism', 'r'],
];

const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
const html = R`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Thyroid Profile — Now explained on the report</title>
<style>
@font-face{font-family:'Playfair';src:url(${A.playfair}) format('woff2');font-weight:400 700}
@font-face{font-family:'Playfair';src:url(${A.playfairItalic}) format('woff2');font-style:italic;font-weight:400 700}
:root{--purple:#5b2bb5;--violet:#8a3ffc;--navy:#1b1b52;--ink:#141733;--teal:#0f9d8a;--lav:#eef0fb;--muted:#4b5170}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1080px;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;color:var(--ink);background:#fff}
.poster{width:1080px;position:relative;overflow:hidden;background:
  radial-gradient(900px 520px at 88% -8%,#dcd0ff 0%,rgba(220,208,255,0) 60%),
  radial-gradient(700px 480px at -10% 30%,#e3f4ff 0%,rgba(227,244,255,0) 60%),
  radial-gradient(800px 600px at 60% 105%,#e9dcff 0%,rgba(233,220,255,0) 60%),#f7f7fd}
.wrap{padding:0 44px}
.script{font-family:'Playfair',Georgia,serif;font-style:italic}
.grad{background:linear-gradient(92deg,#5b2bb5,#8a3ffc 55%,#b06cff);-webkit-background-clip:text;background-clip:text;color:transparent}
.pill{display:inline-block;padding:8px 18px;border-radius:999px;font-weight:700;font-size:16px;letter-spacing:.02em;color:#fff;background:linear-gradient(92deg,#5b2bb5,#8a3ffc)}
.card{background:rgba(255,255,255,.86);border:1px solid rgba(91,43,181,.12);border-radius:22px;box-shadow:0 14px 34px rgba(60,30,130,.10)}
/* header */
.head{display:flex;align-items:center;justify-content:space-between;padding:30px 44px 8px}
.brand{display:flex;align-items:center;gap:18px}
.brand img{height:66px;display:block}
.brand .div{width:1.5px;height:56px;background:rgba(27,27,82,.25)}
.brand .inf{font-weight:700;letter-spacing:.22em;font-size:22px;color:var(--navy);line-height:1.15}
.brand .inf small{display:block;font-weight:400;letter-spacing:.14em;font-size:12px;color:var(--muted)}
.tag{font-size:19px;font-weight:700;color:var(--purple);text-align:right;line-height:1.25}
/* hero */
.hero{display:grid;grid-template-columns:400px 1fr;gap:30px;align-items:start;padding-top:20px}
h1{font-size:64px;line-height:.98;letter-spacing:-.02em;color:var(--navy);margin:16px 0 14px;font-weight:700}
.lead{font-size:18.5px;line-height:1.45;color:var(--muted)}
.lead b{color:var(--purple)}
.ticks{list-style:none;margin-top:18px;display:flex;flex-direction:column;gap:9px}
.ticks li{display:flex;gap:10px;align-items:center;font-size:15px;color:var(--muted);line-height:1.3}.ticks li b{color:var(--navy)}
.price{margin-top:18px;display:grid;grid-template-columns:auto 1fr;column-gap:16px;align-items:center;background:#fff;border:1.5px solid rgba(91,43,181,.18);border-radius:18px;padding:12px 18px;box-shadow:0 12px 28px rgba(60,30,130,.10)}
.price .amt{font-size:48px;font-weight:700;color:var(--purple);letter-spacing:-.03em;line-height:1;grid-row:1/3}
.price .per{font-size:15px;font-weight:700;color:var(--navy);line-height:1.2;white-space:nowrap}
.price .per br{display:none}
.price .note{font-size:11.5px;color:var(--muted);line-height:1.3;margin-top:3px}
.price .note br{display:none}
.ticks li i{width:24px;height:24px;border-radius:50%;background:var(--teal);display:inline-grid;place-items:center;flex:none}
.ticks li i svg{width:14px;height:14px}
.mock{position:relative;padding-top:30px}
.sheet{background:#fff;border-radius:16px;border:1px solid #d9d6ea;box-shadow:0 30px 60px rgba(50,20,120,.22),0 2px 0 #fff inset;padding:18px 18px 14px;transform:rotate(-1.2deg)}
.sheet .strip{display:flex;justify-content:space-between;align-items:center;font-size:10px;letter-spacing:.14em;color:#3a3f6a;font-weight:700;border-bottom:1.5px solid #e6e4f2;padding-bottom:6px;margin-bottom:8px}
.sheet .strip img{height:22px}
.rows{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px}
.rows th{text-align:left;font-size:9px;letter-spacing:.1em;color:#5c6086;padding:2px 4px;border-bottom:1px solid #e6e4f2}
.rows td{padding:3px 4px;color:#1a1d3d}
.rows td.v{font-weight:700}
.rows td.hi{color:#111;font-weight:700}
.rows tr.prof td{font-weight:700;letter-spacing:.04em;font-size:10px;color:#2a2d55;padding-top:5px}
.fig{border:1px solid #9ca3af;border-radius:6px;padding:6px 10px 6px}
.fig h4{font-size:12px;margin-bottom:2px}.fig h4 span{font-weight:400;font-size:9.5px;color:#3f3f46;margin-left:8px}
.fig p{font-size:9.8px;line-height:1.35;margin-top:4px;color:#111}
.fig p.note{font-size:8px;color:#3f3f46;margin-top:3px}
.badge{position:absolute;display:flex;align-items:center;gap:10px;background:#fff;border-radius:999px;padding:8px 16px 8px 8px;box-shadow:0 10px 26px rgba(50,20,120,.18);font-size:13px;font-weight:700;color:var(--navy);white-space:nowrap}
.badge i{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;flex:none}
.badge i svg{width:20px;height:20px}
.badge.b1{top:-26px;left:-30px}.badge.b2{bottom:96px;right:-26px}.badge.b3{bottom:-16px;left:40px}
.i-p{background:linear-gradient(135deg,#5b2bb5,#8a3ffc)}.i-t{background:linear-gradient(135deg,#0f9d8a,#2bc4a8)}.i-b{background:linear-gradient(135deg,#1f6fd6,#4ea3ff)}
/* steps */
.sec{margin-top:34px}
.sec h2{font-size:30px;color:var(--navy);letter-spacing:-.01em;margin-bottom:14px;display:flex;align-items:center;gap:14px}
.sec h2 .pill{font-size:14px;padding:6px 14px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step{padding:18px 18px 16px;position:relative}
.step .n{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#5b2bb5,#8a3ffc);color:#fff;font-weight:700;font-size:20px;display:grid;place-items:center;margin-bottom:10px}
.step h3{font-size:18px;color:var(--navy);margin-bottom:5px}
.step p{font-size:14px;line-height:1.42;color:var(--muted)}
/* patterns */
.pat{display:grid;grid-template-columns:78px repeat(3,1fr) 78px;gap:8px;align-items:stretch}
.pat .ax{display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--purple);text-align:center;line-height:1.2}
.pat .c{border-radius:14px;padding:12px 12px 10px;border:1.5px solid rgba(91,43,181,.14);background:#fff}
.pat .c b{display:block;font-size:14.5px;color:var(--navy);margin-bottom:3px}
.pat .c span{font-size:11.5px;color:var(--muted);line-height:1.3;display:block}
.pat .c.g{background:linear-gradient(135deg,#e6faf4,#f4fffb);border-color:#0f9d8a}.pat .c.g b{color:#0b7a6a}
.pat .c.r{background:linear-gradient(135deg,#fff0f0,#fff7f7);border-color:#e0616a}.pat .c.r b{color:#b3232c}
.pat .c.a{background:linear-gradient(135deg,#fff8e8,#fffdf6);border-color:#e6b23a}.pat .c.a b{color:#9a6a10}
.pat .bot{grid-column:2/5;display:grid;grid-template-columns:repeat(3,1fr);text-align:center;font-size:12px;font-weight:700;color:var(--purple);padding-top:2px}
/* features */
.feat{display:grid;grid-template-columns:repeat(4,1fr);padding:16px 10px}
.feat>div{display:flex;align-items:center;gap:12px;padding:6px 14px;border-left:1.5px solid rgba(27,27,82,.14)}
.feat>div:first-child{border-left:none}
.feat i{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;flex:none}
.feat i svg{width:24px;height:24px}
.feat b{display:block;font-size:14.5px;color:var(--navy);line-height:1.2}
.feat small{font-size:11.5px;color:var(--muted)}
/* cta */
.cta{display:grid;grid-template-columns:1fr auto;align-items:center;gap:20px;padding:18px 22px}
.cta .l{display:flex;align-items:center;gap:16px;font-size:24px;color:var(--navy);line-height:1.25}
.cta .l b{color:var(--purple)}
.cta .l i{width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#5b2bb5,#8a3ffc);display:grid;place-items:center;flex:none}
.cta .l i svg{width:30px;height:30px}
.cta .btn{display:flex;align-items:center;gap:14px;padding:18px 34px;border-radius:18px;background:linear-gradient(92deg,#5b2bb5,#9b4dff);color:#fff;font-size:26px;font-weight:700;box-shadow:0 14px 30px rgba(91,43,181,.35)}
.cta .btn svg{width:30px;height:30px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);margin-top:14px;padding:14px 10px}
.facts div{display:flex;align-items:center;gap:12px;padding:4px 16px;font-size:14px;line-height:1.35;color:var(--navy);border-left:1.5px solid rgba(27,27,82,.14)}
.facts div:first-child{border-left:none}
.facts i{width:44px;height:44px;border-radius:50%;background:#efe9fb;display:grid;place-items:center;flex:none}
.facts i svg{width:22px;height:22px}
.facts b{color:var(--purple)}
/* footer */
.foot{margin-top:34px;background:linear-gradient(92deg,#1b1b52,#3a1f86 60%,#5b2bb5);color:#fff;padding:26px 44px;display:flex;align-items:center;justify-content:space-between}
.foot .c{display:flex;align-items:center;gap:26px;font-size:16px}
.foot .c span{display:flex;align-items:center;gap:8px}
.foot .c svg{width:20px;height:20px}
.foot .s{font-size:24px;line-height:1.1;text-align:right}
</style></head>
<body><div class="poster">
  <div class="head">
    <div class="brand"><img src="${A.logo}" alt="Noble Diagnostics"><div class="div"></div><div class="inf">INFINITY<small>CLIENT PORTAL</small></div></div>
    <div class="tag">Smarter Diagnostics<br>for a Healthier Tomorrow</div>
  </div>

  <div class="wrap">
    <div class="hero">
      <div>
        <span class="pill">New · Thyroid Profile I</span>
        <h1>Your <span class="grad">Thyroid</span>, explained on the report</h1>
        <p class="lead">Every Thyroid Profile I now comes with a <b>reading guide</b> printed under the results. Patients finally see what their TSH, T4 and T3 mean together — and doctors get the pattern <b>named at a glance</b>, ready for the consultation.</p>
        <ul class="ticks">
          <li><i>${TICK}</i><span><b>Patients understand</b> — the pattern in plain words, not just numbers</span></li>
          <li><i>${TICK}</i><span><b>Doctors decide faster</b> — TSH × T4 grid with T3 alongside, nothing to work out</span></li>
          <li><i>${TICK}</i><span><b>Fewer follow-up calls</b> — the usual next step is already on the report</span></li>
          <li><i>${TICK}</i><span><b>Prints crisp</b> in black and white, on every paper</span></li>
        </ul>
        <div class="price"><span class="amt">₹5</span><span class="per">additional<br>per Thyroid Profile I</span><span class="note">over the current profile price · billed with the order</span></div>
      </div>
      <div class="mock">
        <div class="sheet">
          <div class="strip"><img src="${A.logo}" alt=""><span>CLINICAL BIOCHEMISTRY · THYROID PROFILE I</span></div>
          <table class="rows">
            <tr><th>Test</th><th>Value</th><th>Unit</th><th>Ref. interval</th></tr>
            <tr class="prof"><td colspan="4">THYROID PROFILE I</td></tr>
            <tr><td>T3 (Tri Iodothyronine)</td><td class="v">1.05</td><td>ng/ml</td><td>0.60 - 1.81</td></tr>
            <tr><td>T4 (Thyroxine)</td><td class="v">6.1</td><td>ug/dl</td><td>3.4 - 12.6</td></tr>
            <tr><td>Thyroid Stimulating Hormone (TSH)</td><td class="hi">8.62 ▲</td><td>uIU/ml</td><td>0.35 - 5.50</td></tr>
          </table>
          <div class="fig">
            <h4>Reading this thyroid profile<span>a guide to the pattern the results make, not a diagnosis</span></h4>
            ${figure}
            <p>T4 is still within range but the pituitary is pushing the thyroid harder than usual. Often watched and repeated; treated if it persists, in pregnancy, or with symptoms. T3 is within range.</p>
            <p class="note">Read from TSH and T4 against the reference bands printed above, with T3 alongside; medicines, pregnancy and recent illness all change the reading. Your doctor interprets it with the clinical picture.</p>
          </div>
        </div>
        <div class="badge b1"><i class="i-p">${ico.words}</i>Patients understand their result</div>
        <div class="badge b2"><i class="i-t">${ico.grid}</i>Doctors see the pattern at a glance</div>
        <div class="badge b3"><i class="i-b">${ico.print}</i>Prints in black &amp; white</div>
      </div>
    </div>

    <div class="sec">
      <h2>How to read it <span class="pill">three steps</span></h2>
      <div class="steps">
        <div class="card step"><div class="n">1</div><h3>Find the cell</h3><p>TSH runs across — the pituitary's signal. T4 runs down — what the thyroid makes. The cell where they meet is tagged <b>THIS RESULT</b>.</p></div>
        <div class="card step"><div class="n">2</div><h3>Check the bands</h3><p>TSH, T4 and T3 each sit on their own scale: clear inside the reference band, hatched below or above it, a pointer at the value.</p></div>
        <div class="card step"><div class="n">3</div><h3>Read the pattern</h3><p>The pattern is named and explained in two or three plain sentences — what it usually means and what is typically done next.</p></div>
      </div>
    </div>

    <div class="sec">
      <h2>The nine patterns, at a glance <span class="pill">TSH across · T4 down</span></h2>
      <div class="pat">
        ${[0, 1, 2].map((r) => `<div class="ax">${['T4<br>high', 'T4<br>normal', 'T4<br>low'][r]}</div>` + PAT.slice(r * 3, r * 3 + 3).map(([b, s, k]) => `<div class="c ${k}"><b>${b}</b><span>${s}</span></div>`).join('') + `<div class="ax">${['T3<br>high', 'T3<br>normal', 'T3<br>low'][r]}</div>`).join('')}
        <div></div><div class="bot"><span>TSH low</span><span>TSH normal</span><span>TSH high</span></div><div></div>
      </div>
    </div>

    <div class="card feat" style="margin-top:30px">
      <div><i class="i-p">${ico.words}</i><div><b>Patient-Friendly</b><small>Plain words, no jargon</small></div></div>
      <div><i class="i-t">${ico.bands}</i><div><b>Same Lab Values</b><small>Only the reading is added</small></div></div>
      <div><i class="i-b">${ico.doctor}</i><div><b>Doctor-Ready</b><small>Pattern named, next step noted</small></div></div>
      <div><i class="i-p">${ico.free}</i><div><b>Just ₹5 More</b><small>Per Thyroid Profile I</small></div></div>
    </div>

    <div class="card cta" style="margin-top:18px">
      <div class="l"><i>${ico.chat}</i><span>Give your patients a report they <b>understand</b> —<br>and your doctors one they can <b>act on</b>.</span></div>
      <div class="btn">${ico.send}Please DM us</div>
    </div>

    <div class="card facts">
      <div><i>${ico.tag}</i><span><b>₹5 additional</b> per Thyroid Profile I, billed with the order.</span></div>
      <div><i>${ico.cal}</i><span>Live on <b>Infinity</b> reports from <b>27 September 2026</b>.</span></div>
      <div><i>${ico.clock}</i><span>Want it on <b>another profile</b>? Tell us which one.</span></div>
    </div>
  </div>

  <div class="foot">
    <div class="c"><span>${ico.globe} noble-diagnostic.com</span><span>${ico.mail} admin@noblediagnostic.com</span><span>${ico.phone} 8595710338</span></div>
    <div class="s script">Together<br>for Better Health</div>
  </div>
</div></body></html>`;
fs.writeFileSync(D + 'poster.html', html);
console.log('poster.html', Math.round(html.length / 1024), 'KB');
