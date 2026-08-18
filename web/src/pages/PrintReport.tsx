import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import nobleLogo from '../assets/noble-logo.png';
import { notesForCodes } from '../lib/reportNotes';
import {
  ageLabel, fmtStamp, formatRange, genderLabel, splitInterp,
} from '../lib/reportFormat';
import {
  buildSampleReport,
  type CultureReport, type ReportBlock,
  type ReportGroup, type ReportItem, type ReportPanel, type ReportRow,
} from '../lib/reportModel';
import type { FullRow } from './ReportViewer';
import '../report.css';

/**
 * The printed report — and the PDF, and the preview.
 *
 * This route IS the PDF. The render service points headless Chromium at it and
 * composites the result onto the Noble letterhead, which is why the layout
 * lives here in markup and CSS rather than being composed a second time in C#:
 * one description of what a report looks like, and the thing on screen is the
 * thing that prints. It is also what the Reporting tab previews, so what an
 * operator approves is the render they are about to download.
 *
 * ── WHY IT IS SHAPED LIKE THIS ────────────────────────────────────────────
 * Noble issues the same report from Telo and from Infinity, and the two get
 * compared side by side on a desk. So this is a port of Telo's LabReport
 * (components/reporting/tsh-report.tsx) down to the geometry — see report.css
 * on why the numbers in it are not round.
 *
 * Two structural tricks carry most of that, and neither is decoration:
 *
 *   • ONE TABLE PER SECTION. The patient block sits in <thead>, so it repeats
 *     at the top of every page a section spans — a continuation sheet that does
 *     not name its patient is a loose page in a pile of loose pages.
 *
 *   • THE FOOTER IS DRAWN TWICE. A <tfoot> repeats on every page but bottoms
 *     out just under the last row, so on a short page it floats up the middle.
 *     The <tfoot> copy here is INVISIBLE and exists only to reserve the
 *     footer's exact height on every page, so flowing rows can never run under
 *     it; the visible copy is `position: fixed; bottom: 0`, which Chromium
 *     paints at the content-box bottom of every printed page.
 *
 * `data-print-ready` is the contract with the renderer. Chromium's networkidle
 * can settle while the SPA is still showing its own loading state, and the PDF
 * would then be a picture of a spinner — so the renderer waits for this
 * attribute, and it is only ever set once the data is in hand.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 * `?pdf=1`      the renderer. No tick boxes, no letterhead placeholder, and
 *               unticked rows are gone rather than dimmed.
 * `?headless=1` preview of what prints onto pre-printed letterhead paper: the
 *               band is blanked but keeps its space, so the preview paginates
 *               exactly like the PDF. Ignored under ?pdf=1, where the render
 *               service drops the background itself.
 * `?split=1`    a section per page. On screen that is drawn as separate sheets
 *               on a grey desk, because screen media has no page breaks to see.
 * `?t=…`        the patient's own copy, opened from the QR. No session, so the
 *               data comes from the public route the token opens.
 * default       the in-app preview: tickable, with the band drawn.
 */

/* ------------------------------------------------------------------ keys -- */

/**
 * Exclusion is keyed on the RESULT ID, not on a position in the tree.
 *
 * Telo uses positional keys ("deptIndex:itemIndex:childIndex") because its
 * render is server-side and the tree is rebuilt identically on both ends. Here
 * the ids travel to the API in `?exclude=`, are filtered to integers there, and
 * come back into this route — so a stable id is both simpler and safer than a
 * path that changes meaning if the tree is rebuilt differently.
 */
/**
 * Is this MRNID a REAL passport or aadhaar, worth printing under that label?
 *
 * A passport is alphanumeric (it has a letter); an aadhaar is exactly twelve
 * digits. Everything else the LIS keeps in this column is not one: the own
 * patient-id the order form backfills when nothing was entered, and a stray
 * few short numeric ids that resemble another patient's. The API already drops
 * the own-id case; this drops the rest, so a "Passport / Aadhaar" line only
 * ever appears when there is genuinely one to show.
 */
function genuineTravelId(v: string | null | undefined): boolean {
  const t = (v ?? '').trim();
  if (!t) return false;
  return /[A-Za-z]/.test(t) || /^\d{12}$/.test(t);
}

function parseExcluded(raw: string | null): Set<number> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  );
}

/* ------------------------------------------------------------- the route -- */

export function PrintReport() {
  const { sid = '' } = useParams();
  const [params] = useSearchParams();
  const [row, setRow] = useState<FullRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pdfMode = params.get('pdf') === '1';
  const token = params.get('t');

  /* Frozen at mount rather than read at each use: the sheet states its own
     print time twice, and a re-render between them would disagree with itself
     on a document someone signs. */
  const [printedAt] = useState(() => new Date().toISOString());

  const [split, setSplit] = useState(params.get('split') === '1');
  const [headless, setHeadless] = useState(params.get('headless') === '1');
  const [excluded, setExcluded] = useState<Set<number>>(() => parseExcluded(params.get('exclude')));

  useEffect(() => {
    let live = true;
    // With a token there is no session to authenticate with, so the request
    // goes to the route the token opens. The token is the whole credential —
    // see PublicReportEndpoints for what it does and does not permit.
    const url = token
      ? `/api/public/reports/${encodeURIComponent(sid)}?t=${encodeURIComponent(token)}`
      : `/api/reports/${encodeURIComponent(sid)}`;
    api.get<FullRow>(url)
      .then((r) => { if (live) setRow(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this report.'); });
    return () => { live = false; };
  }, [sid, token]);

  // Departments → panels → groups → rows, in the order the LIS wrote them.
  const report = useMemo(() => buildSampleReport(row?.results ?? []), [row]);

  const interactive = !pdfMode;

  const toggle = useCallback((id: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /** Every selectable leaf on the report, and how many survive the ticks. */
  const counts = useMemo(() => {
    let total = 0, remaining = 0;
    const off = (id: number, parentOff: boolean) => parentOff || excluded.has(id);

    for (const dept of report.departments) {
      for (const item of dept.items) {
        if (item.kind === 'panel' && item.panel) {
          const panelOff = excluded.has(item.panel.resultId);
          for (const child of item.panel.children) {
            if (child.kind === 'group' && child.group) {
              const groupOff = off(child.group.resultId, panelOff);
              for (const r of child.group.rows) {
                total++;
                if (!off(r.resultId, groupOff)) remaining++;
              }
            } else if (child.row) {
              total++;
              if (!off(child.row.resultId, panelOff)) remaining++;
            }
          }
        } else if (item.kind === 'group' && item.group) {
          const groupOff = excluded.has(item.group.resultId);
          if (item.group.culture) {
            // A Culture & Sensitivity report is one selectable unit, not one
            // per antibiotic.
            total++;
            if (!groupOff) remaining++;
          } else {
            for (const r of item.group.rows) {
              total++;
              if (!off(r.resultId, groupOff)) remaining++;
            }
          }
        } else if (item.row) {
          total++;
          if (!excluded.has(item.row.resultId)) remaining++;
        }
      }
    }
    return { total, remaining };
  }, [report, excluded]);

  /*
   * The contract with the renderer, and the last line of defence on the rule
   * that no report is issued unsigned.
   *
   * It used to be "row OR error", which meant a FAILED load still announced
   * itself as ready to print — and the renderer would have photographed the
   * error message and handed back a PDF of it. It now goes true only for a
   * report that loaded AND carries a signature; anything else leaves the
   * renderer waiting until it times out, which is a loud failure rather than a
   * document that should not exist.
   *
   * In practice the API refuses first (see ReportSignoff), so a render is never
   * started for an unsigned report. This is what makes that a second lock
   * rather than the only one.
   */
  const signed = (row?.signers ?? []).some((sg) => !!sg.signatureDataUrl);
  const ready = row !== null && signed;

  /* ---- the preview conversation ------------------------------------------
     Same-origin only, both ways. A report is patient data and the frame must
     not take instructions from, or announce its contents to, another origin. */

  useEffect(() => {
    if (pdfMode) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.type !== 'infinity:report-display' || d.sid !== sid) return;
      if (typeof d.split === 'boolean') setSplit(d.split);
      if (typeof d.headless === 'boolean') setHeadless(d.headless);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pdfMode, sid]);

  useEffect(() => {
    if (pdfMode || !ready || window.parent === window) return;
    window.parent.postMessage({
      type: 'infinity:report-selection',
      sid,
      excluded: [...excluded],
      total: counts.total,
      remaining: counts.remaining,
    }, window.location.origin);
  }, [pdfMode, ready, sid, excluded, counts.total, counts.remaining]);

  /* ---- sections ----------------------------------------------------------
     A profile is its own section, and so is a standalone test that carries its
     OWN commentary — Vitamin D, Vitamin B12, anything with a long clinical
     note. Only the bare standalones (T3, T4 …) run together.

     That is not only about reading order. A section taller than one page
     fragments the reserved-footer layout and can push its whole table onto the
     next sheet, which is where the blank-page artefact came from. */

  type Entry = { item: ReportItem; key: number };
  type Section = { deptName: string; deptStart: boolean; entries: Entry[] };

  const sections = useMemo<Section[]>(() => {
    const keyOf = (item: ReportItem): number =>
      item.panel?.resultId ?? item.group?.resultId ?? item.row?.resultId ?? -1;

    const hasOwnContent = (item: ReportItem): boolean => {
      if (item.kind === 'single') {
        return !!item.interpretation
          || !!item.interpretationImage
          || notesForCodes([item.row?.code]).length > 0;
      }
      if (item.kind === 'group' && item.group) {
        return !!item.group.interpretation
          || !!item.group.interpretationImage
          || notesForCodes(item.group.rows.map((r) => r.code)).length > 0;
      }
      return false;
    };

    /** Under the renderer an item with nothing ticked under it is not there. */
    const survives = (item: ReportItem): boolean => {
      if (interactive) return true;
      const key = keyOf(item);
      if (excluded.has(key)) return false;
      if (item.kind === 'panel' && item.panel) {
        return item.panel.children.some((child) => {
          if (child.kind === 'group' && child.group) {
            if (excluded.has(child.group.resultId)) return false;
            return child.group.rows.some((r) => !excluded.has(r.resultId));
          }
          return child.row != null && !excluded.has(child.row.resultId);
        });
      }
      if (item.kind === 'group' && item.group) {
        if (item.group.culture) return true;
        return item.group.rows.some((r) => !excluded.has(r.resultId));
      }
      return true;
    };

    const out: Section[] = [];
    for (const dept of report.departments) {
      const entries = dept.items
        .filter(survives)
        .map((item) => ({ item, key: keyOf(item) }));
      if (entries.length === 0) continue;

      let firstInDept = true;
      let run: Section | null = null;
      for (const entry of entries) {
        if (entry.item.kind === 'panel' || hasOwnContent(entry.item)) {
          out.push({ deptName: dept.name, deptStart: firstInDept, entries: [entry] });
          run = null;
        } else {
          if (!run) {
            run = { deptName: dept.name, deptStart: firstInDept, entries: [] };
            out.push(run);
          }
          run.entries.push(entry);
        }
        firstInDept = false;
      }
    }
    return out;
  }, [report, interactive, excluded]);

  /* ---- render ------------------------------------------------------------ */

  const profileInterpretations = row?.profileInterpretations;

  const renderItem = ({ item, key }: Entry): ReactNode => {
    if (item.kind === 'panel' && item.panel) {
      return (
        <PanelBlock
          key={key}
          panel={item.panel}
          interactive={interactive}
          excluded={excluded}
          onToggle={toggle}
          pdf={pdfMode}
          interpretation={
            item.panel.profileId != null
              ? (profileInterpretations?.[item.panel.profileId] ?? null)
              : null
          }
        />
      );
    }
    if (item.kind === 'group' && item.group) {
      return (
        <GroupBlock
          key={key}
          group={item.group}
          interactive={interactive}
          excluded={excluded}
          groupOff={excluded.has(item.group.resultId)}
          onToggle={toggle}
          pdf={pdfMode}
        />
      );
    }
    if (item.row) {
      return (
        <SingleBlock
          key={key}
          row={item.row}
          interpretation={item.interpretation ?? null}
          interpretationImage={item.interpretationImage ?? null}
          interactive={interactive}
          excluded={excluded.has(item.row.resultId)}
          onToggle={() => toggle(item.row!.resultId)}
        />
      );
    }
    return null;
  };

  // Screen media has no pages, so in split preview each section is drawn as its
  // own sheet. The PDF is a separate ?pdf=1 render and none of this reaches it.
  const previewSheets = !pdfMode && split;
  const ghostFooter = pdfMode || previewSheets;

  const footer = row ? <ReportFooterBlock row={row} printedAt={printedAt} /> : null;

  const tfoot = (
    <tfoot>
      <tr>
        <td colSpan={5} className="lr__foot-cell">
          <div className={ghostFooter ? 'lr__ghost' : undefined}>{footer}</div>
        </td>
      </tr>
    </tfoot>
  );

  const sectionTable = (sec: Section, last: boolean) => (
    <table className="lr__table">
      <ReportColgroup />
      <thead>
        <tr>
          <td colSpan={5} className="lr__head-cell">
            <PatientMetaBlock
              row={row!}
              specimens={report.specimens}
              printedAt={printedAt}
              interactive={interactive}
              totalLeaves={counts.total}
            />
          </td>
        </tr>
        <ColumnHeaderRow />
      </thead>
      {tfoot}
      <tbody>
        <tr>
          <td colSpan={5} className="lr__dept">{sec.deptName}</td>
        </tr>
        {sec.entries.map(renderItem)}
        {last && <EndOfReport />}
      </tbody>
    </table>
  );

  const shell = pdfMode ? 'lr' : previewSheets ? 'lr lr--sheets' : 'lr lr--screen';

  return (
    <div className={shell} data-print-ready={ready ? 'true' : 'false'}>
      {error ? <p className="lr__error">{error}</p> : !row ? null : !signed ? (
        <p className="lr__error">
          This report has no signatory and cannot be issued. No doctor is
          configured to sign for its processing unit, and its departments have
          no default signatory either.
        </p>
      ) : (
        <>
          {/* The letterhead band, preview only. In split preview it is drawn on
              each sheet instead, so the once-at-top copy is skipped. */}
          {!pdfMode && !previewSheets && (
            headless
              ? <LetterheadZone />
              : (
                <div className="lr__brand">
                  <img src={nobleLogo} alt="Noble Diagnostic Centre" />
                </div>
              )
          )}

          {sections.length === 0 ? (
            <p className="lr__empty">No results available for this sample.</p>
          ) : split ? (
            sections.map((sec, si) => {
              const table = sectionTable(sec, si === sections.length - 1);

              if (!previewSheets) {
                return (
                  <div key={si} className="lr__section">{table}</div>
                );
              }

              return (
                <div key={si} className="lr__sheet">
                  <span className="lr__sheet-no">Page {si + 1} of {sections.length}</span>
                  {headless
                    ? <LetterheadZone sheet />
                    : (
                      <div className="lr__brand lr__brand--sheet">
                        <img src={nobleLogo} alt="Noble Diagnostic Centre" />
                      </div>
                    )}
                  {table}
                  {/* The <tfoot> above is an invisible spacer; this is the
                      visible copy, pinned to the bottom of the sheet. */}
                  <div className="lr__sheet-foot">{footer}</div>
                </div>
              );
            })
          ) : (
            /* CONTINUOUS: one table. The patient block and the column headers
               repeat at the top of each page, rows flow, and the department
               band shows once per department. */
            <table className="lr__table">
              <ReportColgroup />
              <thead>
                <tr>
                  <td colSpan={5} className="lr__head-cell">
                    <PatientMetaBlock
                      row={row}
                      specimens={report.specimens}
                      printedAt={printedAt}
                      interactive={interactive}
                      totalLeaves={counts.total}
                    />
                  </td>
                </tr>
                <ColumnHeaderRow />
              </thead>
              {tfoot}
              <tbody>
                {sections.map((sec, si) => (
                  <Fragment key={si}>
                    {sec.deptStart && (
                      <tr>
                        <td colSpan={5} className="lr__dept">{sec.deptName}</td>
                      </tr>
                    )}
                    {sec.entries.map(renderItem)}
                  </Fragment>
                ))}
                <EndOfReport />
              </tbody>
            </table>
          )}

          {pdfMode && counts.total > 0 && counts.remaining === 0 && (
            <p className="lr__error">No tests were selected for this report.</p>
          )}

          {/* The one VISIBLE footer under the renderer, painted at the bottom of
              every printed page. Chromium positions a fixed element against the
              @page CONTENT AREA — inside the 14mm sides and the 34mm foot — so
              `left:0; right:0` already spans the report's exact width. A side
              inset here would double-count the page margins. The <tfoot> ghost
              above reserves this block's height so nothing flows under it. */}
          {pdfMode && sections.length > 0 && (
            <div className="lr__foot-fixed">{footer}</div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- fragments -- */

/** Blank stand-in for the letterhead band in letterhead-paper preview mode.
 *  Reserves the space the logo would take and says what the space is for, so
 *  the preview mirrors the headless PDF. */
function LetterheadZone({ sheet }: { sheet?: boolean }) {
  return (
    <div className={sheet ? 'lr__zone lr__zone--sheet' : 'lr__zone'} aria-hidden>
      <span>Pre-printed letterhead area</span>
    </div>
  );
}

/** The five-column layout, shared by every section's table. */
function ReportColgroup() {
  return (
    <colgroup>
      <col /><col /><col /><col /><col />
    </colgroup>
  );
}

/** Repeats at the top of every page: a continuation sheet whose columns are
 *  unlabelled is a table you have to page back to read. */
function ColumnHeaderRow() {
  return (
    <tr className="lr__cols">
      <th>Test Name</th>
      <th>Value</th>
      <th>Unit</th>
      <th>Biological Ref Interval</th>
      <th>Method</th>
    </tr>
  );
}

function EndOfReport() {
  return (
    <tr>
      <td colSpan={5} className="lr__end">*** End of Report ***</td>
    </tr>
  );
}

function Meta({
  label, value, strong, mono,
}: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  const cls = [strong ? 'lr__f-strong' : '', mono ? 'lr__f-mono' : ''].filter(Boolean).join(' ');
  return (
    <div className="lr__f">
      <span className="lr__f-label">{label}</span>
      <span className="lr__f-sep">:</span>
      <span className={cls || undefined}>{value}</span>
    </div>
  );
}

/** Demographics, "Collected at" and the clinical history — one header block,
 *  closed by a single rule that marks where the header ends. */
function PatientMetaBlock({
  row, specimens, printedAt, interactive, totalLeaves,
}: {
  row: FullRow;
  specimens: string[];
  printedAt: string;
  interactive: boolean;
  totalLeaves: number;
}) {
  const cc = row.collectedAt;
  const ccAddress = cc ? [cc.address, cc.city].filter(Boolean).join(', ') : '';

  return (
    <>
      <div className="lr__meta">
        <div className="lr__grid">
          <Meta label="Name" value={row.patientName ?? '—'} strong />
          <Meta label="Age / Gender" value={`${ageLabel(row.age, row.ageUnit)} / ${genderLabel(row.sex)}`} />
          <Meta label="SID" value={row.sid} mono strong />
          <Meta label="Patient Id" value={String(row.pid)} mono />
          {/* The CODE, not the centre's full name: the name is already spelled
              out under "Collected at", and repeating it here costs a line the
              header cannot spare. */}
          <Meta label="Ref. Customer" value={row.clientCode ?? '—'} />
          <Meta label="Ref. Doctor" value={row.refDoctor ?? 'Self'} />
          {specimens.length > 0 && <Meta label="Specimen" value={specimens.join(', ')} />}
          <Meta label="Collected" value={fmtStamp(row.sampleDrawn)} />
          <Meta label="Registered" value={fmtStamp(row.registeredAt)} />
          <Meta label="Reported" value={fmtStamp(row.lastModifiedAt)} />
          {/* When this SHEET was produced, as distinct from when the result was
              reported. A reissued report is otherwise indistinguishable from
              the original. */}
          <Meta label="Printed" value={fmtStamp(printedAt)} />
          {/* Passport / Aadhaar, placed here so it flows into the right column
              directly under "Reported". Shown only for a GENUINE id — see
              genuineTravelId. The LIS stores this in MRNID, which for the vast
              majority of patients is the own patient-id backfilled by the order
              form (never a passport) or, for a stray few, another patient-id-
              like number; printing either under a "Passport" label would be
              wrong, so the guard keeps the row hidden until a real passport or
              aadhaar is entered. Omitted rather than blanked, like Specimen and
              Bill No. */}
          {genuineTravelId(row.passportNo) && (
            <Meta label="Passport / Aadhaar" value={row.passportNo!.trim()} mono />
          )}
          {row.billNumber && <Meta label="Bill No." value={row.billNumber} mono />}
        </div>

        {cc && (
          <div className="lr__cc">
            <span className="lr__f-label">Collected at</span>
            <span className="lr__f-sep">:</span>
            <span>
              <span className="lr__cc-name">{cc.name ?? cc.code}</span>
              {ccAddress && <>, {ccAddress}</>}
              {(cc.email || cc.phone) && (
                <span className="lr__cc-contact">
                  {' — '}
                  {cc.email ? `Email: ${cc.email}` : ''}
                  {cc.email && cc.phone ? ' · ' : ''}
                  {cc.phone ? `Ph: ${cc.phone}` : ''}
                </span>
              )}
            </span>
          </div>
        )}

        {row.clinicalHistory && (
          <p className="lr__history"><b>Clinical history:</b> {row.clinicalHistory}</p>
        )}
      </div>

      {interactive && totalLeaves > 0 && (
        <p className="lr__tickhint">
          Tick the tests and parameters to include. Unticking a profile or test
          drops everything under it; unticked items are left out of the download
          and the saved PDF.
        </p>
      )}
    </>
  );
}

/** Signatures placed around a centred QR — sig · QR · sig, as the LIS lays them
 *  out — over the processed-at, authentication and NOTE lines. */
function ReportFooterBlock({ row, printedAt }: { row: FullRow; printedAt: string }) {
  const processedAtLine = [
    row.processedAt?.name, row.processedAt?.address, row.processedAt?.city,
  ].filter(Boolean).join(', ');

  const signers = row.signers ?? [];
  const leftCount = Math.floor(signers.length / 2);
  const left = signers.slice(0, leftCount);
  const right = signers.slice(leftCount);

  const Sig = (s: FullRow['signers'][number]) => (
    <div key={s.id} className="lr__sign">
      {s.signatureDataUrl && <img src={s.signatureDataUrl} alt={s.doctorName ?? 'Signature'} />}
      <p className="lr__sign-name">{s.doctorName ?? ''}</p>
      {s.designation && <p className="lr__sign-desig">{s.designation}</p>}
    </div>
  );

  return (
    <>
      {(signers.length > 0 || row.qr) && (
        <div className="lr__signs">
          <div className="lr__signs-left">{left.map(Sig)}</div>
          {row.qr && (
            <div className="lr__qr">
              <img src={row.qr} alt="Scan to download / verify this report" />
              <p>Scan to verify</p>
            </div>
          )}
          <div className="lr__signs-right">{right.map(Sig)}</div>
        </div>
      )}
      <div className="lr__legal">
        {processedAtLine && (
          <p>
            <b>Processed at:</b> {processedAtLine}
            {row.processedAt?.phone ? ` — Ph: ${row.processedAt.phone}` : ''}
          </p>
        )}
        <p>This is an electronically authenticated report. Report printed date: {fmtStamp(printedAt)}</p>
        <p>
          NOTE: Assay results should be correlated clinically with other clinical
          findings and the total clinical status of the patient.
        </p>
      </div>
    </>
  );
}

/** The per-test tick box. Ticked = included in the PDF; never rendered under
 *  `?pdf=1`, so there is no chance of one reaching paper. When a parent is
 *  unticked its children are forced off and disabled. */
function IncludeToggle({
  label, excluded, onToggle, disabled,
}: { label: string; excluded: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      className="lr__tick"
      checked={!excluded}
      disabled={disabled}
      onChange={onToggle}
      title={disabled
        ? 'Re-tick the parent to choose individual items'
        : excluded ? `Include ${label} in the PDF` : `Exclude ${label} from the PDF`}
      aria-label={`Include ${label} in the PDF`}
    />
  );
}

/** A profile panel (LIVER FUNCTION TEST): a parent tick box that cascades to
 *  every child block, and the profile's own clinical text printed once beneath
 *  the whole thing rather than under each constituent. */
function PanelBlock({
  panel, interactive, excluded, onToggle, pdf, interpretation,
}: {
  panel: ReportPanel;
  interactive: boolean;
  excluded: Set<number>;
  onToggle: (id: number) => void;
  pdf: boolean;
  interpretation: string | null;
}) {
  const panelOff = excluded.has(panel.resultId);

  const visible = pdf
    ? panel.children.filter((child) => {
        if (panelOff) return false;
        if (child.kind === 'group' && child.group) {
          if (excluded.has(child.group.resultId)) return false;
          if (child.group.culture) return true;
          // A group whose parameters are all unticked vanishes with them.
          return child.group.rows.some((r) => !excluded.has(r.resultId));
        }
        return child.row != null && !excluded.has(child.row.resultId);
      })
    : panel.children;

  if (pdf && visible.length === 0) return null;

  // Static notes still attach to the profile, from the codes actually printed.
  const codes: (string | null)[] = [];
  for (const child of panel.children) {
    if (panelOff) continue;
    if (child.kind === 'group' && child.group) {
      if (excluded.has(child.group.resultId)) continue;
      for (const r of child.group.rows) if (!excluded.has(r.resultId)) codes.push(r.code);
    } else if (child.row && !excluded.has(child.row.resultId)) {
      codes.push(child.row.code);
    }
  }

  return (
    <>
      <tr className={`lr__panel-row${panelOff ? ' lr__off' : ''}`}>
        <td colSpan={5} className="lr__panel-cell">
          <span className="lr__title">
            {interactive && (
              <IncludeToggle
                label={panel.title ?? 'profile'}
                excluded={panelOff}
                onToggle={() => onToggle(panel.resultId)}
              />
            )}
            <span className="lr__title-text lr__title-text--panel">{panel.title ?? ''}</span>
          </span>
        </td>
      </tr>
      {visible.map((child) => renderChild(child, { interactive, excluded, panelOff, pdf, onToggle }))}
      {interpretation && <InterpretationRow text={interpretation} dim={panelOff} />}
      <NoteRow notes={notesForCodes(codes)} dim={panelOff} />
    </>
  );
}

function renderChild(
  child: ReportBlock,
  ctl: {
    interactive: boolean;
    excluded: Set<number>;
    panelOff: boolean;
    pdf: boolean;
    onToggle: (id: number) => void;
  },
): ReactNode {
  if (child.kind === 'group' && child.group) {
    return (
      <GroupBlock
        key={child.group.resultId}
        group={child.group}
        interactive={ctl.interactive}
        excluded={ctl.excluded}
        groupOff={ctl.panelOff || ctl.excluded.has(child.group.resultId)}
        disabled={ctl.panelOff}
        onToggle={ctl.onToggle}
        pdf={ctl.pdf}
        indent
        // Printed once below the whole profile by PanelBlock.
        hideInterpretation
      />
    );
  }
  if (child.row) {
    return (
      <SingleBlock
        key={child.row.resultId}
        row={child.row}
        interpretation={child.interpretation ?? null}
        interpretationImage={child.interpretationImage ?? null}
        interactive={ctl.interactive}
        excluded={ctl.panelOff || ctl.excluded.has(child.row.resultId)}
        disabled={ctl.panelOff}
        onToggle={() => ctl.onToggle(child.row!.resultId)}
        indent
        hideInterpretation
      />
    );
  }
  return null;
}

/** A multi-parameter group: a bold heading with its own tick box, its member
 *  rows each with theirs, and its interpretation. Unticking the group cascades
 *  to — and disables — its parameters; under the renderer unticked parameters
 *  are dropped and the group vanishes when none survive. */
function GroupBlock({
  group, interactive, excluded, groupOff, onToggle, disabled, pdf, indent, hideInterpretation,
}: {
  group: ReportGroup;
  interactive: boolean;
  excluded: Set<number>;
  groupOff: boolean;
  onToggle: (id: number) => void;
  disabled?: boolean;
  pdf?: boolean;
  indent?: boolean;
  hideInterpretation?: boolean;
}) {
  const heading = (
    <tr className={`lr__group-row${groupOff ? ' lr__off' : ''}`}>
      <td colSpan={5} className={`lr__group-cell${indent ? ' lr__indent' : ''}`}>
        <span className="lr__title">
          {interactive && (
            <IncludeToggle
              label={group.title ?? 'test'}
              excluded={groupOff}
              onToggle={() => onToggle(group.resultId)}
              disabled={disabled}
            />
          )}
          <span className="lr__title-text">{group.title ?? ''}</span>
        </span>
      </td>
    </tr>
  );

  // Culture & Sensitivity is one unit under one tick box: the structured
  // antibiogram rather than a run of parameter rows.
  if (group.culture) {
    if (pdf && groupOff) return null;
    return (
      <>
        {heading}
        <CultureBlock culture={group.culture} dim={groupOff} indent={indent} />
      </>
    );
  }

  const rowOff = (r: ReportRow) => groupOff || excluded.has(r.resultId);
  const visible = pdf ? group.rows.filter((r) => !rowOff(r)) : group.rows;
  if (pdf && visible.length === 0) return null;

  const includedCodes = group.rows.filter((r) => !rowOff(r)).map((r) => r.code);

  return (
    <>
      {heading}
      {visible.map((r) => (
        <ResultRow
          key={r.resultId}
          row={r}
          dim={rowOff(r)}
          indent={indent}
          lead={interactive ? (
            <IncludeToggle
              label={r.name ?? 'parameter'}
              excluded={rowOff(r)}
              onToggle={() => onToggle(r.resultId)}
              disabled={groupOff}
            />
          ) : undefined}
        />
      ))}
      {!hideInterpretation && group.interpretation && (
        <InterpretationRow text={group.interpretation} dim={groupOff} />
      )}
      {!hideInterpretation && group.interpretationImage && (
        <InterpretationImageRow src={group.interpretationImage} dim={groupOff} />
      )}
      {!hideInterpretation && <NoteRow notes={notesForCodes(includedCodes)} dim={groupOff} />}
    </>
  );
}

/** A standalone test row and its own interpretation. */
function SingleBlock({
  row, interpretation, interpretationImage, interactive, excluded, onToggle,
  disabled, indent, hideInterpretation,
}: {
  row: ReportRow;
  interpretation: string | null;
  interpretationImage: string | null;
  interactive: boolean;
  excluded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  indent?: boolean;
  hideInterpretation?: boolean;
}) {
  return (
    <>
      <ResultRow
        row={row}
        dim={excluded}
        indent={indent}
        lead={interactive ? (
          <IncludeToggle
            label={row.name ?? 'test'}
            excluded={excluded}
            onToggle={onToggle}
            disabled={disabled}
          />
        ) : undefined}
      />
      {!hideInterpretation && interpretation && (
        <InterpretationRow text={interpretation} dim={excluded} />
      )}
      {!hideInterpretation && interpretationImage && (
        <InterpretationImageRow src={interpretationImage} dim={excluded} />
      )}
      {!hideInterpretation && <NoteRow notes={notesForCodes([row.code])} dim={excluded} />}
    </>
  );
}

function ResultRow({
  row, dim, lead, indent,
}: { row: ReportRow; dim?: boolean; lead?: ReactNode; indent?: boolean }) {
  const off = dim ? ' lr__off' : '';
  return (
    <>
      <tr className={`lr__row${off}`}>
        <td className={`lr__c-name${indent ? ' lr__indent' : ''}`}>
          <div className="lr__c-name-inner">
            {lead}
            <div className="lr__c-name-text">{row.name ?? '—'}</div>
          </div>
        </td>
        <td className="lr__c-value">
          <span className={row.abnormal ? 'lr__abnormal' : undefined}>{row.value ?? '—'}</span>
        </td>
        <td className="lr__c-unit">{row.unit ?? '—'}</td>
        <td className="lr__c-range"><RangeCell range={row.range} /></td>
        <td className="lr__c-method">{row.method ?? '—'}</td>
      </tr>
      {row.comments && (
        <tr className={`lr__note-row${off}`}>
          <td colSpan={5}>
            <b>Doctor&apos;s Note:</b> <b>{row.comments}</b>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The biological reference interval.
 *
 * A gestational "Weeks Range" — a header line followed by one
 * "&lt;week&gt; &lt;low&gt;-&lt;high&gt;" per week — is set as three aligned
 * columns so the numbers line up instead of running together as ragged text.
 * Everything else falls back to one band per line.
 */
function RangeCell({ range }: { range: string | null }) {
  const text = formatRange(range);
  if (text === '—') return <>—</>;

  const lines = text.split('\n');
  const dataLine = /^(\d{1,2})\s+(.+)$/;
  const header = lines[0] && !dataLine.test(lines[0]) ? lines[0] : null;
  const body = header ? lines.slice(1) : lines;
  const weeks = body.map((l) => {
    const m = l.match(dataLine);
    if (!m) return null;
    const band = m[2].trim();
    const parts = band.match(/^([0-9.]+)\s*-\s*([0-9.]+)$/);
    return { week: m[1], lo: parts ? parts[1] : band, hi: parts ? parts[2] : null };
  });

  const isWeeks = !!header && /week/i.test(header) && weeks.length >= 2 && weeks.every(Boolean);
  if (!isWeeks) return <span className="lr__pre">{text}</span>;

  return (
    <div className="lr__weeks">
      <p className="lr__weeks-title">{header}</p>
      <div className="lr__weeks-grid">
        {(weeks as { week: string; lo: string; hi: string | null }[]).map((w, i) => (
          <Fragment key={i}>
            <span className="lr__weeks-no">{w.week}</span>
            <span className="lr__weeks-lo">{w.lo}</span>
            <span className="lr__weeks-hi">{w.hi != null ? `– ${w.hi}` : ''}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function InterpretationRow({ text, dim }: { text: string; dim?: boolean }) {
  const { heading, body } = splitInterp(text);
  return (
    <tr className={dim ? 'lr__off' : undefined}>
      <td colSpan={5} className="lr__interp-cell">
        <div className="lr__interp">
          <h3>{heading}</h3>
          <p>{body}</p>
        </div>
      </td>
    </tr>
  );
}

/** An interpretation stored as a picture — the HBV / HCV graphs. Some tests
 *  carry ONLY this and no text; it prints below any text there is. */
function InterpretationImageRow({ src, dim }: { src: string; dim?: boolean }) {
  return (
    <tr className={dim ? 'lr__off' : undefined}>
      <td colSpan={5} className="lr__interp-cell">
        <div className="lr__interp-img">
          <img src={src} alt="Interpretation" />
        </div>
      </td>
    </tr>
  );
}

/** A test's static notes, printed at the end of ITS section and never split
 *  across a page. */
function NoteRow({ notes, dim }: { notes: string[]; dim?: boolean }) {
  if (notes.length === 0) return null;
  return (
    <tr className={dim ? 'lr__off' : undefined}>
      <td colSpan={5} className="lr__notes-cell">
        <div className="lr__notes">
          <p>Note</p>
          <ol>{notes.map((n, i) => <li key={i}>{n}</li>)}</ol>
        </div>
      </td>
    </tr>
  );
}

/**
 * A Culture & Sensitivity result: the gram-stain / organism / colony-count
 * lines, the interim and final narratives above them, any remarks, and the
 * ANTIBIOGRAM as three columns — Sensitive, Intermediate, Resistant.
 *
 * A "no growth" report carries "NOT APPLICABLE" in every field and prints as
 * an empty column rather than as the words.
 */
function CultureBlock({
  culture, dim, indent,
}: { culture: CultureReport; dim?: boolean; indent?: boolean }) {
  const header: Array<[string, string | null]> = [
    ['Gram Stained Smear', culture.gramStain],
    ['Organism Isolated', culture.organism],
    ['Colony Count', culture.colonyCount],
  ];
  const cols = [
    { title: 'Sensitive', items: culture.sensitive, head: '#f7dcdc', body: '#fdf5f5', border: '#edc6c6', text: '#9f1239', dot: '#e11d48' },
    { title: 'Intermediate', items: culture.intermediate, head: '#e9ecf1', body: '#fafbfc', border: '#d6dbe3', text: '#475569', dot: '#94a3b8' },
    { title: 'Resistant', items: culture.resistant, head: '#d7ecda', body: '#f5faf5', border: '#bfe0c5', text: '#15803d', dot: '#16a34a' },
  ];
  const isNA = (s: string) => /^\s*not applicable\s*$/i.test(s);
  const hasAbx = cols.some((c) => c.items.length > 0);

  return (
    <tr className={dim ? 'lr__off' : undefined}>
      <td colSpan={5} className={`lr__culture-cell${indent ? ' lr__indent' : ''}`}>
        <div className="lr__culture">
          <table className="lr__culture-head">
            <tbody>
              {/* The interim and final reads, above the organism and the
                  antibiogram, matching the LIS's own layout. */}
              {culture.narratives.map((n) => (
                <tr key={n.label}>
                  <td>{n.label}</td>
                  <td>:</td>
                  <td className="lr__culture-pre">{n.value}</td>
                </tr>
              ))}
              {header.map(([label, value]) => value ? (
                <tr key={label}>
                  <td>{label}</td>
                  <td>:</td>
                  <td>{value}</td>
                </tr>
              ) : null)}
              {culture.remarks && (
                <tr className="lr__culture-remarks">
                  <td>Remarks</td>
                  <td>:</td>
                  <td>{culture.remarks}</td>
                </tr>
              )}
            </tbody>
          </table>

          {hasAbx && (
            <div className="lr__abx">
              <div className="lr__abx-title">
                <span /><b>Antibiogram</b><span />
              </div>
              <div className="lr__abx-cols">
                {cols.map((c) => {
                  const drugs = c.items.filter((it) => !isNA(it));
                  return (
                    <div key={c.title} className="lr__abx-col" style={{ borderColor: c.border }}>
                      <div className="lr__abx-cap" style={{ backgroundColor: c.head }}>
                        <span style={{ color: c.text }}>{c.title}</span>
                        {drugs.length > 0 && (
                          <span className="lr__abx-count" style={{ color: c.text }}>{drugs.length}</span>
                        )}
                      </div>
                      <div className="lr__abx-body" style={{ backgroundColor: c.body }}>
                        {drugs.length > 0 ? (
                          <ul>
                            {drugs.map((it, i) => (
                              <li key={i}>
                                <span className="lr__abx-dot" style={{ backgroundColor: c.dot }} />
                                <span>{it}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="lr__abx-none">Not applicable</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
