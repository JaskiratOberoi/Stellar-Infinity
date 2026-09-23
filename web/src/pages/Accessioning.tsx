import { useCallback, useEffect, useState } from 'react';
import {
  accessionApi, api, orderTubesApi,
  type OrderChannel, type OrderTube, type PendingAccession, type PendingRegistration,
  type RegistrationFilter, type RejectReason,
} from '../api/client';
import { ClinicalHistoryModal, ClipGlyph } from '../components/ClinicalHistoryModal';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDateTime, inr, plainText } from '../lib/format';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

/**
 * The two printable documents for one order, straight off the worklist.
 *
 * Telo calls them Bill and Lab receipt and puts them on every row, because the
 * counter needs both at the moment the tubes are barcoded — the bill goes to
 * whoever is paying, the lab copy goes into the box with the sample. Making
 * someone open the order first to reach a print button adds a click to a step
 * that happens hundreds of times a day.
 *
 * New tab, not a navigation: the operator is mid-queue and should come back to
 * the same scroll position with the same filter.
 */
function DocButtons({ billId }: { billId: number }) {
  const open = (copy?: 'lab') =>
    window.open(`/print/invoice/${billId}${copy ? `?copy=${copy}` : ''}`, '_blank', 'noopener');

  return (
    <>
      <button className="btn btn--ghost btn--sm" onClick={() => open()}
              title="The costing bill — tests and money, no sample IDs.">
        Bill
      </button>
      <button className="btn btn--ghost btn--sm" onClick={() => open('lab')}
              title="The lab copy — same bill with the sample IDs listed.">
        Lab receipt
      </button>
    </>
  );
}

/** Who registered it. The Sample-ID queue spans Telo and Infinity; the
 *  accessioning queue also carries the LIS's own clients — most of the network. */
function OriginBadge({ origin }: { origin: string }) {
  if (origin === 'infinity') return <span className="badge badge--infinity">infinity</span>;
  if (origin === 'telo') return <span className="badge badge--telo">telo</span>;
  return <span className="badge badge--lis" title="Registered in the legacy LIS">LIS</span>;
}

/** Local calendar date as yyyy-MM-dd, shifted by `days` — not toISOString,
 *  which is UTC and names yesterday for the first 5.5 IST hours of every day. */
function localDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Accessioning — the two steps between a booked order and the bench.
 *
 * This screen is the reason an order becomes work. Until a barcode is attached
 * AND the sample is received, the worksheet cannot see it: it excludes
 * sample_status <= 1, so an order with no tube and a tube marked Sample Sent
 * are equally invisible.
 *
 * Both queues deliberately span Telo and Infinity. A queue showing only one
 * platform's orders would leave the other's samples stranded with nothing
 * reporting them, so each row says which system booked it.
 */
export function Accessioning() {
  // The invoice routes are gated on billing:view server-side. Hiding the
  // buttons from a technologist who would only get a 403 is the same call the
  // order detail modal makes.
  const { can, user } = useAuth();
  const canSeeMoney = can('billing:view');
  /*
   * The Sample-ID queue is locked (22/09/2026): attaching barcodes is the
   * B2C counter's job, so the tab opens for B2C accounts and, among super
   * admins, for Jas alone. Everyone else sees it locked and cannot land on
   * it by URL either. The API refuses the same people, so this is the
   * courtesy, not the rule.
   */
  const sidQueueUnlocked = user?.role === 'client_b2c'
    || (user?.role === 'super_admin' && (user.username ?? '').trim().toLowerCase() === 'jas');

  const [pending, setPending] = useState<PendingAccession[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [pendingPage, setPendingPage] = useState(1);

  const [unreg, setUnreg] = useState<PendingRegistration[]>([]);
  const [unregTotal, setUnregTotal] = useState(0);
  const [unregPage, setUnregPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [barcodeFor, setBarcodeFor] = useState<PendingAccession | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  /*
   * The accessioning queue's filters — the legacy Accession page's, made
   * optional. It opens on the last seven days: the legacy opens on TODAY,
   * which is exactly how a tube registered on the 14th became invisible to
   * the technician holding it on the 18th. The text filters apply on Enter
   * or when the field loses focus, so typing a SID does not fire a query per
   * keystroke against a 345,000-row backlog.
   */
  const [filter, setFilter] = useState<RegistrationFilter>({ from: localDay(-7), to: localDay() });
  const [sidDraft, setSidDraft] = useState('');
  const [patientDraft, setPatientDraft] = useState('');

  /* Scan-to-register: the barcode gun at the desk. One SID, straight through. */
  const [scan, setScan] = useState('');
  /*
   * Patient history, attached BEFORE or WHILE the tube is registered. The
   * referral note or prescription arrives in the box with the tube, and the
   * desk that opens the box is the desk that should file it — not a step
   * saved for the Reporting tab after the worksheet already has the sample.
   * Same dialog and same SID-keyed file the Reporting tab and the legacy
   * worksheet use, so the bench sees it wherever it looks.
   */
  /** SIDs on this page that already carry a history PDF, for the paperclip. */
  const [cliHis, setCliHis] = useState<Set<string>>(new Set());
  /** The tube whose history dialog is open — a list row, or the scanned SID. */
  const [cliFor, setCliFor] = useState<{ sid: string; patientName: string | null } | null>(null);

  /* Reject: a reason from the LIS's own list, or typed. */
  const [reasons, setReasons] = useState<RejectReason[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  /*
   * Which channel's orders to show, or null for both — held in the URL.
   *
   * Telo reaches the same place with two separate routes, /orders/new and
   * /orders/b2b, each a nav entry. Putting the channel in the query string
   * gives that: /accessioning?kind=b2b is a real page you can link to, land on,
   * bookmark and come back to with the browser's back button, and the nav can
   * point straight at it — without a second copy of a screen that is otherwise
   * identical. One bench works both queues out of one box of tubes; the
   * difference is only how the order was priced.
   *
   * No parameter means both, which is what someone opening the queue cold
   * wants: everything that is waiting.
   */
  const [params, setParams] = useSearchParams();
  const kindParam = params.get('kind');
  const kind: OrderChannel | null = kindParam === 'b2b' ? 'b2b' : kindParam === 'b2c' ? 'b2c' : null;

  /*
   * Two tabs, accessioning FIRST. The queues were stacked with the Sample-ID
   * list on top, which put the desk's daily work — tubes in hand, waiting to
   * be received — below a hundred-row list of orders still to be barcoded.
   * The receiving desk is the primary job; barcoding is the counter's. The
   * tab is in the URL too, and a channel filter implies the Sample-ID tab,
   * so the nav's /accessioning?kind=b2b still lands where it always did.
   */
  const tab: 'accession' | 'sids' =
    sidQueueUnlocked && (params.get('tab') === 'sids' || kind) ? 'sids' : 'accession';

  const setTab = useCallback((t: 'accession' | 'sids') => {
    setParams(t === 'sids' ? { tab: 'sids', ...(kind ? { kind } : {}) } : {}, { replace: true });
  }, [setParams, kind]);

  const setKind = useCallback((k: OrderChannel | null) => {
    setParams(k ? { tab: 'sids', kind: k } : { tab: 'sids' }, { replace: true });
  }, [setParams]);

  const pageSize = 100;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, u] = await Promise.all([
        // A locked queue is not asked for: the API would refuse, and the
        // refusal would read as a failure of the queue that is open.
        sidQueueUnlocked ? accessionApi.pending(pendingPage, pageSize, kind ?? undefined) : null,
        accessionApi.unregistered(unregPage, pageSize, filter),
      ]);
      if (p) { setPending(p.rows); setPendingTotal(p.total); } else { setPending([]); setPendingTotal(0); }
      setUnreg(u.rows); setUnregTotal(u.total);
      // Which tubes already carry a history PDF. Advisory: a failure here
      // leaves every paperclip plain, never the queue empty.
      const sids = u.rows.map((r) => r.vailid).filter((s): s is string => !!s);
      if (sids.length > 0) {
        void api.post<{ sids: string[] }>('/api/reports/clinical-history/flags', { sids })
          .then((f) => setCliHis(new Set(f.sids))).catch(() => { /* advisory only */ });
      } else {
        setCliHis(new Set());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the queues.');
    } finally {
      setLoading(false);
    }
  }, [pendingPage, unregPage, kind, filter, sidQueueUnlocked]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    accessionApi.rejectReasons()
      .then((r) => setReasons(r.reasons))
      .catch(() => setReasons([]));
  }, []);

  /** The per-SID verdict, spelled out: a rack of twelve with three skipped
   *  names the three, because those are the ones not on the worksheet. */
  function describe(
    verb: string, done: number, details: { vailid: string; outcome: string }[],
  ): string {
    const skipped = details.filter((d) => d.outcome === 'skipped').map((d) => d.vailid);
    const head = `${done} sample${done === 1 ? '' : 's'} ${verb}`;
    if (skipped.length === 0) return `${head}.`;
    const list = skipped.slice(0, 6).join(', ') + (skipped.length > 6 ? ` +${skipped.length - 6} more` : '');
    return `${head} · ${skipped.length} skipped — already accessioned, rejected, or not a Sample ID we know: ${list}.`;
  }

  async function register(vailids: string[]) {
    if (vailids.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await accessionApi.register(vailids);
      setNotice(describe('registered — now on the worksheet', r.registered, r.details ?? []));
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reject(vailids: string[]) {
    if (vailids.length === 0 || !reason.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await accessionApi.reject(vailids, reason.trim());
      setNotice(describe(`rejected (${reason.trim()})`, r.rejected, r.details ?? []));
      setSelected(new Set());
      setRejecting(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rejection failed.');
    } finally {
      setBusy(false);
    }
  }

  /*
   * The barcode gun ends every scan with Enter, and Enter used to register
   * the tube outright — so a technician who scanned a tube to LOOK at it
   * had registered it before the list had even refreshed (22/09/2026). Now
   * Enter finds: the list narrows to that Sample ID whatever the date boxes
   * say (the legacy page's by-SID receive ignores its dates too), the tube
   * is there to be read, and registering it is a deliberate second click.
   */
  function findScanned() {
    const sid = scan.trim();
    if (!sid) return;
    setSidDraft(sid);
    setPatientDraft('');
    setFilter((f) => ({ ...f, from: undefined, to: undefined, sid, patient: '' }));
    setUnregPage(1);
  }

  /** The secondary action: the scanned tube, registered whatever the list shows. */
  async function quickRegister() {
    const sid = scan.trim();
    if (!sid) return;
    setScan('');
    await register([sid]);
  }

  const applyText = () => setFilter((f) => ({ ...f, sid: sidDraft, patient: patientDraft }));

  const toggle = (v: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(v)) next.delete(v); else next.add(v);
    return next;
  });

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Accessioning</h1>
          <p className="page__sub">
            Nothing here is on the worksheet yet — this is what puts it there
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: '.5rem' }}>
          {/* The transit scan desk. Lives here rather than in the top bar —
              the bar is at its width limit (see the NAV note in App.tsx) and
              this is the same physical desk: vials arrive, get scanned, get
              registered. Gated like the API gates the scan itself. */}
          {can('order:accession') && (
            <Link className="btn btn--ghost btn--sm" to="/inward">Inward scans</Link>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      {/* One queue at a time. The counts stay on both tabs so the other
          queue is never a surprise; the accessioning count is the filtered
          one, which is what the desk is working through. */}
      <div className="tabs" role="tablist" aria-label="Accessioning queues" style={{ marginBottom: '.8rem' }}>
        <button role="tab" className={`tab${tab === 'accession' ? ' tab--on' : ''}`}
                aria-selected={tab === 'accession'} onClick={() => setTab('accession')}>
          AWAITING ACCESSIONING
          {!loading && <span className="tab__count">{unregTotal.toLocaleString('en-IN')}</span>}
        </button>
        <button role="tab" className={`tab${tab === 'sids' ? ' tab--on' : ''}${sidQueueUnlocked ? '' : ' tab--locked'}`}
                aria-selected={tab === 'sids'} aria-disabled={!sidQueueUnlocked}
                title={sidQueueUnlocked ? undefined : 'Locked — Sample IDs are attached by B2C accounts'}
                onClick={() => { if (sidQueueUnlocked) setTab('sids'); }}>
          {!sidQueueUnlocked && <span className="tab__lock" aria-hidden="true">🔒</span>}
          AWAITING SAMPLE IDS
          {sidQueueUnlocked && !loading && <span className="tab__count">{pendingTotal.toLocaleString('en-IN')}</span>}
          {!sidQueueUnlocked && <span className="tab__count">locked</span>}
        </button>
      </div>

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading queues…</span></div>
      ) : tab === 'sids' ? (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline',
                                        gap: '1rem', flexWrap: 'wrap', margin: '.6rem 0' }}>
            <p className="muted" style={{ fontSize: '.78rem', margin: 0 }}>
              Orders with no barcode attached. Nothing has been collected into a tube the lab can identify.
            </p>

            {/* Resets to page 1: filtering while on page 3 of the unfiltered
                queue lands on a page the narrower result may not have. */}
            {/* Walk-in is hidden from accounts that cannot raise a walk-in
                order. For a collection centre every order is a client order,
                so "All / Walk-in / Client" is three buttons describing one
                thing — and the two they cannot use imply a queue they are
                simply not seeing. */}
            <div className="seg" role="group" aria-label="Filter by channel">
              {(can('order:b2c')
                ? ([[null, 'All'], ['b2c', 'Walk-in'], ['b2b', 'Client']] as const)
                : ([[null, 'All'], ['b2b', 'Client']] as const)
              ).map(([k, label]) => (
                <button
                  key={label}
                  className={`seg__btn${kind === k ? ' is-on' : ''}`}
                  aria-pressed={kind === k}
                  onClick={() => { setKind(k as OrderChannel | null); setPendingPage(1); }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Bill</th>
                  <th>Client</th>
                  <th>Booked in</th>
                  <th>Tubes</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.billId}>
                    <td className="cell--lead">
                      {plainText(r.patientName) || <span className="muted">Unnamed</span>}
                      <div className="muted mono" style={{ fontSize: '.7rem' }}>PID {r.patientId}</div>
                    </td>
                    <td className="mono cell--meta" data-label="Bill">
                      {r.billNumber ?? '—'}
                      <div className="muted" style={{ fontSize: '.7rem' }}>{fmtDateTime(r.billDate)}</div>
                    </td>
                    <td className="muted cell--meta" data-label="Client">{r.clientCode ?? '—'}</td>
                    <td className="cell--tag"><OriginBadge origin={r.origin} /></td>
                    <td className="cell--meta" data-label="Tubes">
                      <b>{r.haveGroups}</b> of {r.requiredGroups}
                    </td>
                    <td className="mono cell--meta" data-label="Value" style={{ textAlign: 'right' }}>
                      {inr(r.total)}
                    </td>
                    {/* Attach, then the two documents — the order Telo puts
                        them in, and the order the counter works in: barcode the
                        tubes, hand the patient a bill, send the lab copy with
                        the sample. */}
                    <td style={{ textAlign: 'right' }}>
                      <div className="rowacts">
                        <button className="btn btn--primary btn--sm" style={{ whiteSpace: 'nowrap' }}
                                onClick={() => setBarcodeFor(r)}>
                          Attach barcode
                        </button>
                        {canSeeMoney && <DocButtons billId={r.billId} />}
                      </div>
                    </td>
                  </tr>
                ))}

                {pending.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      Nothing awaiting Sample IDs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <Pager page={pendingPage} pageSize={pageSize} total={pendingTotal} noun="order"
                   onPage={setPendingPage} />
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: '.78rem', margin: '.2rem 0 .6rem' }}>
            Every tube still marked <b>Sample Sent</b> — whether the client registered it in the legacy LIS,
            in Infinity or in Telo. The lab has not received it, so it is not on the worksheet.
            Registering is what hands it to the bench; rejecting records why it never will be.
          </p>

          {/* The barcode gun. Its Enter FINDS the tube — the list narrows to
              that Sample ID, dates ignored — and registering is the second,
              deliberate button. A scanner must never be able to register a
              tube by itself. */}
          <form className="row" style={{ gap: '.5rem', marginBottom: '.7rem', flexWrap: 'wrap' }}
                onSubmit={(e) => { e.preventDefault(); findScanned(); }}>
            <input className="input mono" inputMode="numeric" placeholder="Scan or type a Sample ID to find it"
                   aria-label="Scan or type a Sample ID to find it"
                   value={scan} onChange={(e) => setScan(e.target.value.trim())}
                   disabled={busy} style={{ width: 260 }} autoFocus />
            <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !scan.trim()}>
              Find
            </button>
            <button className="btn btn--ghost btn--sm" type="button" disabled={busy || !scan.trim()}
                    onClick={() => void quickRegister()}
                    title="Register the scanned tube now, whatever the list shows">
              Register this tube
            </button>
            {/* The note that came in the box with the tube, filed before the
                tube is registered. Named from the list when the tube is on
                it; the dialog works from the SID alone when it is not. */}
            <button className="btn btn--ghost btn--sm" type="button" disabled={busy || !scan.trim()}
                    onClick={() => {
                      const sid = scan.trim();
                      const row = unreg.find((r) => r.vailid === sid);
                      setCliFor({ sid, patientName: row ? plainText(row.patientName) : null });
                    }}
                    title="Attach the patient's history PDF to the scanned tube">
              <ClipGlyph /> Attach history
            </button>
          </form>

          {/* The filters, the legacy page's own — dates on the registration
              date, SID, patient — plus who registered it. Text fields apply
              on Enter or blur. */}
          <div className="row" style={{ gap: '.5rem', marginBottom: '.7rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: '.7rem' }}>Registered from</span>
              <input className="input input--sm" type="date" value={filter.from ?? ''}
                     onChange={(e) => { setFilter((f) => ({ ...f, from: e.target.value || undefined })); setUnregPage(1); }} />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: '.7rem' }}>to</span>
              <input className="input input--sm" type="date" value={filter.to ?? ''}
                     onChange={(e) => { setFilter((f) => ({ ...f, to: e.target.value || undefined })); setUnregPage(1); }} />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: '.7rem' }}>Sample ID</span>
              {/* Starts-with, not contains: a barcode is scanned whole and typed
                  from the start, and a prefix is what the SID index can serve —
                  the contains search walked 348,000 tubes (153). */}
              <input className="input input--sm mono" value={sidDraft} placeholder="starts with"
                     onChange={(e) => setSidDraft(e.target.value)}
                     onBlur={applyText}
                     onKeyDown={(e) => { if (e.key === 'Enter') { applyText(); setUnregPage(1); } }} />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: '.7rem' }}>Patient or mobile</span>
              <input className="input input--sm" value={patientDraft} placeholder="contains"
                     onChange={(e) => setPatientDraft(e.target.value)}
                     onBlur={applyText}
                     onKeyDown={(e) => { if (e.key === 'Enter') { applyText(); setUnregPage(1); } }} />
            </label>
            <div className="seg" role="group" aria-label="Registered in">
              {([[undefined, 'All'], ['lis', 'LIS'], ['infinity', 'Infinity'], ['telo', 'Telo']] as const).map(([o, label]) => (
                <button key={label}
                        className={`seg__btn${(filter.origin ?? undefined) === o ? ' is-on' : ''}`}
                        aria-pressed={(filter.origin ?? undefined) === o}
                        onClick={() => { setFilter((f) => ({ ...f, origin: o })); setUnregPage(1); }}>
                  {label}
                </button>
              ))}
            </div>
            {(filter.from || filter.to || filter.sid || filter.patient || filter.origin) && (
              <button className="btn btn--ghost btn--sm"
                      onClick={() => { setFilter({}); setSidDraft(''); setPatientDraft(''); setUnregPage(1); }}
                      title="Every Sample Sent tube in your scope, whenever it was registered">
                Clear filters
              </button>
            )}
          </div>

          <div className="row" style={{ marginBottom: '.7rem', flexWrap: 'wrap', gap: '.5rem' }}>
            <button className="btn btn--primary btn--sm"
                    disabled={selected.size === 0 || busy}
                    onClick={() => void register([...selected])}>
              {busy ? 'Working…' : `Register ${selected.size || ''} selected`}
            </button>
            <button className="btn btn--ghost btn--sm"
                    disabled={selected.size === 0 || busy}
                    onClick={() => setRejecting((v) => !v)}
                    aria-expanded={rejecting}>
              Reject {selected.size || ''} selected…
            </button>
            <button className="btn btn--ghost btn--sm"
                    disabled={unreg.length === 0}
                    onClick={() => setSelected(new Set(unreg.map((u) => u.vailid ?? '').filter(Boolean)))}>
              Select all on this page
            </button>
            {selected.size > 0 && (
              <button className="btn btn--ghost btn--sm" onClick={() => { setSelected(new Set()); setRejecting(false); }}>
                Clear
              </button>
            )}
          </div>

          {rejecting && selected.size > 0 && (
            <div className="alert alert--warn" style={{ marginBottom: '.7rem' }}>
              <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <span>Reject <b>{selected.size}</b> sample{selected.size === 1 ? '' : 's'} — reason:</span>
                <select className="input input--sm" value={reasons.some((x) => x.reason === reason) ? reason : ''}
                        onChange={(e) => setReason(e.target.value)} aria-label="Reject reason">
                  <option value="">Choose a reason…</option>
                  {reasons.map((x) => <option key={x.id} value={x.reason}>{x.reason}</option>)}
                </select>
                <input className="input input--sm" placeholder="or type one" value={reasons.some((x) => x.reason === reason) ? '' : reason}
                       onChange={(e) => setReason(e.target.value)} style={{ width: 220 }} aria-label="Reject reason, typed" />
                <button className="btn btn--primary btn--sm" disabled={busy || !reason.trim()}
                        onClick={() => void reject([...selected])}>
                  Confirm reject
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </div>
          )}

          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Sample ID</th>
                  <th>Patient</th>
                  <th>Client</th>
                  <th>Tube</th>
                  <th>Tests</th>
                  <th>Registered</th>
                  <th>By</th>
                  <th>History</th>
                </tr>
              </thead>
              <tbody>
                {unreg.map((r) => (
                  <tr key={r.sampleId}>
                    <td>
                      <input type="checkbox"
                             checked={r.vailid != null && selected.has(r.vailid)}
                             onChange={() => r.vailid && toggle(r.vailid)}
                             aria-label={`Select ${r.vailid}`} />
                    </td>
                    <td className="mono cell--lead"><b>{r.vailid ?? '—'}</b></td>
                    <td className="cell--meta" data-label="Patient">
                      {plainText(r.patientName) || <span className="muted">Unnamed</span>}
                      {r.mobile && <div className="muted mono" style={{ fontSize: '.7rem' }}>{r.mobile}</div>}
                    </td>
                    <td className="muted cell--meta" data-label="Client">
                      {r.clientCode ?? '—'}
                      {r.businessUnit && <div style={{ fontSize: '.7rem' }}>{r.businessUnit}</div>}
                    </td>
                    <td className="muted cell--meta" data-label="Tube">{r.sampleTypeName ?? '—'}</td>
                    <td className="muted cell--body" data-label="Tests" style={{ maxWidth: 260 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={plainText(r.testNames)}>
                        {plainText(r.testNames) || '—'}
                      </div>
                    </td>
                    <td className="muted cell--meta" data-label="Registered" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateTime(r.addedAt)}
                    </td>
                    <td className="cell--tag" data-label="By">
                      <OriginBadge origin={r.origin} />
                      {r.origin === 'lis' && r.registeredBy && (
                        <div className="muted mono" style={{ fontSize: '.68rem' }}>{r.registeredBy}</div>
                      )}
                    </td>
                    <td className="cell--tag" data-label="History">
                      {r.vailid && (() => {
                        const has = cliHis.has(r.vailid);
                        return (
                          <button
                            className="btn btn--ghost btn--sm"
                            title={has ? 'Patient history attached — view or replace' : 'Attach the patient\'s history PDF before registering'}
                            aria-label={`Patient history for ${r.vailid}`}
                            style={has ? { color: 'var(--teal)', fontWeight: 600 } : undefined}
                            disabled={busy}
                            onClick={() => setCliFor({ sid: r.vailid!, patientName: plainText(r.patientName) || null })}
                          >
                            <ClipGlyph />{has ? ' Hist.' : ''}
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}

                {unreg.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      Nothing awaiting accessioning
                      {(filter.from || filter.to || filter.sid || filter.patient || filter.origin)
                        ? ' in this window — clear the filters to see every Sample Sent tube.'
                        : '.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <Pager page={unregPage} pageSize={pageSize} total={unregTotal} noun="sample"
                   onPage={setUnregPage} />
          </div>
        </>
      )}

      {cliFor && (
        <ClinicalHistoryModal
          sid={cliFor.sid}
          patientName={cliFor.patientName}
          has={cliHis.has(cliFor.sid)}
          // Nothing here is signed out — every tube is still Sample Sent.
          locked={false}
          onClose={() => setCliFor(null)}
          onChanged={(sid, nowHas) => {
            setCliHis((prev) => {
              const next = new Set(prev);
              if (nowHas) next.add(sid); else next.delete(sid);
              return next;
            });
            setNotice(nowHas
              ? `Patient history attached to ${sid} — the bench sees it on the worksheet once the tube is registered.`
              : `Patient history removed from ${sid}.`);
            setCliFor(null);
          }}
        />
      )}

      {barcodeFor && (
        <BarcodeModal
          order={barcodeFor}
          onClose={() => setBarcodeFor(null)}
          onDone={async (msg) => { setBarcodeFor(null); setNotice(msg); await load(); }}
        />
      )}
    </div>
  );
}

/**
 * Attach one barcode per tube.
 *
 * The tubes come from THIS order's own tests, not from the cart — the cart is
 * the current user's shopping basket and has nothing to do with an order booked
 * hours ago by someone else. A barcode offered for a tube the order does not
 * need is rejected by the procedure anyway, so binding the inputs to the real
 * sample types is both correct and the only way the form can be pre-labelled.
 */
function BarcodeModal({
  order, onClose, onDone,
}: {
  order: PendingAccession;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [groups, setGroups] = useState<OrderTube[] | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    orderTubesApi.forPatient(order.patientId)
      .then((r) => { if (live) setGroups(r.tubes); })
      .catch(() => { if (live) setGroups([]); });
    return () => { live = false; };
  }, [order.patientId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit() {
    const sids = Object.entries(values)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => ({ sampleTypeId: Number(k), vailid: v.trim() }));

    if (sids.length === 0) { setError('Enter at least one Sample ID.'); return; }

    setBusy(true);
    setError(null);
    try {
      await accessionApi.addSids(order.patientId, order.mccCode ?? 0, sids);
      await onDone(`${sids.length} Sample ID${sids.length === 1 ? '' : 's'} attached. `
        + 'Register them on the next tab to put the sample on the worksheet.');
    } catch (e) {
      // The procedure's own message is the useful one: it knows about barcodes
      // already used anywhere in the LIS, and about tubes this order does not need.
      setError(e instanceof Error ? e.message : 'Those Sample IDs were not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-label="Attach Sample IDs">
        <h2 className="modal__title">
          Attach Sample IDs · <span className="mono">{order.billNumber}</span>
        </h2>
        <p className="muted" style={{ fontSize: '.8rem' }}>
          {plainText(order.patientName)} · needs {order.requiredGroups} tube
          {order.requiredGroups === 1 ? '' : 's'}
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        {groups === null ? (
          <div className="center" style={{ minHeight: 100 }}><InfinityLoader /></div>
        ) : groups.length === 0 ? (
          <div className="alert alert--info">
            The tube breakdown could not be derived here. Attach the barcode from the order screen instead.
          </div>
        ) : (
          <div className="stack">
            {groups.map((g) => (
              <div className="field" key={g.sampleTypeId}>
                <label htmlFor={`sid-${g.sampleTypeId}`}>
                  {g.sampleTypeName || 'Unspecified'}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {' '}· {plainText(g.testNames) || 'no tests listed'}
                  </span>
                </label>

                {g.existingVailid ? (
                  // Already has a label. Showing it read-only is better than
                  // hiding the row: the operator is holding tubes and needs to
                  // see which one is already done.
                  <div className="row" style={{ gap: '.5rem' }}>
                    <input className="input mono" value={g.existingVailid} readOnly disabled />
                    <span className="badge badge--infinity">attached</span>
                  </div>
                ) : (
                  <input
                    id={`sid-${g.sampleTypeId}`}
                    className="input mono"
                    inputMode="numeric"
                    placeholder="Scan or type the barcode"
                    autoFocus={groups.filter((x) => !x.existingVailid)[0]?.sampleTypeId === g.sampleTypeId}
                    value={values[g.sampleTypeId] ?? ''}
                    onChange={(e) => setValues({
                      ...values,
                      // Digits only, matching the LIS's own rule for a barcode.
                      [g.sampleTypeId]: e.target.value.replace(/\D/g, ''),
                    })}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || groups === null}
                  onClick={() => void submit()}>
            {busy ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      </div>
    </div>
  );
}
