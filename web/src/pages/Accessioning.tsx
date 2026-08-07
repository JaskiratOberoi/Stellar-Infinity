import { useCallback, useEffect, useState } from 'react';
import {
  accessionApi, orderTubesApi,
  type OrderChannel, type OrderTube, type PendingAccession, type PendingRegistration,
} from '../api/client';
import { useSearchParams } from 'react-router-dom';
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

/** Which platform booked the order. Both queues span the two while Telo runs. */
function OriginBadge({ origin }: { origin: string }) {
  return origin === 'infinity'
    ? <span className="badge badge--infinity">infinity</span>
    : <span className="badge badge--telo">telo</span>;
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
  const { can } = useAuth();
  const canSeeMoney = can('billing:view');

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

  const setKind = useCallback((k: OrderChannel | null) => {
    setParams(k ? { kind: k } : {}, { replace: true });
  }, [setParams]);

  const pageSize = 100;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, u] = await Promise.all([
        accessionApi.pending(pendingPage, pageSize, kind ?? undefined),
        accessionApi.unregistered(unregPage, pageSize),
      ]);
      setPending(p.rows); setPendingTotal(p.total);
      setUnreg(u.rows); setUnregTotal(u.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the queues.');
    } finally {
      setLoading(false);
    }
  }, [pendingPage, unregPage, kind]);

  useEffect(() => { void load(); }, [load]);

  async function register(vailids: string[]) {
    if (vailids.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await accessionApi.register(vailids);
      // `skipped` is reported, not swallowed. Being told "12 registered" when
      // three were skipped hides exactly the three that will not reach the
      // worksheet.
      setNotice(r.skipped > 0
        ? `${r.registered} registered · ${r.skipped} skipped (already accessioned, or not found).`
        : `${r.registered} sample${r.registered === 1 ? '' : 's'} registered — now on the worksheet.`);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }

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
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      {/* Both queues on one page, stacked, the way Telo lays them out.
          The jump is what makes that work here: Telo's lists are a handful of
          rows, this first one is routinely a hundred, and the second queue
          would otherwise be a scroll nobody knows is there. */}
      {!loading && (
        <div className="queuebar">
          <span><b>{pendingTotal.toLocaleString('en-IN')}</b> awaiting Sample IDs</span>
          <a href="#awaiting-accessioning">
            <b>{unregTotal.toLocaleString('en-IN')}</b> awaiting accessioning ↓
          </a>
        </div>
      )}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading queues…</span></div>
      ) : (
        <>
          <h2 className="queue__title">Awaiting Sample IDs</h2>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline',
                                        gap: '1rem', flexWrap: 'wrap', margin: '.6rem 0' }}>
            <p className="muted" style={{ fontSize: '.78rem', margin: 0 }}>
              Orders with no barcode attached. Nothing has been collected into a tube the lab can identify.
            </p>

            {/* Resets to page 1: filtering while on page 3 of the unfiltered
                queue lands on a page the narrower result may not have. */}
            <div className="seg" role="group" aria-label="Filter by channel">
              {([[null, 'All'], ['b2c', 'Walk-in'], ['b2b', 'Client']] as const).map(([k, label]) => (
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

          {/* scroll-margin so the sticky top bar does not cover the heading
              when the jump link lands here — see .queue__title. */}
          <h2 className="queue__title queue__title--next" id="awaiting-accessioning">
            Awaiting accessioning
          </h2>
          <p className="muted" style={{ fontSize: '.78rem', margin: '.6rem 0' }}>
            Barcodes exist, but the lab has not received them — still <b>Sample Sent</b>, so still off the
            worksheet. Registering is what hands them to the bench.
          </p>

          <div className="row" style={{ marginBottom: '.7rem' }}>
            <button className="btn btn--primary btn--sm"
                    disabled={selected.size === 0 || busy}
                    onClick={() => void register([...selected])}>
              {busy ? 'Registering…' : `Register ${selected.size || ''} selected`}
            </button>
            <button className="btn btn--ghost btn--sm"
                    disabled={unreg.length === 0}
                    onClick={() => setSelected(new Set(unreg.map((u) => u.vailid ?? '').filter(Boolean)))}>
              Select all on this page
            </button>
            {selected.size > 0 && (
              <button className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            )}
          </div>

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
                  <th>Booked in</th>
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
                    </td>
                    <td className="muted cell--meta" data-label="Client">{r.clientCode ?? '—'}</td>
                    <td className="muted cell--meta" data-label="Tube">{r.sampleTypeName ?? '—'}</td>
                    <td className="muted cell--body" data-label="Tests" style={{ maxWidth: 260 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={plainText(r.testNames)}>
                        {plainText(r.testNames) || '—'}
                      </div>
                    </td>
                    <td className="cell--tag"><OriginBadge origin={r.origin} /></td>
                  </tr>
                ))}

                {unreg.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      Nothing awaiting accessioning.
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
