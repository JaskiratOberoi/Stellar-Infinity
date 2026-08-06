import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtDateTime, plainText } from '../lib/format';
import type { FullRow, TestResult } from './ReportViewer';

/**
 * The printed report — and the PDF.
 *
 * This route IS the PDF. The render service points headless Chromium at it and
 * composites the result onto the Noble letterhead, which is why the report's
 * layout lives here in CSS rather than being composed a second time in C#: one
 * description of what a report looks like, and the thing on screen is the thing
 * that prints.
 *
 * The page margins are the letterhead's clear area (26mm top, 34mm bottom,
 * 14mm sides). Content outside that band would print over Noble's printed
 * header and footer. See `.print` in styles.css.
 *
 * `data-print-ready` is the contract with the renderer. Chromium's networkidle
 * can settle while the SPA is still showing its own loading state, and the PDF
 * would then be a picture of a spinner — so the renderer waits for this
 * attribute instead, and it is only ever set once the data is in hand.
 */

/** Head and Profile rows are the report's own section headings, not analytes. */
const isHeading = (t: TestResult) => t.testType === 'Head' || t.testType === 'Profile';

export function PrintReport() {
  const { sid = '' } = useParams();
  const [row, setRow] = useState<FullRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<FullRow>(`/api/reports/${encodeURIComponent(sid)}`)
      .then((r) => { if (live) setRow(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this report.'); });
    return () => { live = false; };
  }, [sid]);

  const departments = useMemo(() => {
    const groups = new Map<string, TestResult[]>();
    for (const r of row?.results ?? []) {
      const key = r.departmentName?.trim() || 'Results';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.entries()];
  }, [row]);

  // Ready means "there is something to photograph", and an error counts: a
  // failed render must come back as a one-page PDF saying so, not as a 45s
  // timeout with nothing to show for it.
  const ready = row !== null || error !== null;

  return (
    <div className="print" data-print-ready={ready ? 'true' : 'false'}>
      {error ? (
        <p className="print__error">{error}</p>
      ) : !row ? null : (
        <>
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

          {departments.map(([dept, results]) => (
            <section key={dept} className="print__dept">
              <h2>{dept}</h2>
              <table className="print__table">
                <thead>
                  {/* Repeats on every page: a continuation sheet whose columns
                      are unlabelled is a table you have to scroll back to read. */}
                  <tr>
                    <th>Investigation</th>
                    <th className="print__num">Result</th>
                    <th>Unit</th>
                    <th>Biological reference interval</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((t) => isHeading(t) ? (
                    <tr key={t.resultId} className="print__section">
                      <td colSpan={4}>{plainText(t.testName) || t.testCode}</td>
                    </tr>
                  ) : (
                    <tr key={t.resultId}>
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
                  ))}
                </tbody>
              </table>
            </section>
          ))}

          {row.results.length === 0 && <p className="print__error">No results have been entered for this sample.</p>}

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
