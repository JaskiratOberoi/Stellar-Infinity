import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtDateTime, plainText } from '../lib/format';
import type { FullRow, TestResult } from './ReportViewer';

/**
 * The printed report — and the PDF, and the preview.
 *
 * This route IS the PDF. The render service points headless Chromium at it and
 * composites the result onto the Noble letterhead, which is why the report's
 * layout lives here in CSS rather than being composed a second time in C#: one
 * description of what a report looks like, and the thing on screen is the thing
 * that prints.
 *
 * It is now also what the Reporting tab previews. The modal used to show a
 * separate summary table built from the same data — a second layout that could
 * disagree with the printed one, and did: it had no page breaks, no letterhead
 * band and no notion of what would actually land on paper. The preview loads
 * THIS route in an iframe instead, so what the operator approves is the render
 * they are about to download. Telo settled on the same arrangement.
 *
 * The page margins are the letterhead's clear area (26mm top, 34mm bottom,
 * 14mm sides). Content outside that band would print over Noble's printed
 * header and footer. See `.print` in styles.css.
 *
 * `data-print-ready` is the contract with the renderer. Chromium's networkidle
 * can settle while the SPA is still showing its own loading state, and the PDF
 * would then be a picture of a spinner — so the renderer waits for this
 * attribute instead, and it is only ever set once the data is in hand.
 *
 * ── THREE MODES, ONE COMPONENT ────────────────────────────────────────────
 * `?pdf=1`   the renderer. No checkboxes, no letterhead placeholder.
 * `?headless=1` preview of what prints onto pre-printed letterhead paper: the
 *            letterhead band is blanked but its space is kept, so the preview
 *            has the same pagination as the PDF. The PDF route drops the
 *            background itself, so this is ignored under ?pdf=1.
 * default    the in-app preview: tickable, with the letterhead band drawn.
 */

/** Head and Profile rows are the report's own section headings, not analytes. */
const isHeading = (t: TestResult) => t.testType === 'Head' || t.testType === 'Profile';

/**
 * A heading and the analytes it introduces.
 *
 * The LIS returns one flat, report-ordered list with headings inline among the
 * readings, so the nesting the printed report shows is implied by position: a
 * Head/Profile row owns every analyte after it until the next heading. That
 * implied structure is what the tick boxes cascade along — unticking a profile
 * has to drop the tests under it, and there is no parent id in the data to ask.
 */
interface Group { heading: TestResult | null; items: TestResult[] }

function groupResults(results: TestResult[]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const r of results) {
    if (isHeading(r)) {
      current = { heading: r, items: [] };
      groups.push(current);
      continue;
    }
    // Analytes before any heading — common on single-test orders — hang off a
    // headless group rather than being dropped.
    if (!current) { current = { heading: null, items: [] }; groups.push(current); }
    current.items.push(r);
  }
  return groups;
}

/** Comma-separated result ids, as the PDF route receives them. */
function parseExcluded(raw: string | null): Set<number> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  );
}

export function PrintReport() {
  const { sid = '' } = useParams();
  const [params] = useSearchParams();
  const [row, setRow] = useState<FullRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pdfMode = params.get('pdf') === '1';

  /*
   * Display options are seeded from the URL and then driven by postMessage.
   *
   * The renderer only ever reads the URL — it loads the route once and
   * photographs it. The preview cannot work that way: changing the URL would
   * remount the iframe, re-boot the SPA and re-fetch the report just to move a
   * page break, which is seconds of blank white for a toggle. So the modal
   * pushes the options in and they are applied here, client-side.
   */
  const [split, setSplit] = useState(params.get('split') === '1');
  const [headless, setHeadless] = useState(params.get('headless') === '1');
  const [excluded, setExcluded] = useState<Set<number>>(() => parseExcluded(params.get('exclude')));

  useEffect(() => {
    let live = true;
    api.get<FullRow>(`/api/reports/${encodeURIComponent(sid)}`)
      .then((r) => { if (live) setRow(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this report.'); });
    return () => { live = false; };
  }, [sid]);

  // Departments in the order the LIS returned them — that order is the printed
  // report's order and operators read it that way.
  const departments = useMemo(() => {
    const groups = new Map<string, TestResult[]>();
    for (const r of row?.results ?? []) {
      const key = r.departmentName?.trim() || 'Results';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.entries()].map(([name, results]) => ({ name, groups: groupResults(results) }));
  }, [row]);

  /** Every analyte on the report, and how many survive the current ticks. */
  const counts = useMemo(() => {
    let total = 0, remaining = 0;
    for (const d of departments) {
      for (const g of d.groups) {
        for (const t of g.items) {
          total++;
          if (!excluded.has(t.resultId) && !(g.heading && excluded.has(g.heading.resultId))) remaining++;
        }
      }
    }
    return { total, remaining };
  }, [departments, excluded]);

  // Ready means "there is something to photograph", and an error counts: a
  // failed render must come back as a one-page PDF saying so, not as a 45s
  // timeout with nothing to show for it.
  const ready = row !== null || error !== null;

  // ---- the preview conversation -------------------------------------------
  // Same-origin only, both ways. A report is patient data and the frame must
  // not take instructions from, or announce its contents to, another origin.

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

  // Announce the selection on load and on every tick, so the modal knows what
  // to exclude from the download and whether anything is left to download.
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

  const toggle = useCallback((id: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const tickable = !pdfMode;

  return (
    <div className={`print${split ? ' print--split' : ''}${headless && !pdfMode ? ' print--headless' : ''}`}
         data-print-ready={ready ? 'true' : 'false'}>
      {error ? (
        <p className="print__error">{error}</p>
      ) : !row ? null : (
        <>
          {/* Where the pre-printed letterhead will be. Drawn in the preview so
              the operator can see what the paper leaves room for; blanked (but
              still occupying its space) under headless, so the preview
              paginates exactly like the PDF. */}
          {!pdfMode && <div className="print__letterhead">Pre-printed letterhead area</div>}

          <header className="print__head">
            <div>
              <h1 className="print__patient">{row.patientName ?? 'Unnamed patient'}</h1>
              <dl className="print__meta">
                <div><dt>SID</dt><dd className="mono">{row.sid}</dd></div>
                {row.pid ? <div><dt>PID</dt><dd className="mono">{row.pid}</dd></div> : null}
                <div>
                  <dt>Age / Sex</dt>
                  <dd>{[row.age != null ? `${row.age} ${row.ageUnit ?? ''}`.trim() : null, row.sex]
                        .filter(Boolean).join(' · ') || '—'}</dd>
                </div>
                {row.clientCode ? <div><dt>Client</dt><dd>{row.clientCode}</dd></div> : null}
              </dl>
            </div>
            <dl className="print__meta print__meta--right">
              <div><dt>Registered</dt><dd>{fmtDateTime(row.registeredAt)}</dd></div>
              <div><dt>Collected</dt><dd>{fmtDateTime(row.sampleDrawn)}</dd></div>
              <div><dt>Reported</dt><dd>{fmtDateTime(row.lastModifiedAt)}</dd></div>
              {row.billNumber ? <div><dt>Bill</dt><dd className="mono">{row.billNumber}</dd></div> : null}
            </dl>
          </header>

          {row.clinicalHistory && (
            <p className="print__history"><b>Clinical history:</b> {plainText(row.clinicalHistory)}</p>
          )}

          {tickable && row.results.length > 0 && (
            <p className="print__tickhint">
              Tick the tests to include. Unticking a profile drops everything under it; unticked
              items are left out of the download.
            </p>
          )}

          {departments.map((dept, di) => (
            /* Split puts each department on its own sheet. The first one must
               not break or the PDF opens on a blank page — see .print--split. */
            <section key={dept.name} className="print__dept" data-dept-index={di}>
              <h2>{dept.name}</h2>
              <table className="print__table">
                <thead>
                  {/* Repeats on every page: a continuation sheet whose columns
                      are unlabelled is a table you have to scroll back to read. */}
                  <tr>
                    {tickable && <th className="print__tick" aria-label="Include" />}
                    <th>Investigation</th>
                    <th className="print__num">Result</th>
                    <th>Unit</th>
                    <th>Biological reference interval</th>
                  </tr>
                </thead>
                <tbody>
                  {dept.groups.map((g) => {
                    const headOff = g.heading != null && excluded.has(g.heading.resultId);
                    return (
                      <Fragment key={g.heading?.resultId ?? `g${g.items[0]?.resultId ?? di}`}>
                        {g.heading && (
                          <tr className={`print__section${headOff ? ' print__row--off' : ''}`}>
                            {tickable && (
                              <td className="print__tick">
                                <input type="checkbox" checked={!headOff} aria-label={`Include ${plainText(g.heading.testName) || g.heading.testCode || 'section'}`}
                                       onChange={() => toggle(g.heading!.resultId)} />
                              </td>
                            )}
                            <td colSpan={4}>{plainText(g.heading.testName) || g.heading.testCode}</td>
                          </tr>
                        )}
                        {g.items.map((t) => {
                          const off = headOff || excluded.has(t.resultId);
                          // Under the renderer an unticked row is simply not
                          // there. In the preview it stays, dimmed, because the
                          // operator has to be able to put it back.
                          if (off && pdfMode) return null;
                          return (
                            <tr key={t.resultId} className={off ? 'print__row--off' : undefined}>
                              {tickable && (
                                <td className="print__tick">
                                  <input type="checkbox" checked={!off} disabled={headOff}
                                         aria-label={`Include ${plainText(t.testName) || t.testCode || 'test'}`}
                                         onChange={() => toggle(t.resultId)} />
                                </td>
                              )}
                              <td>
                                {plainText(t.testName) || t.testCode || '—'}
                                {t.comments && <div className="print__comment">{plainText(t.comments)}</div>}
                              </td>
                              <td className={`print__num mono${t.abnormal ? ' print__num--flag' : ''}`}>
                                {t.value ?? '—'}
                                {/* H/L, not a colour: a report is printed in black on
                                    a mono laser as often as not, and "high" must
                                    survive that. */}
                                {t.abnormal && <span className="print__flag">H/L</span>}
                              </td>
                              <td>{t.unit ?? '—'}</td>
                              <td className="print__range">{plainText(t.normalRange) || '—'}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}

          {row.results.length === 0 && <p className="print__error">No results have been entered for this sample.</p>}

          {/* Everything unticked. Only reachable in the preview — the download
              is blocked before it gets here — but a blank sheet with no
              explanation would look like a broken render. */}
          {pdfMode && counts.total > 0 && counts.remaining === 0 && (
            <p className="print__error">No tests were selected for this report.</p>
          )}

          <footer className="print__foot">
            <p>
              Results relate only to the sample tested. This report is not valid for medico-legal purposes.
              Please correlate clinically.
            </p>
            <p className="print__end">— End of report —</p>
          </footer>
        </>
      )}
    </div>
  );
}
