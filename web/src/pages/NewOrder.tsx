import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, cartApi, catalogApi, PAYMENT_MODES,
  type Cart, type CatalogItem, type OrderChannel, type OrderPreview, type PlacedOrder,
} from '../api/client';
import { inr, plainText } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { ClientPicker } from '../components/ClientPicker';
import { useAuth } from '../auth/AuthContext';
import { RateSourceBadge } from './Catalogue';
import { Combobox } from '../components/Combobox';
import { SidField, type SidStatus } from '../components/SidField';

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
 * ── BARCODES ARE OPTIONAL HERE, AND THAT IS A CHANGE ──────────────────────
 * This screen used to collect no barcodes at all, on the reasoning that an
 * order is booked first and accessioned when the tubes physically arrive —
 * which may be hours later and is somebody else's job; see the Accessioning
 * screen. That is right for a collection centre, and it is wrong for a hospital
 * counter, where the person taking the order is holding the tubes and the
 * sticker sheet while they type. Telo reached the same conclusion and opens its
 * SID panel by default for B2B.
 *
 * So the panel is offered, defaults open in B2B and closed in B2C, and every
 * field in it may be left blank. Nothing about accessioning changed: an order
 * booked with barcodes simply arrives at the NEXT queue instead of the first
 * one — usp_inf_pending_accessions selects orders still short of a tube, and
 * usp_inf_pending_registrations selects samples at status 1, which is what a
 * barcode attached here creates. An order can also be part-barcoded, and it
 * then appears in both queues, correctly.
 *
 * The confirmation below says which of those happened rather than asserting,
 * as it used to, that the order has no Sample IDs.
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

  /*
   * Sample IDs, keyed by sample type. Optional — see the note on the component.
   *
   * Keyed rather than a list so a tube keeps its barcode when the basket
   * changes shape around it: adding a test that needs a new tube must not
   * renumber the ones already scanned.
   */
  const [sids, setSids] = useState<Record<number, string>>({});
  const [sidStatus, setSidStatus] = useState<Record<number, SidStatus>>({});

  /*
   * Money taken at the counter, and the Gold Card.
   *
   * The create procedure has accepted all of this since Telo wrote it —
   * @discountAmount, @receiptAmount, @payMode, @paymentRef, @goldCard — and
   * Infinity sent hard-coded zeros for every one. A counter could book an
   * order but not take a rupee for it, and the patient had to be sent to the
   * order screen afterwards to pay for what they were standing at the desk to
   * pay for.
   */
  const [discount, setDiscount] = useState('');
  const [receipt, setReceipt] = useState('');
  const [payMode, setPayMode] = useState<number | ''>('');
  const [paymentRef, setPaymentRef] = useState('');
  const [gold, setGold] = useState(false);
  const [goldNumber, setGoldNumber] = useState('');
  const [goldHolder, setGoldHolder] = useState('');

  /** The clinical-history attachment, held as base64 for the JSON body. */
  const [clinicalFile, setClinicalFile] = useState<{ name: string; base64: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  /**
   * Orders booked in this sitting, newest first. B2B only — see place().
   *
   * Deliberately not persisted and not re-fetched: it is a record of what THIS
   * person has just done, which is a different question from "what is on the
   * accessioning queue" and is answered by that screen. Reloading the page
   * clears it, correctly — the run is over.
   */
  const [session, setSession] = useState<{
    billId: number | null; billNumber: number | null;
    patient: string; total: number; sids: number; tubes: number;
  }[]>([]);

  /** Focused after each B2B booking so the next patient can just be typed. */
  const searchRef = useRef<HTMLInputElement>(null);

  /*
   * null means "follow the channel". Once the operator opens or closes the
   * panel themselves that choice sticks, which an effect keyed on the channel
   * could not do — it would reopen the panel under someone who had just shut
   * it every time the preview re-quoted.
   */
  const [sidsOpen, setSidsOpen] = useState<boolean | null>(null);

  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  /** What the order that was just placed went out with, for the confirmation. */
  const [placedSids, setPlacedSids] = useState({ attached: 0, required: 0 });

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
  // actually quoted. Declared here because the payable figure below needs it.
  const isB2b = (preview?.channel ?? channel) === 'b2b';

  /*
   * What the bill will actually come to.
   *
   * Mirrors the procedure's order of operations: the Gold Card halves every
   * line at the source FIRST, then the discount comes off what is left. Doing
   * it the other way round would quote a different number from the one that
   * gets billed, which is the whole failure this figure exists to prevent.
   *
   * The card only counts once both its fields are filled — the procedure
   * requires them too, so a half-entered card is not yet a reduction.
   */
  const goldOk = gold && !isB2b && goldNumber.trim() !== '' && goldHolder.trim() !== '';
  const payable = Math.max(
    0,
    Math.round((preview?.total ?? 0) * (goldOk ? 0.5 : 1)) - Number(discount || 0),
  );

  /**
   * Read the chosen PDF into base64 for the order body.
   *
   * Checked here as well as at the API, because the operator should learn the
   * file is too big while they are still looking at the picker, not after
   * filling in a patient and pressing Place order.
   */
  async function readClinicalPdf(file: File | null) {
    setFileError(null);
    if (!file) { setClinicalFile(null); return; }
    if (file.size > 10 * 1024 * 1024) {
      setClinicalFile(null);
      setFileError('That PDF is larger than 10 MB.');
      return;
    }
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error('read failed'));
        // A data URL, whose prefix the API strips — FileReader has no
        // bare-base64 mode and slicing it here would just move the same work.
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(file);
      });
      setClinicalFile({ name: file.name, base64 });
    } catch {
      setFileError('That file could not be read.');
    }
  }

  // Same value as isB2b above, kept under the name the table markup already
  // uses so the two cannot drift apart.
  const b2b = isB2b;

  // ---- sample ids ----
  // The tubes the server says this basket needs. Read off the preview for the
  // same reason the price table is: it is the quote that will be billed.
  const groups = preview?.groups ?? [];
  const showSids = sidsOpen ?? b2b;

  /*
   * Only barcodes for tubes the CURRENT basket needs. Removing a test can
   * remove a tube, and its barcode stays in state — deliberately, so re-adding
   * the test brings it back — but sending it would offer the create procedure a
   * label for a tube the order does not need, which it rejects outright.
   */
  const enteredSids = groups
    .map((g) => ({ sampleTypeId: g.sampleTypeId, vailid: (sids[g.sampleTypeId] ?? '').trim() }))
    .filter((s) => s.vailid !== '');

  // The same sticker on two tubes. The server cannot see this — neither barcode
  // exists yet, so both come back free — and it is the likelier mistake, since
  // the labels are being peeled off one sheet.
  const sidCounts = new Map<string, number>();
  for (const s of enteredSids) sidCounts.set(s.vailid, (sidCounts.get(s.vailid) ?? 0) + 1);
  const dupSid = (v: string) => v.trim() !== '' && (sidCounts.get(v.trim()) ?? 0) > 1;

  const sidTaken = enteredSids.some((s) => sidStatus[s.sampleTypeId] === 'taken' || dupSid(s.vailid));
  // A check still in flight blocks for the half-second it takes. Letting it
  // through would trade a disabled button for a rejected order.
  const sidChecking = enteredSids.some((s) => sidStatus[s.sampleTypeId] === 'checking');

  async function place() {
    if (cart.mcc == null) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = resolveAge(patient.ageYears, patient.ageMonths);
      const result = await cartApi.place({
        mcc: cart.mcc,
        items: cart.items,
        // Whatever the operator scanned, which may be none, some or all of the
        // tubes. Anything left blank is attached later on Accessioning.
        sampleSids: enteredSids,
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
        discountAmount: Number(discount || 0),
        receiptAmount: Number(receipt || 0),
        payMode: payMode === '' ? null : payMode,
        paymentRef: paymentRef.trim() || null,

        // The API ignores these on a B2B order; sent as typed so the request
        // says what the operator asked for and the server decides.
        goldCard: gold,
        goldCardNumber: gold ? goldNumber.trim() || null : null,
        goldCardHolder: gold ? goldHolder.trim() || null : null,

        clinicalFileBase64: clinicalFile?.base64 ?? null,
        clinicalFileName: clinicalFile?.name ?? null,
        // The API derives billAtMrp from the channel after checking the
        // capability, and ignores anything sent here — so the channel is the
        // only thing worth sending.
        channel,
        billAtMrp: false,
      });
      // Captured before the reset below, because the confirmation describes
      // what was just placed and the form is about to stop being that order.
      setPlacedSids({ attached: enteredSids.length, required: groups.length });

      /*
       * ── B2B BOOKS IN A RUN, B2C BOOKS ONE ────────────────────────────────
       * A centre sends a batch: one client, many patients, back to back. Taking
       * the operator to a full-page confirmation after each one and making them
       * find their way back — and re-pick the client — costs more than the
       * booking did. So B2B stacks: the order joins a list on this screen and
       * the form is immediately ready for the next patient, with the client
       * still selected.
       *
       * B2C is a walk-in at a counter, one person in front of you, and the
       * confirmation with its barcodes is the thing you act on next. It keeps
       * the full-page receipt.
       */
      if (isB2b) {
        setSession((s) => [{
          billId: result.billId, billNumber: result.billNumber,
          patient: patient.name.trim(), total: result.total,
          sids: enteredSids.length, tubes: groups.length,
        }, ...s]);
        /*
         * Focus the TEST SEARCH, not the patient name.
         *
         * Placing empties the basket, and with no tests the patient step
         * correctly falls back to its disabled state — so the name field the
         * cursor was aimed at no longer exists. The real next action is the
         * first one of the next order: search a test.
         */
        setTimeout(() => searchRef.current?.focus(), 0);
      } else {
        setPlaced(result);
      }

      setCart({ mcc: cart.mcc, items: [] });
      setPatient(EMPTY_PATIENT);
      setRefDoctor(null);
      setRefCustomer(null);
      setPreview(null);
      // Money and the attachment are per-order for the same reason the
      // barcodes are: carrying a receipt into the next patient would take
      // their money twice.
      setDiscount(''); setReceipt(''); setPayMode(''); setPaymentRef('');
      setGold(false); setGoldNumber(''); setGoldHolder('');
      setClinicalFile(null); setFileError(null);
      // Barcodes are per-order and must never carry into the next one — the
      // create procedure would reject the second use, but only after the
      // operator had typed out another patient.
      setSids({});
      setSidStatus({});
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
    // Barcodes are optional, but a barcode that is WRONG is not — the create
    // procedure would reject the order after the operator had typed all of it.
    && !sidTaken
    && !sidChecking
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
          {/* What happens next depends on how much was barcoded, and saying the
              wrong one sends the operator to a queue the order is not in. */}
          <p className="muted" style={{ fontSize: '.84rem', lineHeight: 1.7, marginTop: '.6rem' }}>
            {placedSids.attached === 0 ? (
              <>
                This order is <b>not on the worksheet yet</b>. It has no Sample IDs, so the lab cannot
                see it. Attach barcodes on the <b>Accessioning</b> screen when the tubes arrive — that
                is what puts it in front of the bench.
              </>
            ) : placedSids.attached < placedSids.required ? (
              <>
                <b>{placedSids.attached} of {placedSids.required}</b> tubes are barcoded. This order is{' '}
                <b>not on the worksheet yet</b>: the barcoded tubes are waiting to be registered, and the
                rest still need labels. Both are on the <b>Accessioning</b> screen.
              </>
            ) : (
              <>
                All <b>{placedSids.attached}</b> tube{placedSids.attached === 1 ? '' : 's'} are barcoded.
                This order is <b>not on the worksheet yet</b> — the samples still have to be registered,
                which is what receives them into the lab. Do that on the <b>Accessioning</b> screen, under{' '}
                <b>Awaiting registration</b>.
              </>
            )}
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

      {/* ── ONE SCREEN, TWO COLUMNS ──────────────────────────────────────────
          Measured at 1366×768 the form ran to 1586px — 2.07 viewports — so
          booking an order meant scrolling twice and losing sight of the basket
          while typing the patient.

          A flex column that WRAPS, rather than a two-column grid: grid rows
          are shared across columns, so a 98px channel card beside a 138px
          tests card leaves 40px of dead space under the shorter one, and every
          row compounds it. Wrapping flow packs each column independently and
          balances itself when a card's height changes — which it does, every
          time a test is added to the basket.

          The height cap is what makes it wrap at all. Below the breakpoint the
          cap is removed and it becomes the single column it always was. */}
      {/* Booked in this run. Sits above the form because it is the answer to
          "did that go through" — the question asked between one patient and
          the next — and it must not push the form down as the run grows,
          hence the fixed height and its own scroll. */}
      {session.length > 0 && (
        <div className="card runlist">
          <div className="runlist__head">
            <b>{session.length}</b> booked this run
            <span className="muted">
              · {inr(session.reduce((s, o) => s + o.total, 0))} · client still selected
            </span>
            <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                    onClick={() => setSession([])}>
              Clear list
            </button>
          </div>
          <ol className="runlist__rows">
            {session.map((o, i) => (
              <li key={`${o.billId}-${i}`}>
                <span className="mono">{o.billNumber ?? o.billId}</span>
                <span className="runlist__name">{o.patient || 'Unnamed'}</span>
                <span className="muted">
                  {o.sids} of {o.tubes} tube{o.tubes === 1 ? '' : 's'}
                </span>
                <span className="mono">{inr(o.total)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="order-flow">

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
            Sets every price.
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
              Changing it empties the basket.
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
                Choose a client first.
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
              <input id="test-search" ref={searchRef} className="input" placeholder="Search by name or code…"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            {search.trim() && (
              <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table>
                  <tbody>
                    {searching && results.length === 0 && (
                      <tr><td className="muted" style={{ padding: '1rem' }}>Searching…</td></tr>
                    )}
                    {results.map((i) => {
                      // A row is addable unless it is already in the basket or
                      // has no price for this client.
                      const already = inCart(i);
                      const noPrice = i.rateSource === 'none';
                      const addable = !already && !noPrice;

                      const add = () => {
                        if (!addable) return;
                        void act(() => cartApi.add(
                          { kind: i.kind, id: i.id, code: i.code, name: i.name }));
                      };

                      return (
                        <tr
                          key={`${i.kind}:${i.id}`}
                          // The whole row is the target. Picking tests is the
                          // most repeated action on this screen, and a 60px
                          // button at the far right of a 1300px row is a long
                          // way to travel for something the eye already
                          // selected by reading the name.
                          onClick={add}
                          // Reachable without a mouse: the row takes focus and
                          // answers Enter/Space, which is what a button did for
                          // free and must not be lost by moving the handler up.
                          tabIndex={addable ? 0 : -1}
                          role={addable ? 'button' : undefined}
                          aria-disabled={!addable}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); }
                          }}
                          className={`pick-row${addable ? '' : ' pick-row--off'}`}
                          title={noPrice ? 'No price for this client'
                               : already ? 'Already in the basket'
                               : 'Click to add'}
                        >
                          <td>
                            {plainText(i.name) || i.code}
                            <span className="muted mono" style={{ fontSize: '.72rem' }}> {i.code}</span>
                          </td>
                          <td style={{ width: 110, textAlign: 'right' }} className="mono">
                            {i.rate != null ? inr(i.rate) : <span className="muted">no price</span>}
                          </td>
                          <td style={{ width: 90 }}><RateSourceBadge source={i.rateSource} /></td>
                          <td style={{ width: 90, textAlign: 'right' }}>
                            {/* Kept as an affordance, not the only way in: it
                                is what tells a first-time user the row does
                                anything. stopPropagation so the row handler
                                does not also fire and double-add. */}
                            <button
                              className="btn btn--ghost btn--sm"
                              disabled={!addable}
                              tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); add(); }}
                            >
                              {already ? 'Added' : 'Add'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
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
            /* Two cards now, not one — the patient's details and the
               transaction that finishes the order. See the split below. */
            <>
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
                      : 'Optional · no mobile, no result history'}
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
                      : 'Years and/or months'}
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

              {/* Paired: the typed history and the letter it came from are one
                  subject, and stacked they were the two tallest rows on the
                  card — 152px between them for two inputs. */}
              <div className="grid2">
              <div className="field">
                <label htmlFor="p-hist">Clinical history</label>
                <input id="p-hist" className="input" value={patient.clinicalHistory} maxLength={500}
                       onChange={(e) => setPatient({ ...patient, clinicalHistory: e.target.value })} />
              </div>

              {/* The referral letter itself. Telo has carried this since its
                  B2B form shipped; the procedure files it against the patient
                  in tbl_med_mcc_patient_clinicaldata tagged 'HISTORY', so it
                  travels with the order rather than living in someone's inbox. */}
              <div className="field">
                <label htmlFor="p-file">Clinical history PDF</label>
                <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
                  <input
                    id="p-file" type="file" accept="application/pdf"
                    onChange={(e) => void readClinicalPdf(e.target.files?.[0] ?? null)}
                  />
                  {clinicalFile && (
                    <button className="btn btn--ghost btn--sm"
                            onClick={() => { setClinicalFile(null); setFileError(null); }}>
                      Remove
                    </button>
                  )}
                </div>
                {fileError
                  ? <span style={{ fontSize: '.72rem', color: 'var(--danger)' }}>{fileError}</span>
                  : <span className="muted" style={{ fontSize: '.72rem' }}>
                      PDF, up to 10 MB
                      {clinicalFile && ` · ${clinicalFile.name} attached`}
                    </span>}
              </div>
              </div>

            </div>

            {/* ---- finish: barcodes, money, place ----
                Its own card rather than the tail of the patient card, because
                the patient card alone measured 777px — more than a 768px
                laptop can give one column, so no arrangement of whole cards
                could ever fit the form on one screen. Split here because this
                is where the subject changes: everything above describes the
                person, everything below settles the transaction. */}
            <div className="card order-step">
              <div className="order-step__head">
                <span className="order-step__num order-step__num--on">4</span>
                <h2 className="order-step__title">Barcodes &amp; payment</h2>
              </div>

              {/* Sample IDs. Open by default in B2B, where the counter is
                  holding the tubes; collapsed in B2C, where the sample is
                  drawn later and there is nothing to scan yet. */}
              {groups.length > 0 && (
                <div className="sid-panel">
                  <button
                    type="button"
                    className="sid-panel__head"
                    aria-expanded={showSids}
                    aria-controls="sid-panel-body"
                    onClick={() => setSidsOpen(!showSids)}
                  >
                    <svg className="sid-panel__caret" viewBox="0 0 24 24" aria-hidden="true" fill="none"
                         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                    <span className="sid-panel__title">Sample IDs</span>
                    <span className="sid-panel__count">
                      {/* Counts what is typed, not what is valid — the fields
                          below say which ones are a problem. */}
                      {enteredSids.length} of {groups.length} tube
                      {groups.length === 1 ? '' : 's'}
                      {enteredSids.length === 0 ? ' · optional' : ''}
                    </span>
                  </button>

                  <div className="sid-panel__body" id="sid-panel-body"
                       style={showSids ? undefined : { display: 'none' }}>
                    <p className="muted" style={{ fontSize: '.76rem', margin: 0, lineHeight: 1.6 }}>
                      Scan the barcodes now if you have the tubes. Leave any blank and they can be
                      attached later on the <b>Accessioning</b> screen — either way the samples still
                      have to be registered before the lab sees them.
                    </p>

                    {groups.map((g, i) => (
                      <SidField
                        key={g.sampleTypeId}
                        group={g}
                        value={sids[g.sampleTypeId] ?? ''}
                        status={sidStatus[g.sampleTypeId] ?? 'idle'}
                        dupInForm={dupSid(sids[g.sampleTypeId] ?? '')}
                        // Only when the operator opened it themselves. Stealing
                        // focus into a panel that opened on its own would move
                        // the cursor out of the patient name they are typing.
                        autoFocus={i === 0 && sidsOpen === true}
                        onChange={(v) => setSids((s) => ({ ...s, [g.sampleTypeId]: v }))}
                        onStatus={(st) => setSidStatus((s) => (
                          s[g.sampleTypeId] === st ? s : { ...s, [g.sampleTypeId]: st }))}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* ---- money taken at the counter ----
                  Every field here already existed on the create procedure and
                  Infinity sent zeros for all of them, so an order could be
                  booked but not paid for. Left blank it still sends zeros and
                  behaves exactly as before. */}
              <fieldset className="fgroup" style={{ marginTop: '1.2rem' }}>
                <legend>Payment</legend>
                <div className="fgroup__grid fgroup__grid--narrow">
                  <label className="field">
                    <span>Discount ₹</span>
                    <input className="input mono" inputMode="numeric" placeholder="0"
                           value={discount}
                           onChange={(e) => setDiscount(e.target.value.replace(/\D/g, ''))} />
                  </label>

                  <label className="field">
                    <span>Paying now ₹</span>
                    <input className="input mono" inputMode="numeric" placeholder="0"
                           value={receipt}
                           onChange={(e) => setReceipt(e.target.value.replace(/\D/g, ''))} />
                  </label>

                  <label className="field">
                    <span>Pay mode</span>
                    <select className="input" value={payMode}
                            onChange={(e) => setPayMode(e.target.value === '' ? '' : Number(e.target.value))}>
                      <option value="">Not specified</option>
                      {PAYMENT_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </label>

                  <label className="field">
                    <span>Reference</span>
                    <input className="input" placeholder="UTR, card slip…" maxLength={100}
                           value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} />
                  </label>
                </div>

                {/* B2C only. A B2B bill is the patient's at MRP and the
                    centre's margin is not the lab's to halve — the procedure
                    ignores the card there, so offering it would be a control
                    that silently does nothing. */}
                {!b2b && (
                  <div style={{ marginTop: '.8rem' }}>
                    <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer' }}>
                      <input type="checkbox" checked={gold}
                             onChange={(e) => setGold(e.target.checked)} />
                      Gold Card — charge the whole bill at 50%
                    </label>

                    {gold && (
                      <div className="fgroup__grid fgroup__grid--narrow" style={{ marginTop: '.6rem' }}>
                        <label className="field">
                          <span>Card number</span>
                          <input className="input mono" maxLength={50} value={goldNumber}
                                 onChange={(e) => setGoldNumber(e.target.value)} />
                        </label>
                        <label className="field">
                          <span>Card holder</span>
                          <input className="input" maxLength={200} value={goldHolder}
                                 onChange={(e) => setGoldHolder(e.target.value)} />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              <div className="row" style={{ marginTop: '.9rem' }}>
                <button className="btn btn--primary" disabled={!canPlace} onClick={() => void place()}>
                  {busy ? 'Placing…' : `Place order · ${inr(payable)}`}
                </button>
                {/* Only when the button's figure is no longer the basket total,
                    so the operator can see WHY. Without this the button quietly
                    said ₹70 while the bill came out at ₹35. */}
                {!busy && payable !== (preview?.total ?? 0) && (
                  <span className="muted" style={{ fontSize: '.76rem' }}>
                    {inr(preview?.total ?? 0)}
                    {gold && goldOk && ' less 50% Gold Card'}
                    {Number(discount || 0) > 0 && ` less ${inr(Number(discount))} discount`}
                  </span>
                )}
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
                      : sidTaken ? 'A Sample ID is already in use — see the barcodes above.'
                      : sidChecking ? 'Still checking a Sample ID…'
                      : 'Some tests have no price for this client.'}
                  </span>
                )}
              </div>
            </div>
            </>
          )}
        </>
      )}

      </div>

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
