import { useCallback, useEffect, useRef, useState } from 'react';
import {
  inwardApi, type InwardFilters, type InwardRow, type InwardScanResponse,
} from '../api/client';
import { ClientPicker } from '../components/ClientPicker';
import { InfinityLoader } from '../components/InfinityLoader';
import { downloadFile, fmtDateTime, plainText } from '../lib/format';
import { useAuth } from '../auth/AuthContext';

/**
 * The API's CSV row ceiling (InwardRepository.MaxRows). Mirrored here only to
 * decide what to PROMISE the operator — the server enforces it, and a truncated
 * file says so on its own last line regardless of what this screen says.
 */
const CSV_CEILING = 10_000;

/** Local calendar date as yyyy-MM-dd — not toISOString, which is UTC and names
 *  yesterday for the first 5.5 IST hours of every day. */
const todayLocal = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The per-scan verdict, replacing the previous one wholesale on every scan.
 *
 * The legacy page's only feedback was a button whose caption stuck on
 * "No Workorder!" until a full page reload — a red word over a scan that had
 * actually succeeded. Here the banner is derived from THIS scan alone.
 */
function ScanVerdict({ r }: { r: InwardScanResponse }) {
  const who = r.patientName ? plainText(r.patientName) : null;

  // The outcome first, the workorder problem second — BOTH are always said.
  // An earlier version let "no workorder" swallow the outcome, which put the
  // legacy's silence back on exactly the scan quirk 2 exists to voice: the
  // 5th scan of an unregistered vial read as "scan logged" when nothing was
  // recorded at all.
  let outcomeCls: string;
  let head: string;
  if (r.outcome === 'new_leg') {
    outcomeCls = 'alert--ok';
    head = `Received at ${r.businessUnit ?? 'this unit'} · #${r.slno ?? '—'} today`;
  } else if (r.outcome === 'already_full') {
    outcomeCls = 'alert--warn';
    head = 'Already fully received here (4 scans) — nothing recorded';
  } else {
    outcomeCls = 'alert--info';
    const n = r.outcome === 'checkpoint_1' ? 1 : r.outcome === 'checkpoint_2' ? 2 : 3;
    head = `Received ${n} recorded`;
  }
  // No workorder turns the banner red (the operator must chase registration),
  // except already_full, whose "nothing recorded" warning is the louder fact.
  const cls = r.noWorkorder && r.outcome !== 'already_full' ? 'alert--error' : outcomeCls;
  if (r.noWorkorder) head += ' · no workorder yet';

  return (
    <div className={`alert ${cls} scan-verdict`} role="status" aria-live="polite">
      <b>{head}</b>
      {who && (
        <span>
          {' '}· {who}
          {r.sex && <span className="muted"> ({r.sex})</span>}
        </span>
      )}
      {r.tests && (
        <div className="muted scan-verdict__tests" title={plainText(r.tests)}>
          {plainText(r.tests)}
        </div>
      )}
      {r.accession.triggered && (
        <div className={r.accession.ok ? undefined : 'scan-verdict__warn'}>
          {r.accession.ok
            ? 'Registered — now on the worksheet.'
            : (r.accession.message ?? 'Not registered.')}
        </div>
      )}
    </div>
  );
}

/**
 * Inward — the transit scan desk and its log, one row per (vial, unit) leg.
 *
 * The scan box is built for a barcode gun: it keeps focus, Enter (the gun's
 * terminator) submits, the input clears, focus returns — continuous operation
 * with no mouse. The legacy page did this with an ASP.NET AutoPostBack plus a
 * deliberate Thread.Sleep(1000) on every scan; there is no artificial delay
 * here.
 */
export function Inward() {
  const { can } = useAuth();
  const canScan = can('order:accession');

  /* ---- scanning ---- */
  const [sidInput, setSidInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [verdict, setVerdict] = useState<InwardScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  /* ---- the log ---- */
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  const [searchSid, setSearchSid] = useState('');
  // What the list actually queries. Debounced: the exact-SID search spans all
  // dates server-side, and firing it on every keystroke of an 8-digit barcode
  // would be eight of the most expensive query this screen can ask for.
  const [sidQuery, setSidQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setSidQuery(searchSid.trim()), 400);
    return () => window.clearTimeout(t);
  }, [searchSid]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [rows, setRows] = useState<InwardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const loadSequence = useRef(0);

  const filters: InwardFilters = { from, to, sid: sidQuery, clientId };

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const r = await inwardApi.list({ from, to, sid: sidQuery, clientId });
      if (sequence !== loadSequence.current) return;
      setRows(r.rows);
      setTotal(r.total);
      setCapped(r.capped);
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : 'Could not load the scan log.');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [from, to, sidQuery, clientId]);

  // A scan can finish after the operator changes a filter. Calling the latest
  // render's loader prevents that old scan closure from restoring old filters.
  const loadLatest = useRef(load);
  loadLatest.current = load;

  useEffect(() => { void load(); }, [load]);

  // The gun needs a focused input before the first trigger pull.
  useEffect(() => { if (canScan) scanRef.current?.focus(); }, [canScan]);

  async function scan() {
    const sid = sidInput.trim();
    if (!sid || scanning) return;

    setScanning(true);
    // The previous verdict is cleared FIRST: feedback that lingers over the
    // next scan reads as feedback about it.
    setVerdict(null);
    setScanError(null);
    try {
      const r = await inwardApi.scan(sid);
      setVerdict(r);
      // AWAITED, not fired-and-forgotten: the legacy contract's scan step is
      // "input clears, grid reloads, focus returns" as one unit (§6.1), and a
      // forgotten load can resolve after a later scan's, showing a stale grid.
      await loadLatest.current();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'The scan failed.');
    } finally {
      setScanning(false);
      setSidInput('');
      // Focus returns whatever happened — the next vial is already in hand.
      scanRef.current?.focus();
    }
  }

  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      await downloadFile(inwardApi.csvHref(filters), { fallbackName: 'inward.csv' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  }

  const searching = searchSid.trim().length > 0;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Inward</h1>
          <p className="page__sub">
            Sample transit — every barcode scan, one row per vial per unit
          </p>
        </div>
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                onClick={() => void load()}>Refresh</button>
      </div>

      {canScan && (
        <div className="card scanbox">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            <span>Scan a Sample ID</span>
            <input
              ref={scanRef}
              className="input mono scanbox__input"
              placeholder="Scan or type, then Enter"
              value={sidInput}
              // readOnly, NOT disabled: disabling a focused input blurs it, and
              // the refocus in scan()'s finally ran before React re-enabled the
              // element — so focus never actually returned and the gun's next
              // pull typed into nothing. readOnly rejects input but keeps focus.
              readOnly={scanning}
              maxLength={50}
              onChange={(e) => setSidInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void scan(); } }}
              aria-label="Scan a Sample ID"
            />
          </label>
          <button className="btn btn--primary" disabled={scanning || !sidInput.trim()}
                  onClick={() => void scan()}>
            {scanning ? 'Scanning…' : 'Inward'}
          </button>
        </div>
      )}

      {scanError && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{scanError}</div>}
      {verdict && <ScanVerdict r={verdict} />}

      {/* ---- the log ---- */}
      <div className="card filter-panel" style={{ marginTop: '1rem' }}>
        <div className="fgroup__grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '.8rem' }}>
          <label className="field">
            <span>SID</span>
            <input className="input mono" placeholder="Exact Sample ID" value={searchSid}
                   onChange={(e) => setSearchSid(e.target.value)} />
          </label>

          <label className="field">
            <span>From</span>
            <input className="input" type="date" value={from} max={to || undefined}
                   disabled={searching}
                   onChange={(e) => setFrom(e.target.value)} />
          </label>

          <label className="field">
            <span>To</span>
            <input className="input" type="date" value={to} min={from || undefined}
                   disabled={searching}
                   onChange={(e) => setTo(e.target.value)} />
          </label>

          <label className="field" style={{ minWidth: 220 }}>
            <span>Client</span>
            <ClientPicker value={clientId} onChange={setClientId} />
          </label>

          <div className="field" style={{ marginLeft: 'auto' }}>
            <span>&nbsp;</span>
            <button className="btn btn--ghost btn--sm" disabled={exporting || rows.length === 0}
                    onClick={() => void exportCsv()}>
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          </div>
        </div>

        {/* A dated window and an exact-SID hunt are different questions; when a
            SID is typed the dates stop applying, and saying so beats greying
            them out silently. */}
        {searching && (
          <p className="muted" style={{ fontSize: '.75rem', margin: '.4rem 0 0' }}>
            Searching this SID across <b>all dates</b> — the date range is ignored.
          </p>
        )}
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading scans…</span></div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: '.78rem', margin: '.6rem 0' }}>
            {total.toLocaleString('en-IN')} scan{total === 1 ? '' : 's'}
            {/* The CSV has a ceiling of its own (10,000), so it is NOT "the
                rest" once the total passes it — about a fortnight of ordinary
                scanning. Promising a complete export the export cannot deliver
                is worse than the legacy pseudo-.xls, which at least looked
                wrong; the file now says so on its last line too. */}
            {capped && (
              <> — showing the first {rows.length.toLocaleString('en-IN')}
                {total > CSV_CEILING
                  ? '; the CSV export also stops at 10,000, so narrow the dates'
                  : '; narrow the dates, or export CSV for all of them'}
              </>
            )}
          </p>

          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>SID</th>
                  <th>Patient</th>
                  <th>Tests</th>
                  <th>Scanned</th>
                  <th>Unit</th>
                  <th>Received 1</th>
                  <th>Received 2</th>
                  <th>Received 3</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono muted" data-label="#">{r.slno ?? '—'}</td>
                    <td className="mono cell--lead"><b>{r.sid ?? '—'}</b></td>
                    <td className="cell--meta" data-label="Patient">
                      {r.patientName ? (
                        <>
                          {plainText(r.patientName)}
                          {/* Sex only when KNOWN — the legacy grid printed 'F'
                              for every unknown, orphan rows included. */}
                          {r.sex && <span className="muted"> · {r.sex}</span>}
                          {r.clientCode && (
                            <div className="muted mono" style={{ fontSize: '.7rem' }}>{r.clientCode}</div>
                          )}
                        </>
                      ) : (
                        <span className="muted" title="No workorder matched this vial">—</span>
                      )}
                    </td>
                    <td className="muted cell--body" data-label="Tests" style={{ maxWidth: 240 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={plainText(r.tests)}>
                        {plainText(r.tests) || '—'}
                      </div>
                    </td>
                    <td className="cell--meta" data-label="Scanned">
                      {r.scannedBy ?? '—'}
                      <div className="muted" style={{ fontSize: '.7rem' }}>{fmtDateTime(r.scannedAt)}</div>
                    </td>
                    <td className="mono cell--meta" data-label="Unit">{r.bunit ?? '—'}</td>
                    <Checkpoint by={r.receivedOne} at={r.receivedOneAt} label="Received 1" />
                    <Checkpoint by={r.receivedTwo} at={r.receivedTwoAt} label="Received 2" />
                    <Checkpoint by={r.receivedThree} at={r.receivedThreeAt} label="Received 3" />
                  </tr>
                ))}

                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      {searching ? 'No scans for that SID.' : 'No scans in this window.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** A checkpoint cell: username with its timestamp (the legacy grid fetched the
 *  timestamps and never showed them, under three columns all titled
 *  "Received1"). */
function Checkpoint({ by, at, label }: { by: string | null; at: string | null; label: string }) {
  if (!by) return <td className="muted cell--meta" data-label={label}>—</td>;
  return (
    <td className="cell--meta" data-label={label}>
      {by}
      <div className="muted" style={{ fontSize: '.7rem' }}>{fmtDateTime(at)}</div>
    </td>
  );
}
