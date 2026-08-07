import { useCallback, useEffect, useState } from 'react';
import {
  api, cartApi, catalogApi,
  type Cart, type CatalogItem, type OrderChannel, type OrderPreview, type PlacedOrder,
} from '../api/client';
import { inr, plainText } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { ClientPicker } from '../components/ClientPicker';
import { useAuth } from '../auth/AuthContext';
import { RateSourceBadge } from './Catalogue';
import { Combobox } from '../components/Combobox';

interface PatientForm {
  name: string;
  initial: string;
  /**
   * Age is entered as years AND months, and resolved to the LIS's single
   * age + age_type at submit — see resolveAge. Telo moved to the same pair on
   * its B2B form: "6 months" is a real paediatric age that a years box cannot
   * express, and asking the operator to also pick the unit is a second thing
   * to get wrong.
   */
  ageYears: string;
  ageMonths: string;
  gender: number;
  mobile: string;
  email: string;
  /** Passport / travel ID. Written to patient_master.MRNID. */
  mrnId: string;
  clinicalHistory: string;
}

const EMPTY_PATIENT: PatientForm = {
  name: '', initial: 'Mr', ageYears: '', ageMonths: '', gender: 1,
  mobile: '', email: '', mrnId: '', clinicalHistory: '',
};

/**
 * Years + months, as the LIS stores it: one number and a unit.
 *
 * Ported from Telo's resolveB2bAge so the two systems record the same patient
 * the same way. Under two years the age is kept in MONTHS, because that is the
 * unit a paediatric reference range is banded in — "1 year" and "18 months" are
 * different ranges, and rounding the second to the first would pick the wrong
 * one. Above that it is years, and months beyond 11 are a typo rather than an
 * age.
 *
 * null means "not a usable age", which the submit gate treats as incomplete
 * rather than guessing.
 */
function resolveAge(yearsStr: string, monthsStr: string): { age: number; ageType: number } | null {
  const y = yearsStr.trim() === '' ? 0 : Number(yearsStr.trim());
  const m = monthsStr.trim() === '' ? 0 : Number(monthsStr.trim());
  if (!Number.isInteger(y) || !Number.isInteger(m) || y < 0 || m < 0) return null;
  if (y === 0 && m === 0) return null;
  if (y > 150 || m > 150) return null;

  const totalMonths = y * 12 + m;
  if (y === 0 || (m > 0 && totalMonths < 24)) {
    if (totalMonths <= 0 || totalMonths > 150) return null;
    return { age: totalMonths, ageType: 2 };
  }
  if (m > 11) return null;
  return { age: y, ageType: 1 };
}

/** A referrer the operator picked, or a name they typed that does not exist yet. */
type RefPick = { kind: 'existing'; id: number; name: string } | { kind: 'new'; name: string } | null;

interface Referrer { id: number; code: string; name: string }

/**
 * Book an order.
 *
 * Deliberately in this sequence — client, then tests, then patient — because
 * every price depends on the client, and the operator should see what the order
 * costs before typing out a person's details.
 *
 * Barcodes are NOT collected here. An order is booked first and accessioned
 * when the tubes physically arrive, which may be hours later and is somebody
 * else's job; see the Accessioning screen. That is also why the confirmation
 * says the order is not yet on the worksheet.
 *
 * ── THE CHANNEL IS THE FIRST DECISION, NOT A SETTING ───────────────────────
 * B2C bills the basket at the client's own rate. B2B bills it at catalogue
 * MRP, because the patient pays the collection centre MRP and the centre owes
 * the lab its rate-list price separately. Same basket, two different bills, so
 * the choice sits at the top of the form and the preview is re-quoted whenever
 * it changes.
 *
 * Until now this screen always sent billAtMrp:false — every order Infinity has
 * ever raised was priced B2C — while these comments described it as the B2B
 * path. It was neither labelled nor gated.
 */
export function NewOrder() {
  const { can } = useAuth();
  const mayB2b = can('order:b2b');
  const mayB2c = can('order:b2c') || can('order:create');

  /*
   * Always starts B2C, then corrects.
   *
   * Deriving the initial value from capabilities looked right and was wrong:
   * `can()` answers false until /me resolves, so on any slow restore the
   * initial value was computed as though the operator had no B2C rights and
   * the page opened in B2B — the channel that overrides the client's rates
   * with MRP. useState keeps a first value for ever, so it never corrected
   * itself. Caught in the harness, where the page came up on B2B for a
   * super-admin holding both.
   *
   * So the safe channel is the literal default and the effect below is the
   * only thing that moves it.
   */
  const [channel, setChannel] = useState<OrderChannel>('b2c');

  // An account confined to B2B lands there once we actually know that.
  useEffect(() => {
    if (!mayB2c && mayB2b) setChannel('b2b');
  }, [mayB2c, mayB2b]);

  const [cart, setCart] = useState<Cart>({ mcc: null, items: [] });
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [patient, setPatient] = useState<PatientForm>(EMPTY_PATIENT);

  // Referrers. The create procedure has always accepted these — an id, or a
  // name it upserts — but nothing offered a way to pick one, so every order so
  // far was booked with none.
  const [refs, setRefs] = useState<{ doctors: Referrer[]; customers: Referrer[] }>(
    { doctors: [], customers: [] });
  const [refDoctor, setRefDoctor] = useState<RefPick>(null);
  const [refCustomer, setRefCustomer] = useState<RefPick>(null);
  useEffect(() => {
    let live = true;
    api.get<{ doctors: Referrer[]; customers: Referrer[] }>('/api/orders/referrers')
      .then((r) => { if (live) setRefs(r); })
      .catch(() => { /* Pickers degrade to create-only; the order still books. */ });
    return () => { live = false; };
  }, []);

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

  const refreshPreview = useCallback(async (c: Cart, ch: OrderChannel) => {
    if (c.mcc == null || c.items.length === 0) { setPreview(null); return; }
    try {
      setPreview(await cartApi.preview(ch));
    } catch {
      setPreview(null);
    }
  }, []);

  // Re-quotes on a channel change as well as a cart change — the same basket
  // is a different total in the other channel.
  useEffect(() => { void refreshPreview(cart, channel); }, [cart, channel, refreshPreview]);

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

  // Read off the PREVIEW, not the local state: the preview is what the server
  // actually quoted, and if the two ever disagree the table must describe the
  // numbers it is showing rather than the ones that were asked for.
  const b2b = (preview?.channel ?? channel) === 'b2b';

  async function place() {
    if (cart.mcc == null) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = resolveAge(patient.ageYears, patient.ageMonths);
      const result = await cartApi.place({
        mcc: cart.mcc,
        items: cart.items,
        // None in either channel. Barcodes are attached at accessioning, when
        // the tubes actually arrive.
        sampleSids: [],
        patientId: 0,
        name: patient.name.trim(),
        initial: patient.initial || null,
        age: resolved?.age ?? null,
        ageType: resolved?.ageType ?? null,
        gender: patient.gender,
        mobile: patient.mobile.trim() || null,
        email: patient.email.trim() || null,
        mrnId: patient.mrnId.trim() || null,
        // An existing referrer travels as its id; a typed one as a name the
        // create procedure upserts. Never both.
        refDoctor: refDoctor?.kind === 'existing' ? refDoctor.id : null,
        newRefDoctorName: refDoctor?.kind === 'new' ? refDoctor.name : null,
        refCustomer: refCustomer?.kind === 'existing' ? refCustomer.id : null,
        newRefCustomerName: refCustomer?.kind === 'new' ? refCustomer.name : null,
        clinicalHistory: patient.clinicalHistory.trim() || null,
        discountAmount: 0,
        receiptAmount: 0,
        // The API derives billAtMrp from the channel after checking the
        // capability, and ignores anything sent here — so the channel is the
        // only thing worth sending.
        channel,
        billAtMrp: false,
      });
      setPlaced(result);
      setCart({ mcc: cart.mcc, items: [] });
      setPatient(EMPTY_PATIENT);
      setRefDoctor(null);
      setRefCustomer(null);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The order was not placed.');
    } finally {
      setBusy(false);
    }
  }

  const age = resolveAge(patient.ageYears, patient.ageMonths);
  // A half-typed number is a typo, not a phone number. Blank is fine —
  // hospital counters often have no reachable number — but six digits is
  // someone who was interrupted, and the LIS would keep it forever.
  const mobileOk = patient.mobile.trim() === '' || patient.mobile.trim().length === 10;

  const canPlace = cart.mcc != null
    && cart.items.length > 0
    && patient.name.trim().length > 0
    && age !== null
    && mobileOk
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

      {/* ---- channel ----
          Above step 1 rather than inside it, because it governs every price on
          the page — including the client's own rates, which it can override
          entirely. Hidden when the account only has one channel: a choice with
          one option is furniture. */}
      {mayB2b && mayB2c && (
        <div className="card channel" style={{ marginBottom: '.9rem' }}>
          <div className="channel__opts" role="radiogroup" aria-label="Order channel">
            <ChannelOption
              on={channel === 'b2c'} onPick={() => setChannel('b2c')}
              title="Walk-in · B2C"
              sub="Billed at this client's own rate"
            />
            <ChannelOption
              on={channel === 'b2b'} onPick={() => setChannel('b2b')}
              title="Client order · B2B"
              sub="Billed at MRP — the centre keeps the margin"
            />
          </div>
        </div>
      )}

      {/* All three steps are ALWAYS rendered, dimmed until reachable.
          Revealing them one at a time left the page as a single card above an
          empty screen, which read as broken rather than as "do this first". */}

      {/* ---- 1. client ---- */}
      <div className="card order-step" style={{ marginBottom: '.9rem' }}>
        <div className="order-step__head">
          <span className="order-step__num order-step__num--on">1</span>
          <h2 className="order-step__title">Client</h2>
          <span className="muted" style={{ fontSize: '.76rem' }}>
            Every price depends on this, so it comes first.
          </span>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <ClientPicker
            value={cart.mcc}
            activeOnly
            allowNone={false}
            onChange={(mcc) => { if (mcc != null) void act(() => cartApi.setClient(mcc)); }}
          />
          {cart.items.length > 0 && (
            <span className="muted" style={{ fontSize: '.72rem' }}>
              Changing client empties the basket — the rates are different.
            </span>
          )}
        </div>
      </div>

      {cart.mcc == null ? (
        <>
          <div className="card order-step order-step--off" style={{ marginBottom: '.9rem' }}>
            <div className="order-step__head">
              <span className="order-step__num">2</span>
              <h2 className="order-step__title">Tests</h2>
              <span className="muted" style={{ fontSize: '.76rem' }}>
                Search the catalogue once a client is chosen — prices are theirs, not list price.
              </span>
            </div>
          </div>
          <div className="card order-step order-step--off">
            <div className="order-step__head">
              <span className="order-step__num">3</span>
              <h2 className="order-step__title">Patient</h2>
              <span className="muted" style={{ fontSize: '.76rem' }}>
                Entered last, so nobody types out a person before seeing the cost.
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* ---- 2. tests ---- */}
          <div className="card order-step" style={{ marginBottom: '.9rem' }}>
            <div className="order-step__head">
              <span className="order-step__num order-step__num--on">2</span>
              <h2 className="order-step__title">Tests</h2>
              {cart.items.length > 0 && (
                <span className="muted" style={{ fontSize: '.76rem' }}>
                  {cart.items.length} in the basket
                </span>
              )}
            </div>

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

            {!search.trim() && cart.items.length === 0 && (
              <p className="muted" style={{ fontSize: '.78rem', marginTop: '.2rem' }}>
                Start typing to search this client's catalogue. Anything without a price for them
                cannot be added.
              </p>
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
                      {/* In B2B the charge IS the MRP, so a separate MRP column
                          would print the same number twice. The useful second
                          number there is what the centre pays. */}
                      <th style={{ textAlign: 'right' }}>{b2b ? 'Client pays' : 'MRP'}</th>
                      <th style={{ textAlign: 'right' }}>{b2b ? 'Patient pays' : 'Rate'}</th>
                      {b2b && <th style={{ textAlign: 'right' }}>Margin</th>}
                      <th>Source</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={`${l.kind}:${l.id}`}>
                        <td className="cell--lead">{plainText(l.name) || l.code}</td>
                        <td className="mono muted cell--meta"
                            data-label={b2b ? 'Client pays' : 'MRP'} style={{ textAlign: 'right' }}>
                          {b2b
                            ? (l.clientCost != null ? inr(l.clientCost) : '—')
                            : (l.mrp != null && l.mrp > 0 ? inr(l.mrp) : '—')}
                        </td>
                        <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>
                          {l.rate != null && l.rate > 0
                            ? inr(l.rate)
                            : <span className="muted">{b2b ? 'no MRP — bills at ₹0' : 'no price'}</span>}
                        </td>
                        {b2b && (
                          <td className="mono cell--meta" data-label="Margin" style={{
                            textAlign: 'right',
                            // A negative margin is the centre selling below what
                            // it owes the lab. It gets the danger colour because
                            // nothing else on the row says so.
                            color: l.margin != null && l.margin < 0 ? 'var(--danger)' : undefined,
                            fontWeight: l.margin != null && l.margin < 0 ? 600 : undefined,
                          }}>
                            {l.margin != null ? inr(l.margin) : '—'}
                          </td>
                        )}
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
                  {b2b ? 'Patient pays' : 'Total'} <b>{inr(preview.total)}</b>
                </span>

                {/* Stated with its basis — a bare margin figure is something
                    somebody eventually prices a contract off. */}
                {preview.margin.comparableLines > 0 && (
                  <span className="muted" style={{ fontSize: '.8rem' }}>
                    {b2b
                      ? <>Centre keeps <b>{inr(preview.margin.amount)}</b> · owes the lab{' '}
                          <b>{inr(preview.margin.rateTotal)}</b></>
                      : <>{preview.margin.amount >= 0 ? 'Discount vs MRP' : 'Above MRP'}{' '}
                          <b>{inr(Math.abs(preview.margin.amount))}</b></>}
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

              {/* ── B2B HAZARDS ────────────────────────────────────────────
                  Both are properties of the rate lists rather than mistakes,
                  so neither blocks the order — but both change what the lab
                  gets paid, and neither is visible in the total. */}
              {b2b && preview.billedAtZero > 0 && (
                <div className="alert alert--error" style={{ marginTop: '.7rem' }}>
                  <b>{preview.billedAtZero}</b> line{preview.billedAtZero === 1 ? '' : 's'} ha
                  {preview.billedAtZero === 1 ? 's' : 've'} no MRP on record. A B2B bill charges MRP,
                  so {preview.billedAtZero === 1 ? 'it' : 'they'} will go onto the bill at ₹0.
                </div>
              )}
              {b2b && preview.belowCost > 0 && (
                <div className="alert alert--info" style={{ marginTop: '.7rem' }}>
                  <b>{preview.belowCost}</b> line{preview.belowCost === 1 ? '' : 's'} price
                  {preview.belowCost === 1 ? 's' : ''} below what this client owes the lab — the
                  centre is out of pocket on {preview.belowCost === 1 ? 'it' : 'them'}. Check the
                  margin column.
                </div>
              )}

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

          {/* ---- 3. patient ---- */}
          {cart.items.length === 0 ? (
            <div className="card order-step order-step--off">
              <div className="order-step__head">
                <span className="order-step__num">3</span>
                <h2 className="order-step__title">Patient</h2>
                <span className="muted" style={{ fontSize: '.76rem' }}>
                  Add at least one test first.
                </span>
              </div>
            </div>
          ) : (
            <div className="card order-step">
              <div className="order-step__head">
                <span className="order-step__num order-step__num--on">3</span>
                <h2 className="order-step__title">Patient</h2>
              </div>

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
                         maxLength={10}
                         onChange={(e) => setPatient({ ...patient, mobile: e.target.value.replace(/\D/g, '') })} />
                  <span className="muted" style={{ fontSize: '.7rem' }}>
                    {patient.mobile.trim() !== '' && patient.mobile.trim().length !== 10
                      ? <b style={{ color: 'var(--danger)' }}>A mobile number is 10 digits — finish it or clear it.</b>
                      : 'Optional — but a patient with no mobile gets no result history on the worksheet.'}
                  </span>
                </div>
              </div>

              <div className="grid2">
                <div className="field">
                  <label htmlFor="p-email">Email</label>
                  <input id="p-email" className="input" type="email" value={patient.email} maxLength={100}
                         onChange={(e) => setPatient({ ...patient, email: e.target.value })} />
                </div>

                <div className="field">
                  <label htmlFor="p-mrn">Passport / travel ID</label>
                  {/* Written to patient_master.MRNID. Left blank, the create
                      procedure backfills the patient id, as the LIS form does. */}
                  <input id="p-mrn" className="input mono" value={patient.mrnId} maxLength={50}
                         placeholder="Optional"
                         onChange={(e) => setPatient({ ...patient, mrnId: e.target.value })} />
                </div>
              </div>

              <div className="grid2">
                <div className="field">
                  <label htmlFor="p-age-y">Age</label>
                  <div className="row" style={{ gap: '.35rem' }}>
                    <input id="p-age-y" className="input mono" value={patient.ageYears} inputMode="numeric"
                           style={{ width: 88 }} placeholder="Years" aria-label="Age in years"
                           onChange={(e) => setPatient({ ...patient, ageYears: e.target.value.replace(/\D/g, '') })} />
                    <input id="p-age-m" className="input mono" value={patient.ageMonths} inputMode="numeric"
                           style={{ width: 88 }} placeholder="Months" aria-label="Age in months"
                           onChange={(e) => setPatient({ ...patient, ageMonths: e.target.value.replace(/\D/g, '') })} />
                  </div>
                  {/* Says what will actually be stored. "2 and 6" becoming
                      "30 months" is surprising unless it is stated. */}
                  <span className="muted" style={{ fontSize: '.7rem' }}>
                    {patient.ageYears || patient.ageMonths
                      ? age
                        ? `Recorded as ${age.age} ${age.ageType === 2 ? 'month' : 'year'}${age.age === 1 ? '' : 's'}.`
                        : <b style={{ color: 'var(--danger)' }}>Not a usable age — months must be 0–11 alongside years.</b>
                      : 'Years and/or months — 6 months for an infant, 2 and 3 for a toddler.'}
                  </span>
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

              {/* Referrers. The create procedure has always accepted these —
                  an id, or a name it upserts — but nothing offered a way to
                  pick one, so every Infinity order so far was booked with
                  none. Optional in both channels here: Telo makes the doctor
                  compulsory for B2C, and adding that gate would start
                  rejecting orders this form accepts today. */}
              <div className="grid2">
                <div className="field">
                  <label>Ref. doctor</label>
                  <Combobox
                    value={refDoctor?.kind === 'existing' ? String(refDoctor.id) : ''}
                    createdName={refDoctor?.kind === 'new' ? refDoctor.name : null}
                    emptyLabel="No referring doctor"
                    options={refs.doctors.map((d) => ({
                      value: String(d.id), label: d.name, hint: d.code || null,
                    }))}
                    onChange={(v) => setRefDoctor(v === '' ? null : {
                      kind: 'existing', id: Number(v),
                      name: refs.doctors.find((d) => String(d.id) === v)?.name ?? '',
                    })}
                    creatable
                    createLabel={(t) => `Add referring doctor “${t}”`}
                    onCreate={(name) => setRefDoctor({ kind: 'new', name })}
                  />
                </div>

                <div className="field">
                  <label>Referring customer</label>
                  <Combobox
                    value={refCustomer?.kind === 'existing' ? String(refCustomer.id) : ''}
                    createdName={refCustomer?.kind === 'new' ? refCustomer.name : null}
                    emptyLabel="No referring customer"
                    options={refs.customers.map((x) => ({
                      value: String(x.id), label: x.name, hint: x.code || null,
                    }))}
                    onChange={(v) => setRefCustomer(v === '' ? null : {
                      kind: 'existing', id: Number(v),
                      name: refs.customers.find((x) => String(x.id) === v)?.name ?? '',
                    })}
                    creatable
                    createLabel={(t) => `Add referring customer “${t}”`}
                    onCreate={(name) => setRefCustomer({ kind: 'new', name })}
                  />
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
                {/* Names whichever thing is actually missing. A disabled button
                    beside "A patient name is required" when the name is filled
                    and the AGE is not is worse than no message. */}
                {!canPlace && !busy && (
                  <span className="muted" style={{ fontSize: '.76rem' }}>
                    {cart.mcc == null ? 'Choose a client to bill.'
                      : cart.items.length === 0 ? 'Add at least one test.'
                      : !patient.name.trim() ? 'A patient name is required.'
                      : age === null ? 'An age is required — years and/or months.'
                      : !mobileOk ? 'The mobile number is incomplete.'
                      : 'Some tests have no price for this client.'}
                  </span>
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

/**
 * One side of the channel choice.
 *
 * A radio rather than a toggle or a dropdown: both options carry a consequence
 * worth reading, and the difference between them is what the patient is
 * charged. A two-state switch would put one of those consequences behind an
 * interaction.
 */
function ChannelOption({ on, onPick, title, sub }: {
  on: boolean;
  onPick: () => void;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`channel__opt${on ? ' is-on' : ''}`}
      onClick={onPick}
    >
      <span className="channel__title">{title}</span>
      <span className="channel__sub">{sub}</span>
    </button>
  );
}
