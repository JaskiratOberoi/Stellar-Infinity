import { useCallback, useEffect, useState } from 'react';
import {
  cartApi, catalogApi,
  type Cart, type CatalogItem, type OrderPreview, type PlacedOrder,
} from '../api/client';
import { inr, plainText } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { ClientPicker } from '../components/ClientPicker';
import { RateSourceBadge } from './Catalogue';

interface PatientForm {
  name: string;
  initial: string;
  age: string;
  ageType: number;
  gender: number;
  mobile: string;
  mrnId: string;
  clinicalHistory: string;
}

const EMPTY_PATIENT: PatientForm = {
  name: '', initial: 'Mr', age: '', ageType: 1, gender: 1,
  mobile: '', mrnId: '', clinicalHistory: '',
};

/**
 * Book an order.
 *
 * Deliberately in this sequence — client, then tests, then patient — because
 * every price depends on the client, and the operator should see what the order
 * costs before typing out a person's details.
 *
 * Barcodes are NOT collected here. A B2B order is booked first and accessioned
 * when the tubes physically arrive, which may be hours later and is somebody
 * else's job; see the Accessioning screen. That is also why the confirmation
 * says the order is not yet on the worksheet.
 */
export function NewOrder() {
  const [cart, setCart] = useState<Cart>({ mcc: null, items: [] });
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [patient, setPatient] = useState<PatientForm>(EMPTY_PATIENT);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [searching, setSearching] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- cart ----
  useEffect(() => {
    void cartApi.get().then(setCart).catch(() => { /* empty cart is the safe default */ });
  }, []);

  const refreshPreview = useCallback(async (c: Cart) => {
    if (c.mcc == null || c.items.length === 0) { setPreview(null); return; }
    try {
      setPreview(await cartApi.preview());
    } catch {
      setPreview(null);
    }
  }, []);

  useEffect(() => { void refreshPreview(cart); }, [cart, refreshPreview]);

  // ---- test search ----
  useEffect(() => {
    if (cart.mcc == null || !search.trim()) { setResults([]); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      catalogApi.search(cart.mcc, search, '', 1, 25)
        .then((r) => { if (live) setResults(r.rows); })
        .catch(() => { if (live) setResults([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [search, cart.mcc]);

  async function act(fn: () => Promise<Cart>) {
    setError(null);
    try { setCart(await fn()); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
  }

  const inCart = (i: CatalogItem) => cart.items.some((c) => c.kind === i.kind && c.id === i.id);

  async function place() {
    if (cart.mcc == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cartApi.place({
        mcc: cart.mcc,
        items: cart.items,
        // None: this is the B2B path. Barcodes are attached at accessioning.
        sampleSids: [],
        patientId: 0,
        name: patient.name.trim(),
        initial: patient.initial || null,
        age: patient.age ? Number(patient.age) : null,
        ageType: patient.ageType,
        gender: patient.gender,
        mobile: patient.mobile.trim() || null,
        mrnId: patient.mrnId.trim() || null,
        clinicalHistory: patient.clinicalHistory.trim() || null,
        discountAmount: 0,
        receiptAmount: 0,
        billAtMrp: false,
      });
      setPlaced(result);
      setCart({ mcc: cart.mcc, items: [] });
      setPatient(EMPTY_PATIENT);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The order was not placed.');
    } finally {
      setBusy(false);
    }
  }

  const canPlace = cart.mcc != null
    && cart.items.length > 0
    && patient.name.trim().length > 0
    && (preview?.unpriced ?? 0) === 0
    && !busy;

  // ---- placed confirmation ----
  if (placed?.ok) {
    return (
      <div className="page">
        <h1 className="page__title">Order placed</h1>
        <div className="card" style={{ marginTop: '1rem', maxWidth: 640 }}>
          <p style={{ fontSize: '1.1rem' }}>
            Bill <b className="mono">{placed.billNumber}</b> · {inr(placed.total)}
          </p>
          <p className="muted" style={{ fontSize: '.84rem', lineHeight: 1.7, marginTop: '.6rem' }}>
            This order is <b>not on the worksheet yet</b>. It has no Sample IDs, so the lab cannot see it.
            Attach barcodes on the <b>Accessioning</b> screen when the tubes arrive — that is what puts it
            in front of the bench.
          </p>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn btn--primary btn--sm" onClick={() => setPlaced(null)}>
              Book another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">New order</h1>
          <p className="page__sub">Choose a client, add tests, then enter the patient</p>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {/* ---- 1. client ---- */}
      <div className="card" style={{ marginBottom: '.9rem' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Client</label>
          <div className="row">
            <ClientPicker
              value={cart.mcc}
              activeOnly
              allowNone={false}
              onChange={(mcc) => { if (mcc != null) void act(() => cartApi.setClient(mcc)); }}
            />
            {cart.mcc == null && (
              <span className="muted" style={{ fontSize: '.76rem' }}>
                Every price depends on this, so it comes first.
              </span>
            )}
          </div>
          {cart.items.length > 0 && (
            <span className="muted" style={{ fontSize: '.72rem' }}>
              Changing client empties the basket — the rates are different.
            </span>
          )}
        </div>
      </div>

      {cart.mcc != null && (
        <>
          {/* ---- 2. tests ---- */}
          <div className="card" style={{ marginBottom: '.9rem' }}>
            <div className="field">
              <label htmlFor="test-search">Add tests</label>
              <input id="test-search" className="input" placeholder="Search by name or code…"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            {search.trim() && (
              <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table>
                  <tbody>
                    {searching && results.length === 0 && (
                      <tr><td className="muted" style={{ padding: '1rem' }}>Searching…</td></tr>
                    )}
                    {results.map((i) => (
                      <tr key={`${i.kind}:${i.id}`}>
                        <td>
                          {plainText(i.name) || i.code}
                          <span className="muted mono" style={{ fontSize: '.72rem' }}> {i.code}</span>
                        </td>
                        <td style={{ width: 110, textAlign: 'right' }} className="mono">
                          {i.rate != null ? inr(i.rate) : <span className="muted">no price</span>}
                        </td>
                        <td style={{ width: 90 }}><RateSourceBadge source={i.rateSource} /></td>
                        <td style={{ width: 90, textAlign: 'right' }}>
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={inCart(i) || i.rateSource === 'none'}
                            title={i.rateSource === 'none' ? 'No price for this client' : undefined}
                            onClick={() => void act(() => cartApi.add(
                              { kind: i.kind, id: i.id, code: i.code, name: i.name }))}
                          >
                            {inCart(i) ? 'Added' : 'Add'}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!searching && results.length === 0 && (
                      <tr><td className="muted" style={{ padding: '1rem' }}>Nothing matches.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- 3. the basket ---- */}
          {cart.items.length > 0 && preview && (
            <div className="card" style={{ marginBottom: '.9rem' }}>
              <div className="table-wrap table-wrap--cards">
                <table>
                  <thead>
                    <tr>
                      <th>Test</th>
                      <th style={{ textAlign: 'right' }}>MRP</th>
                      <th style={{ textAlign: 'right' }}>Rate</th>
                      <th>Source</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={`${l.kind}:${l.id}`}>
                        <td className="cell--lead">{plainText(l.name) || l.code}</td>
                        <td className="mono muted cell--meta" data-label="MRP" style={{ textAlign: 'right' }}>
                          {l.mrp != null && l.mrp > 0 ? inr(l.mrp) : '—'}
                        </td>
                        <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>
                          {l.rate != null ? inr(l.rate) : <span className="muted">no price</span>}
                        </td>
                        <td className="cell--tag"><RateSourceBadge source={l.rateSource} /></td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn--ghost btn--sm"
                                  onClick={() => void act(() => cartApi.remove(l.kind, l.id))}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row" style={{ marginTop: '.8rem', flexWrap: 'wrap', gap: '1.2rem' }}>
                <span style={{ fontSize: '1.05rem' }}>
                  Total <b>{inr(preview.total)}</b>
                </span>

                {/* Stated with its basis. Most of the catalogue has no MRP, so a
                    bare margin figure would be meaningless — and someone would
                    eventually price a contract off it. */}
                {preview.margin.comparableLines > 0 && (
                  <span className="muted" style={{ fontSize: '.8rem' }}>
                    {preview.margin.amount >= 0 ? 'Discount vs MRP' : 'Above MRP'}{' '}
                    <b>{inr(Math.abs(preview.margin.amount))}</b>
                    {' '}on {preview.margin.comparableLines} of {preview.lines.length} line
                    {preview.lines.length === 1 ? '' : 's'}
                    {preview.margin.linesWithoutMrp > 0
                      && ` · ${preview.margin.linesWithoutMrp} without an MRP to compare`}
                  </span>
                )}

                <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                        onClick={() => void act(() => cartApi.clear())}>
                  Empty basket
                </button>
              </div>

              {/* The tubes this order will need. Shown while booking so a
                  collection centre knows how many barcodes to put out. */}
              {preview.groups.length > 0 && (
                <p className="muted" style={{ fontSize: '.76rem', marginTop: '.7rem' }}>
                  Needs <b>{preview.groups.length}</b> tube{preview.groups.length === 1 ? '' : 's'}:{' '}
                  {preview.groups.map((g) => g.sampleTypeName || 'Unspecified').join(', ')}
                </p>
              )}

              {preview.unpriced > 0 && (
                <div className="alert alert--error" style={{ marginTop: '.7rem' }}>
                  {preview.unpriced} item{preview.unpriced === 1 ? ' has' : 's have'} no price for this
                  client and the order cannot be placed. Remove {preview.unpriced === 1 ? 'it' : 'them'} or
                  have a rate set first.
                </div>
              )}
            </div>
          )}

          {/* ---- 4. patient ---- */}
          {cart.items.length > 0 && (
            <div className="card">
              <h2 style={{ fontSize: '.9rem', marginBottom: '.7rem' }}>Patient</h2>

              <div className="grid2">
                <div className="field">
                  <label htmlFor="p-name">Name</label>
                  <div className="row" style={{ gap: '.35rem' }}>
                    <select className="input" value={patient.initial} style={{ width: 82 }}
                            onChange={(e) => setPatient({ ...patient, initial: e.target.value })}>
                      {['Mr', 'Ms', 'Mrs', 'Dr', 'Master', 'Baby', ''].map((t) => (
                        <option key={t || 'none'} value={t}>{t || '—'}</option>
                      ))}
                    </select>
                    <input id="p-name" className="input" value={patient.name} maxLength={200}
                           onChange={(e) => setPatient({ ...patient, name: e.target.value })} />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="p-mobile">Mobile</label>
                  <input id="p-mobile" className="input mono" value={patient.mobile} inputMode="numeric"
                         maxLength={12}
                         onChange={(e) => setPatient({ ...patient, mobile: e.target.value.replace(/\D/g, '') })} />
                  <span className="muted" style={{ fontSize: '.7rem' }}>
                    Optional — but a patient with no mobile gets no result history on the worksheet.
                  </span>
                </div>
              </div>

              <div className="grid2">
                <div className="field">
                  <label htmlFor="p-age">Age</label>
                  <div className="row" style={{ gap: '.35rem' }}>
                    <input id="p-age" className="input mono" value={patient.age} inputMode="numeric"
                           style={{ width: 90 }}
                           onChange={(e) => setPatient({ ...patient, age: e.target.value.replace(/\D/g, '') })} />
                    <select className="input" value={patient.ageType} style={{ width: 110 }}
                            onChange={(e) => setPatient({ ...patient, ageType: Number(e.target.value) })}>
                      <option value={1}>Years</option>
                      <option value={2}>Months</option>
                      <option value={3}>Days</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="p-gender">Sex</label>
                  <select id="p-gender" className="input" value={patient.gender}
                          onChange={(e) => setPatient({ ...patient, gender: Number(e.target.value) })}>
                    <option value={1}>Male</option>
                    <option value={2}>Female</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="p-hist">Clinical history</label>
                <input id="p-hist" className="input" value={patient.clinicalHistory} maxLength={500}
                       onChange={(e) => setPatient({ ...patient, clinicalHistory: e.target.value })} />
              </div>

              <div className="row" style={{ marginTop: '.9rem' }}>
                <button className="btn btn--primary" disabled={!canPlace} onClick={() => void place()}>
                  {busy ? 'Placing…' : `Place order · ${inr(preview?.total ?? 0)}`}
                </button>
                {!patient.name.trim() && (
                  <span className="muted" style={{ fontSize: '.76rem' }}>A patient name is required.</span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {busy && <div className="center" style={{ marginTop: '1rem' }}><InfinityLoader /></div>}
    </div>
  );
}
