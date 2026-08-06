import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import type { Gauge, SmartAnalyte, SmartReportData } from './SmartReport';

/**
 * The Smart Report, printed.
 *
 * Not the clinical report with friendlier words on it — a different document
 * for a different reader. The clinical report goes to a doctor and is composited
 * onto Noble's letterhead; this goes to the patient and is rendered HEADLESS,
 * with its own cover and no page numbers. Telo makes exactly the same split, and
 * for the same reason: a booklet with a full-bleed cover reads wrong with
 * "Page 1 of 9" stamped across it, and self-branded pages should not be pasted
 * onto a clinical letterhead.
 *
 * The margins here are therefore this page's own (see `.smartprint` in
 * styles.css), not the letterhead's clear band.
 */

const ZONE_WORD: Record<Gauge['zone'], string> = {
  normal: 'Within range',
  low: 'Below range',
  high: 'Above range',
};

/**
 * The reading's position on its reference band.
 *
 * Print cannot rely on the screen's colour alone — this goes out on whatever
 * printer the collection centre has — so the marker is a solid triangle and the
 * zone is also spelled out in words beside the value.
 */
function PrintGauge({ g }: { g: Gauge }) {
  const pos = Math.max(0, Math.min(100, g.pos));
  return (
    <div className="smartprint__gauge">
      <div className="smartprint__track">
        {/* The in-range band. For a one-sided limit it runs from the edge, which
            is what "no upper limit defined" actually looks like. */}
        <span className="smartprint__band" />
        <span className="smartprint__marker" style={{ left: `${pos}%` }} aria-hidden="true" />
      </div>
      <div className="smartprint__scale">
        <span>{g.low != null ? g.low : ''}</span>
        <span className="smartprint__zone">{ZONE_WORD[g.zone]}</span>
        <span>{g.high != null ? g.high : ''}</span>
      </div>
    </div>
  );
}

function PrintAnalyte({ a }: { a: SmartAnalyte }) {
  return (
    <article className={`smartprint__analyte${a.abnormal ? ' smartprint__analyte--flag' : ''}`}>
      <header>
        <h3>
          {a.friendlyName ?? a.lisName}
          {a.friendlyName && <span className="smartprint__alias">{a.lisName}</span>}
        </h3>
        <p className="smartprint__value">
          {a.value ?? '—'}{a.unit ? <span className="smartprint__unit"> {a.unit}</span> : null}
        </p>
      </header>

      {a.gauge
        ? <PrintGauge g={a.gauge} />
        : a.rangeText && <p className="smartprint__ref">Reference: {a.rangeText}</p>}

      {a.what && <p className="smartprint__what">{a.what}</p>}
      {a.meaning && <p className="smartprint__meaning"><b>What this reading suggests.</b> {a.meaning}</p>}
      {a.advice && <p className="smartprint__advice"><b>What you can do.</b> {a.advice}</p>}
      {a.comments && <p className="smartprint__note">{a.comments}</p>}
    </article>
  );
}

export function PrintSmartReport() {
  const { sid = '' } = useParams();
  const [data, setData] = useState<SmartReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<SmartReportData>(`/api/reports/${encodeURIComponent(sid)}/smart`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this summary.'); });
    return () => { live = false; };
  }, [sid]);

  const ready = data !== null || error !== null;

  return (
    <div className="smartprint" data-print-ready={ready ? 'true' : 'false'}>
      {error ? (
        <p className="print__error">{error}</p>
      ) : !data ? null : (
        <>
          {/* The cover. Its own page: the rest of the booklet starts clean. */}
          <section className="smartprint__cover">
            <p className="smartprint__kicker">Health summary</p>
            <h1>{data.patientName ?? 'Your results'}</h1>
            <p className="smartprint__who">
              {[
                data.age != null ? `${data.age} ${data.ageUnit ?? ''}`.trim() : null,
                data.sex,
              ].filter(Boolean).join(' · ')}
            </p>
            <dl className="smartprint__facts">
              <div><dt>Sample</dt><dd className="mono">{data.sid}</dd></div>
              <div><dt>Collected</dt><dd>{fmtDateTime(data.sampleDrawn)}</dd></div>
              <div><dt>Reported</dt><dd>{fmtDateTime(data.reportedAt)}</dd></div>
            </dl>

            <p className="smartprint__tally">
              <b>{data.totalAnalytes}</b> result{data.totalAnalytes === 1 ? '' : 's'} explained
              {data.abnormalCount > 0
                ? <> · <b>{data.abnormalCount}</b> outside the usual range</>
                : data.totalAnalytes > 0 ? <> · all within the usual range</> : null}
            </p>

            {/* Said on the cover, not buried at the back. Someone reading this
                without a clinician present should meet it first. */}
            <p className="smartprint__caveat">
              This summary explains your laboratory results in everyday language. It is not a diagnosis
              and it does not replace your doctor. Ranges vary between people; a reading outside the usual
              range is not automatically a problem, and one inside it does not rule one out. Please discuss
              these results with your doctor.
            </p>

            {data.withheldCount > 0 && (
              <p className="smartprint__withheld">
                {data.withheldCount} result{data.withheldCount === 1 ? ' is' : 's are'} still being checked by
                the laboratory and {data.withheldCount === 1 ? 'is' : 'are'} not included here. Your full
                clinical report carries {data.withheldCount === 1 ? 'it' : 'them'}.
              </p>
            )}
          </section>

          {data.sections.map((s) => (
            <section key={s.categoryId} className="smartprint__section">
              <header className="smartprint__sectionhead">
                <h2>{s.title}</h2>
                <p>{s.tagline}</p>
                {s.abnormalCount > 0 && (
                  <p className="smartprint__sectionflag">
                    {s.abnormalCount} reading{s.abnormalCount === 1 ? '' : 's'} to look at
                  </p>
                )}
              </header>
              {s.about && <p className="smartprint__about">{s.about}</p>}
              {s.analytes.map((a) => <PrintAnalyte key={`${a.testCode}-${a.lisName}`} a={a} />)}
            </section>
          ))}

          <footer className="smartprint__foot">
            <p>
              Prepared for {data.patientName ?? 'the patient'} from sample {data.sid}
              {data.clientCode ? ` · ${data.clientCode}` : ''}. Results relate only to the sample tested.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
