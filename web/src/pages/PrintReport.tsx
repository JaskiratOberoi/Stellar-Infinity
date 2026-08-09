import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtDateTime, plainText } from '../lib/format';
import { notesForCodes } from '../lib/reportNotes';
import type { FullRow, TestResult } from './ReportViewer';

/**
 * The printed report — and the PDF, and the preview.
 *
 * This route IS the PDF. The render service points headless Chromium at it and
 * composites the result onto the Noble letterhead, which is why the report's
 * layout lives here in CSS rather than being composed a second time in C#: one
 * description of what a report looks like, and the thing on screen is the thing
 * that prints. It is also what the Reporting tab previews, so what an operator
 * approves is the render they are about to download.
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
 * ── MODES ─────────────────────────────────────────────────────────────────
 * `?pdf=1`      the renderer. No tick boxes, no letterhead placeholder, and
 *               unticked rows are gone rather than dimmed.
 * `?headless=1` preview of what prints onto pre-printed letterhead paper: the
 *               band is blanked but keeps its space, so the preview paginates
 *               exactly like the PDF. Ignored under ?pdf=1, where the render
 *               service drops the background itself.
 * `?t=…`        the patient's own copy, opened from the QR. No session, so the
 *               data comes from the public route the token opens.
 * default       the in-app preview: tickable, with the band drawn.
 */

/** Head and Profile rows are the report's own section headings, not analytes. */
const isHeading = (t: TestResult) => t.testType === 'Head' || t.testType === 'Profile';

/** The catalogue's display name wins; the result row's name is the fallback. */
const nameOf = (t: TestResult) =>
  plainText(t.reportTestName) || plainText(t.testName) || t.testCode || '—';

/**
 * A heading and the analytes it introduces.
 *
 * profile_id is the real parent link and is used when both rows carry one. It
 * is absent on about a sixth of the result rows, and on those the LIS's own
 * ordering is the only structure there is: a Head/Profile row owns every
 * analyte after it until the next heading. Both paths matter — the id is
 * correct when a profile's rows are not contiguous, and the order is all there
 * is when the id was never written.
 */
interface Group { heading: TestResult | null; items: TestResult[] }

function groupResults(results: TestResult[]): Group[] {
  const groups: Group[] = [];
  const byProfile = new Map<number, Group>();
  let current: Group | null = null;

  for (const r of results) {
    if (isHeading(r)) {
      current = { heading: r, items: [] };
      groups.push(current);
      // A heading's own id is what its members point at.
      const key = r.profileId ?? r.resultId;
      byProfile.set(key, current);
      continue;
    }

    // Claimed by its stated parent when there is one and we have seen it.
    const owner = r.profileId != null ? byProfile.get(r.profileId) : undefined;
    if (owner) { owner.items.push(r); continue; }

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
  const token = params.get('t');

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

  const specimens = useMemo(() => {
    const seen = new Set<string>();
    for (const r of row?.results ?? []) {
      const s = r.specimen?.trim();
      if (s) seen.add(s);
    }
    return [...seen];
  }, [row]);

  // Only for what is actually being printed: unticking the one test that
  // carried a note should take the note with it.
  const notes = useMemo(() => notesForCodes(
    (row?.results ?? [])
      .filter((t) => !isHeading(t) && !excluded.has(t.resultId))
      .map((t) => t.testCode),
  ), [row, excluded]);

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
  const cols = tickable ? 6 : 5;

  return (
    <div className={`print${split ? ' print--split' : ''}${headless && !pdfMode ? ' print--headless' : ''}`}
         data-print-ready={ready ? 'true' : 'false'}>
      {error ? (
        <p className="print__error">{error}</p>
      ) : !row ? null : (
        <>
          {!pdfMode && <div className="print__letterhead">Pre-printed letterhead area</div>}

          {/* Two columns of label/value, as the LIS prints it. The QR sits to
              the right of both, where it survives being folded. */}
          <header className="print__head">
            <dl className="print__meta">
              <div><dt>Name</dt><dd className="print__name">{row.patientName ?? 'Unnamed patient'}</dd></div>
              <div><dt>SID</dt><dd className="mono">{row.sid}</dd></div>
              {row.refCustomer && <div><dt>Ref. Customer</dt><dd>{plainText(row.refCustomer)}</dd></div>}
              {specimens.length > 0 && <div><dt>Specimen</dt><dd>{specimens.join(', ')}</dd></div>}
              <div><dt>Registered</dt><dd>{fmtDateTime(row.registeredAt)}</dd></div>
              {row.collectedAt?.name && (
                <div className="print__meta--wide">
                  <dt>Collected at</dt>
                  <dd>
                    {plainText(row.collectedAt.name)}
                    {row.collectedAt.address && <>, {plainText(row.collectedAt.address)}</>}
                    {row.collectedAt.email && <> · {row.collectedAt.email}</>}
                    {row.collectedAt.phone && <> · Ph: {row.collectedAt.phone}</>}
                  </dd>
                </div>
              )}
            </dl>

            <dl className="print__meta">
              <div>
                <dt>Age / Gender</dt>
                <dd>{[row.age != null ? `${row.age} ${row.ageUnit ?? ''}`.trim() : null, row.sex]
                      .filter(Boolean).join(' / ') || '—'}</dd>
              </div>
              <div><dt>Patient Id</dt><dd className="mono">{row.pid}</dd></div>
              <div><dt>Ref. Doctor</dt><dd>{plainText(row.refDoctor) || 'SELF'}</dd></div>
              {row.passportNo && <div><dt>Passport</dt><dd className="mono">{row.passportNo}</dd></div>}
              <div><dt>Collected</dt><dd>{fmtDateTime(row.sampleDrawn)}</dd></div>
              <div><dt>Reported</dt><dd>{fmtDateTime(row.lastModifiedAt)}</dd></div>
              {row.billNumber ? <div><dt>Bill</dt><dd className="mono">{row.billNumber}</dd></div> : null}
            </dl>

            {row.qr && (
              <div className="print__qr">
                <img src={row.qr} alt="" />
                <span>Scan for your copy</span>
              </div>
            )}
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
            <section key={dept.name} className="print__dept" data-dept-index={di}>
              <h2>{dept.name}</h2>
              <table className="print__table">
                <thead>
                  {/* Repeats on every page: a continuation sheet whose columns
                      are unlabelled is a table you have to scroll back to read. */}
                  <tr>
                    {tickable && <th className="print__tick" aria-label="Include" />}
                    <th>Test Name</th>
                    <th className="print__num">Value</th>
                    <th>Unit</th>
                    <th>Biological Ref Interval</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {dept.groups.map((g) => {
                    const headOff = g.heading != null && excluded.has(g.heading.resultId);
                    // A profile's own clinical text, from Telo's sidecar, keyed
                    // on the heading's profile id.
                    const profileKey = g.heading?.profileId ?? g.heading?.resultId;
                    const profileInterp = profileKey != null
                      ? row.profileInterpretations?.[profileKey] : undefined;
                    // A standalone test carries its own from the catalogue.
                    const ownInterp = g.heading == null && g.items.length === 1
                      ? g.items[0].interpretation : g.heading?.interpretation;
                    const interp = profileInterp || ownInterp;

                    if (headOff && pdfMode) return null;

                    return (
                      <Fragment key={g.heading?.resultId ?? `g${g.items[0]?.resultId ?? di}`}>
                        {g.heading && (
                          <tr className={`print__section${headOff ? ' print__row--off' : ''}`}>
                            {tickable && (
                              <td className="print__tick">
                                <input type="checkbox" checked={!headOff}
                                       aria-label={`Include ${nameOf(g.heading)}`}
                                       onChange={() => toggle(g.heading!.resultId)} />
                              </td>
                            )}
                            <td colSpan={5}>{nameOf(g.heading)}</td>
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
                                         aria-label={`Include ${nameOf(t)}`}
                                         onChange={() => toggle(t.resultId)} />
                                </td>
                              )}
                              <td>
                                {nameOf(t)}
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
                              <td className="print__method">{plainText(t.method)}</td>
                            </tr>
                          );
                        })}

                        {/* Clinical significance, under the profile it belongs
                            to rather than at the end of the report — a doctor
                            reads it against the numbers immediately above. */}
                        {interp && !headOff && (
                          <tr className="print__interp-row">
                            <td colSpan={cols}>
                              <div className="print__interp">
                                <h3>Interpretation</h3>
                                <p>{plainText(interp)}</p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}

          {row.results.length === 0 && <p className="print__error">No results have been entered for this sample.</p>}

          {pdfMode && counts.total > 0 && counts.remaining === 0 && (
            <p className="print__error">No tests were selected for this report.</p>
          )}

          {notes.length > 0 && (
            <section className="print__notes">
              <h3>Note</h3>
              <ol>{notes.map((n) => <li key={n}>{n}</li>)}</ol>
            </section>
          )}

          <footer className="print__foot">
            {/* Signatures first: the disclaimer is boilerplate, and who signed
                the report is the part that makes it a report. */}
            {row.signers && row.signers.length > 0 && (
              <div className="print__signs">
                {row.signers.map((s) => (
                  <div className="print__sign" key={s.id}>
                    {s.signatureDataUrl && <img src={s.signatureDataUrl} alt="" />}
                    <b>{plainText(s.doctorName) || ''}</b>
                    {s.designation && <span>{plainText(s.designation)}</span>}
                  </div>
                ))}
              </div>
            )}

            {row.processedAt?.name && (
              <p className="print__processed">
                Processed at {plainText(row.processedAt.name)}
                {row.processedAt.address && <>, {plainText(row.processedAt.address)}</>}
                {row.processedAt.phone && <> · {row.processedAt.phone}</>}
              </p>
            )}

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
