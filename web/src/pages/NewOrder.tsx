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
   * Date of birth, as three boxes — the only age input there is now.
   *
   * The years-and-months pair is DERIVED from this at submit and is still what
   * goes on the wire, because the create procedure takes age + age_type and
   * knows nothing about a birth date. Nothing about the LIS side changed.
   *
   * Three strings rather than a Date, so a half-typed date stays half-typed
   * instead of silently becoming a different one: "3" in the month box must
   * not mean March until the operator has finished with it.
   */
  dobDay: string;
  dobMonth: string;
  dobYear: string;
  gender: number;
  mobile: string;
  email: string;
  /** Passport / Aadhaar ID. Written to patient_master.MRNID. */
  mrnId: string;
  clinicalHistory: string;
}

const EMPTY_PATIENT: PatientForm = {
  name: '', initial: 'Mr', dobDay: '', dobMonth: '', dobYear: '', gender: 1,
  mobile: '', email: '', mrnId: '', clinicalHistory: '',
};

/**
 * What a salutation already says about sex, so picking one fills the Sex field
 * and the operator never types the same fact twice. 1 = Male, 2 = Female, per
 * the LIS's gender codes.
 *
 * Only the unambiguous titles are mapped. Dr says nothing about sex. Baby and
 * "Baby of" name a NEWBORN whose sex the title does not carry — "Baby of
 * Meena" puts the mother's name on the patient line, and guessing the child's
 * sex from it would be wrong half the time on a value that picks reference
 * ranges. Those leave Sex exactly as it is.
 */
const TITLE_SEX: Record<string, 1 | 2> = {
  Mr: 1, Master: 1,
  Ms: 2, Mrs: 2,
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

/**
 * A date of birth, turned into the years-and-months pair the LIS stores.
 *
 * Returns null for anything that is not a real, past date — and that includes
 * 31 February, which is why this rebuilds a Date and checks the parts came
 * back unchanged. `new Date(1990, 1, 31)` is 3 March and would otherwise be
 * accepted as a birthday nobody has.
 *
 * The months figure is the remainder AFTER whole years, so it is always 0-11
 * and lands inside what resolveAge accepts. Under two years old, resolveAge
 * converts the pair to months — the LIS's own paediatric rule, unchanged.
 */
function ageFromDob(dayStr: string, monthStr: string, yearStr: string):
  { years: number; months: number } | null {
  const d = Number(dayStr.trim());
  const m = Number(monthStr.trim());
  const y = Number(yearStr.trim());
  if (dayStr.trim() === '' || monthStr.trim() === '' || yearStr.trim() === '') return null;
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return null;
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 1875 || y > 2200) return null;

  const dob = new Date(y, m - 1, d);
  // Rolled over, so the date does not exist.
  if (dob.getFullYear() !== y || dob.getMonth() !== m - 1 || dob.getDate() !== d) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (dob > today) return null;

  let years = today.getFullYear() - dob.getFullYear();
  let months = today.getMonth() - dob.getMonth();
  // Borrow a month when the day of the month has not come round yet: someone
  // born on the 30th is not a month older on the 2nd.
  if (today.getDate() < dob.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0 || years > 150) return null;

  return { years, months };
}

/** A referrer the operator picked, or a name they typed that does not exist yet. */
type RefPick = { kind: 'existing'; id: number; name: string } | { kind: 'new'; name: string } | null;

interface Referrer { id: number; code: string; name: string }

/** What the payment list starts as in each channel. See the seeding effect. */
const startingPayments = (b2b: boolean) =>
  (b2b ? [] : [{ method: 'Cash', amount: '', ref: '' }]);

/**
 * Book an order.
 *
 * ── WHO ON THE LEFT, THE ORDER ON THE RIGHT ────────────────────────────────
 * Client, then patient, directly below it; tests, barcodes and money in the
 * second column. The original layout put the patient LAST so nobody typed a
 * person out before seeing the cost — a concern that belongs to a walk-in
 * counter quoting a price, not to a hospital desk booking a batch, and the
 * desk is who this form serves all day. The price is still on screen the whole
 * time, one column over, so nothing was actually given up.
 *
 * The gates run left to right: a client unlocks the patient, any single
 * patient detail unlocks the tests, a test in the basket unlocks the money.
 * Every card is always rendered and dimmed until reachable — revealing them
 * one at a time left the page as a single card above an empty screen, which
 * read as broken rather than as "do this first".
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
  const { can, user } = useAuth();
  const mayB2b = can('order:b2b');
  /*
   * The capability alone — NOT `|| can('order:create')`.
   *
   * That fallback handed the walk-in channel to every client login, because a
   * collection centre holds order:create (they raise orders) but deliberately
   * not order:b2c. And walk-in is the channel that prices the basket at the
   * CLIENT'S OWN RATE rather than MRP — so a centre could book its own patients
   * at cost, which is the lab's counter price, not theirs. B2B is their
   * channel: the patient pays them MRP, they owe the lab the rate separately.
   *
   * Nobody legitimate loses it: order:b2c is held by super_admin, admin and
   * lab_manager, and no other role holds order:create either.
   */
  const mayB2c = can('order:b2c');

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

  /*
   * Corrected once the session is actually known.
   *
   * Two reasons to land on B2B: an account CONFINED to it, and a super admin,
   * for whom client orders are the normal day's work. Runs once, on the render
   * where the capabilities settle — so an operator who then switches to
   * Walk-in stays there rather than being flipped back under their hands.
   */
  useEffect(() => {
    if (!mayB2c && mayB2b) { setChannel('b2b'); return; }
    if (mayB2b && user?.role === 'super_admin') setChannel('b2b');
  }, [mayB2c, mayB2b, user?.role]);

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

  /*
   * Split tender, as Telo collects it: part cash, part UPI, part card.
   *
   * A list rather than one method and one amount, because that is how a
   * counter actually takes money — "₹500 cash and the rest on UPI" was
   * previously two visits to the order screen, the second one after the
   * patient had left. The procedure takes a dbo.TeloPayment TVP and prefers it
   * over the single pay mode whenever it has rows.
   */
  const [payments, setPayments] = useState<{ method: string; amount: string; ref: string }[]>([]);

  /*
   * null means "follow the channel" — shown in B2C, behind a button in B2B.
   * Once the operator opens it themselves that sticks, so switching channel
   * mid-order cannot take away a discount they have already typed.
   */
  const [discountOpen, setDiscountOpen] = useState<boolean | null>(null);
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
  const nameRef = useRef<HTMLInputElement>(null);
  /** Refocused after each add so the next test can just be typed. */
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

  /*
   * The suggestion dropdown. It used to be a results TABLE that stayed on
   * screen with the query still in the box — after adding a test the operator
   * had to select-all and retype over the old search. Now it behaves like the
   * comboboxes everywhere else on this form: pick a suggestion and the list
   * closes, the box clears, and the next test can be typed immediately.
   */
  const [suggOpen, setSuggOpen] = useState(false);
  const [suggIdx, setSuggIdx] = useState(0);
  const suggRef = useRef<HTMLDivElement>(null);

  // A list that shrinks under the cursor must not leave the cursor past its end.
  useEffect(() => { setSuggIdx(0); }, [results]);

  // Pointer-down, not click — mousedown fires before the input's blur, and a
  // click that starts inside and ends outside should not close the list.
  useEffect(() => {
    if (!suggOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!suggRef.current?.contains(e.target as Node)) setSuggOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [suggOpen]);

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

  /**
   * Add a suggestion and reset the search for the next one. The box clears
   * and keeps focus, so a panel of six tests is six type-pick pairs with no
   * mouse trip or select-all in between.
   */
  const addSuggestion = (i: CatalogItem) => {
    void act(() => cartApi.add({ kind: i.kind, id: i.id, code: i.code, name: i.name }));
    setSearch('');
    setSuggOpen(false);
    searchRef.current?.focus();
  };

  // Read off the PREVIEW, not the local state: the preview is what the server
  // actually quoted. Declared here because the payable figure below needs it.
  const isB2b = (preview?.channel ?? channel) === 'b2b';

  /*
   * Seeds a Cash line for a walk-in, when the channel settles and only while
   * the list is empty.
   *
   * A walk-in almost always pays something at the counter and cash is the
   * common case, so the line is already there and the operator just types an
   * amount. A B2B order usually settles against the centre's account later, so
   * an empty list is the honest starting point and "+ Add payment" is there
   * for when money does change hands.
   *
   * Guarded on whether an AMOUNT has been typed, not on emptiness. Guarding on
   * emptiness was wrong for the same reason the channel default was: the first
   * render is B2C before the session resolves, so a Cash line was seeded and
   * then survived the flip to B2B — the list was no longer empty, so nothing
   * took it away. Keyed on real input instead, so an untouched list snaps to
   * whichever channel is now in force, and money already entered is never
   * discarded by a channel switch.
   */
  useEffect(() => {
    setPayments((p) => (p.some((x) => x.amount.trim() !== '') ? p : startingPayments(isB2b)));
  }, [isB2b]);

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
  /** What the split lines add up to, ignoring blank rows. */
  const paidNow = payments.reduce((s, p) => s + Number(p.amount || 0), 0);

  // Shown in B2C, behind "+ Add discount" in B2B — unless it already holds a
  // value, which must never be hidden by a channel switch.
  const showDiscount = discountOpen ?? (!isB2b || discount !== '');

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
  // B2C only now. In B2B the SID fields sit inline under the selected tests —
  // the counter is holding the tubes, and a disclosure to open on every order
  // was a click that taught nobody anything. B2C keeps the collapsed panel,
  // because a walk-in's sample is usually drawn later and there is nothing to
  // scan yet.
  const showSids = sidsOpen ?? false;

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
      // Derived at the last moment from the birth date. resolveAge still owns
      // the paediatric rule — under two years old is stored in months — so the
      // LIS receives exactly what it did when this was two boxes.
      const fromDob = ageFromDob(patient.dobDay, patient.dobMonth, patient.dobYear);
      const resolved = fromDob
        ? resolveAge(String(fromDob.years), String(fromDob.months))
        : null;
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
        // Split lines go as a TVP; the scalar pair stays empty so the
        // procedure takes the TVP path and cannot receipt the money twice.
        receiptAmount: 0,
        payMode: null,
        paymentRef: null,
        payments: payments
          .map((x) => ({ method: x.method, amount: Number(x.amount || 0), ref: x.ref.trim() || null }))
          .filter((x) => x.amount > 0),

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
         * Focus the PATIENT NAME. Under the patient-first layout the next
         * order starts with the next person's name — the tests panel is
         * locked until something is typed there anyway, so aiming the cursor
         * at the search box would point it at a disabled input.
         */
        setTimeout(() => nameRef.current?.focus(), 0);
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
      // Back to the channel's starting state, not to empty — otherwise the
      // second walk-in of a run loses the Cash line the first one had.
      setDiscount(''); setDiscountOpen(null); setPayments(startingPayments(isB2b));
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

  const dobAge = ageFromDob(patient.dobDay, patient.dobMonth, patient.dobYear);
  const age = dobAge ? resolveAge(String(dobAge.years), String(dobAge.months)) : null;
  // Whether the operator has STARTED a date, which is what separates "not
  // filled in yet" from "filled in wrong". All three blank must stay silent.
  const dobStarted = patient.dobDay.trim() !== ''
    || patient.dobMonth.trim() !== ''
    || patient.dobYear.trim() !== '';
  // A half-typed number is a typo, not a phone number. Blank is fine —
  // hospital counters often have no reachable number — but six digits is
  // someone who was interrupted, and the LIS would keep it forever.
  const mobileOk = patient.mobile.trim() === '' || patient.mobile.trim().length === 10;

  /*
   * Any patient detail at all — the gate the tests panel opens on. Not
   * completeness: the operator asked for tests to unlock the moment the
   * patient is STARTED, and the Place button still enforces what an order
   * actually requires.
   *
   * A basket keeps the panel open regardless, so clearing the name to fix a
   * spelling cannot dim a card that is holding live selections.
   */
  const patientStarted = patient.name.trim() !== ''
    || dobStarted
    || patient.mobile.trim() !== '';
  const testsOn = cart.mcc != null && (patientStarted || cart.items.length > 0);

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
      {/* The channel lives in the header now, as a segmented control.
          It was a full card with two description blocks — 112px of the
          viewport spent on a two-way choice. Telo does not spend any: its
          channel is the route, and the heading states the pricing. Ours has to
          stay switchable, so it keeps the switch and moves the explanation
          into the subtitle, which was saying something the layout already
          shows ("choose a client, add tests, then enter the patient"). */}
      <div className="page__head">
        <div>
          <h1 className="page__title">New order</h1>
          <p className="page__sub">
            {isB2b
              ? 'Client order · billed at MRP, the centre keeps the margin'
              : "Walk-in · billed at this client's own rate"}
          </p>
        </div>

        {mayB2b && mayB2c && (
          <div className="seg" role="radiogroup" aria-label="Order channel"
               style={{ marginLeft: 'auto', alignSelf: 'center' }}>
            <button type="button" role="radio" aria-checked={!isB2b}
                    className={`seg__btn${!isB2b ? ' is-on' : ''}`}
                    onClick={() => setChannel('b2c')}>
              Walk-in
            </button>
            <button type="button" role="radio" aria-checked={isB2b}
                    className={`seg__btn${isB2b ? ' is-on' : ''}`}
                    onClick={() => setChannel('b2b')}>
              Client · B2B
            </button>
          </div>
        )}
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

      {/* Two real columns — see the note on the component. Left is identity,
          right is the order, and neither pushes the other around as it grows. */}
      <div className="order-grid">

      <div className="order-grid__col">

      {/* ---- 1. client ---- */}
      <div className="card order-step">
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

      {/* ---- 2. patient ----
          Directly under the client and BEFORE the tests. The person is in
          front of the operator, so their details are the first thing typed,
          and any single detail unlocks the tests on the right. The fieldset
          is what makes a dimmed card's inputs actually inert — order-step--off
          only fades them. */}
      <div className={`card order-step${cart.mcc == null ? ' order-step--off' : ''}`}>
        <div className="order-step__head">
          <span className={`order-step__num${cart.mcc != null ? ' order-step__num--on' : ''}`}>2</span>
          <h2 className="order-step__title">Patient &amp; referral</h2>
          <span className="muted" style={{ fontSize: '.76rem' }}>
            {cart.mcc == null ? 'Choose a client first.'
              : !patientStarted ? 'Any detail here unlocks the tests.' : ''}
          </span>
        </div>

        <fieldset className="bare" disabled={cart.mcc == null}>
          {/* The name owns its row. It is the longest thing typed on this form
              and was sharing with age, which left the box barely wider than the
              title select beside it. */}
            <div className="field">
              <label htmlFor="p-name">Name</label>
              <div className="row" style={{ gap: '.35rem' }}>
                <select
                  className="input" value={patient.initial} style={{ width: 96 }}
                  aria-label="Title"
                  // The title drives Sex where it can — see TITLE_SEX. Picking
                  // Mrs after Sex was set flips it, deliberately: the title is
                  // the later, more explicit statement of the same fact, and
                  // the Sex field is right there to correct on the rare
                  // occasion that is wrong.
                  onChange={(e) => {
                    const initial = e.target.value;
                    const implied = TITLE_SEX[initial];
                    setPatient({ ...patient, initial, ...(implied ? { gender: implied } : {}) });
                  }}>
                  {/* "Baby of" is the newborn convention: the MOTHER's name
                      goes on the patient line, because the child does not
                      have one yet. */}
                  {['Mr', 'Ms', 'Mrs', 'Dr', 'Master', 'Baby', 'Baby of', ''].map((t) => (
                    <option key={t || 'none'} value={t}>{t || '—'}</option>
                  ))}
                </select>
                {/* Grows into the row. Without flex it kept the width it had
                   when it was sharing the line with age, so giving it the
                   whole row changed nothing visible. */}
                <input id="p-name" ref={nameRef} className="input" value={patient.name} maxLength={200}
                       style={{ flex: 1, minWidth: 0 }}
                       onChange={(e) => setPatient({ ...patient, name: e.target.value })} />
              </div>
            </div>

          {/* Date of birth, and the age it works out to.

              A birth date is what the requisition slip carries and what the
              patient can state without arithmetic; age was being derived by
              whoever was at the counter, and a wrong subtraction is invisible
              once it is stored. The calculated age sits beside the boxes so
              the operator can see the answer agrees with the person in front
              of them before it is committed. */}
          <div className="grid2 grid2--tight">
            <div className="field">
              <label htmlFor="p-dob-d">Date of birth</label>
              <div className="row" style={{ gap: '.35rem', alignItems: 'center' }}>
                <input id="p-dob-d" className="input mono" value={patient.dobDay} inputMode="numeric"
                       maxLength={2} style={{ width: 58 }} placeholder="DD" aria-label="Day of birth"
                       onChange={(e) => setPatient({ ...patient, dobDay: e.target.value.replace(/\D/g, '') })} />
                <input id="p-dob-m" className="input mono" value={patient.dobMonth} inputMode="numeric"
                       maxLength={2} style={{ width: 58 }} placeholder="MM" aria-label="Month of birth"
                       onChange={(e) => setPatient({ ...patient, dobMonth: e.target.value.replace(/\D/g, '') })} />
                <input id="p-dob-y" className="input mono" value={patient.dobYear} inputMode="numeric"
                       maxLength={4} style={{ width: 74 }} placeholder="YYYY" aria-label="Year of birth"
                       onChange={(e) => setPatient({ ...patient, dobYear: e.target.value.replace(/\D/g, '') })} />
                {/* Live, and beside the boxes rather than under them: it is a
                    read-back of what was just typed, not a note about it.
                    aria-live so it is announced as it settles. */}
                <span className="dob-age" aria-live="polite">
                  {age ? `${age.age} ${age.ageType === 2 ? 'month' : 'year'}${age.age === 1 ? '' : 's'}` : '—'}
                </span>
              </div>
              <span className="muted" style={{ fontSize: '.7rem' }}>
                {!dobStarted
                  ? 'Day, month and year'
                  : age
                    ? `Recorded as ${age.age} ${age.ageType === 2 ? 'month' : 'year'}${age.age === 1 ? '' : 's'}.`
                    : <b style={{ color: 'var(--danger)' }}>Not a real past date — check the day, month and year.</b>}
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
              subject. */}
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
            {/* The native input is the picker and the keyboard path; the label
                is what anyone sees. See .filepick for why the input itself is
                never shown. Keyed on the file so that Remove also empties the
                BROWSER's copy — with state cleared but the FileList intact,
                re-choosing the same file fires no change event and looks like
                a dead button. */}
            <div className="filepick" key={clinicalFile?.name ?? 'none'}>
              <input
                id="p-file" type="file" accept="application/pdf"
                className="filepick__native"
                onChange={(e) => void readClinicalPdf(e.target.files?.[0] ?? null)}
              />
              <label htmlFor="p-file" className="btn btn--ghost btn--sm filepick__btn">
                {clinicalFile ? 'Replace PDF' : 'Attach PDF'}
              </label>
              {clinicalFile ? (
                <>
                  <span className="filepick__name" title={clinicalFile.name}>{clinicalFile.name}</span>
                  <button className="btn btn--ghost btn--sm"
                          onClick={() => { setClinicalFile(null); setFileError(null); }}>
                    Remove
                  </button>
                </>
              ) : (
                <span className="muted filepick__name">PDF, up to 10 MB · optional</span>
              )}
            </div>
            {fileError && (
              <span style={{ fontSize: '.72rem', color: 'var(--danger)' }}>{fileError}</span>
            )}
          </div>
          </div>

          {/* Identity, then how to reach them. Both are optional and neither
              is asked at the counter until the clinical part is done, so they
              sit at the end rather than between the patient and their tests. */}
          <div className="field">
            <label htmlFor="p-mrn">Passport / Aadhaar ID</label>
            {/* Written to patient_master.MRNID. Left blank, the create
                procedure backfills the patient id, as the LIS form does. */}
            <input id="p-mrn" className="input mono" value={patient.mrnId} maxLength={50}
                   placeholder="Optional"
                   onChange={(e) => setPatient({ ...patient, mrnId: e.target.value })} />
          </div>

          <div className="grid2">
            <div className="field">
              <label htmlFor="p-mobile">Mobile</label>
              <input id="p-mobile" className="input mono" value={patient.mobile} inputMode="numeric"
                     maxLength={10} style={{ maxWidth: 190 }}
                     onChange={(e) => setPatient({ ...patient, mobile: e.target.value.replace(/\D/g, '') })} />
              <span className="muted" style={{ fontSize: '.7rem' }}>
                {patient.mobile.trim() !== '' && patient.mobile.trim().length !== 10
                  ? <b style={{ color: 'var(--danger)' }}>A mobile number is 10 digits — finish it or clear it.</b>
                  : 'Optional · no mobile, no result history'}
              </span>
            </div>

            <div className="field">
              <label htmlFor="p-email">Email</label>
              <input id="p-email" className="input" type="email" value={patient.email} maxLength={100}
                     onChange={(e) => setPatient({ ...patient, email: e.target.value })} />
            </div>
          </div>
        </fieldset>
      </div>

      </div>{/* left column */}

      <div className="order-grid__col">

          {/* ---- 3. tests ---- */}
          <div className={`card order-step${testsOn ? '' : ' order-step--off'}`}>
            <div className="order-step__head">
              <span className={`order-step__num${testsOn ? ' order-step__num--on' : ''}`}>3</span>
              <h2 className="order-step__title">Tests</h2>
              <span className="muted" style={{ fontSize: '.76rem' }}>
                {cart.mcc == null ? 'Choose a client first.'
                  : !testsOn ? 'Enter the patient first.'
                  : cart.items.length > 0 ? `${cart.items.length} in the basket`
                  : 'Anything without a price for this client cannot be added.'}
              </span>
            </div>

            {/* One box with suggestions beneath it, like the referrer pickers:
                pick a suggestion and the list closes, the box clears, and the
                next test can be typed straight away. The old results TABLE
                stayed open with the query still in the box, so every add cost
                a select-all before the next search. */}
            <div className="field combo" ref={suggRef} style={{ marginBottom: 0 }}>
              <label htmlFor="test-search">Add tests</label>
              <input
                id="test-search" ref={searchRef} className="input"
                role="combobox"
                aria-expanded={suggOpen && search.trim() !== ''}
                aria-controls="test-sugg" aria-autocomplete="list"
                aria-activedescendant={suggOpen && results[suggIdx] ? `test-sugg-${suggIdx}` : undefined}
                placeholder={testsOn ? 'Type a test name or code…' : 'Enter the patient first'}
                autoComplete="off" spellCheck={false}
                disabled={!testsOn}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSuggOpen(true); }}
                onFocus={() => { if (search.trim()) setSuggOpen(true); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!suggOpen) { setSuggOpen(true); return; }
                    const last = results.length - 1;
                    setSuggIdx((i) => e.key === 'ArrowDown'
                      ? (i >= last ? 0 : i + 1)
                      : (i <= 0 ? last : i - 1));
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const hit = results[suggIdx];
                    if (suggOpen && hit) addSuggestion(hit);
                    return;
                  }
                  if (e.key === 'Escape') { setSuggOpen(false); return; }
                  if (e.key === 'Tab') setSuggOpen(false);
                }}
              />

              {suggOpen && search.trim() !== '' && (
                <ul className="combo__list" id="test-sugg" role="listbox">
                  {results.map((i, idx) => {
                    // A row is addable unless it is already in the basket or
                    // has no price for this client. Both stay VISIBLE — a test
                    // that silently never appears reads as "we don't do it",
                    // where the truth is "no rate is set".
                    const already = inCart(i);
                    const noPrice = i.rateSource === 'none';
                    const addable = !already && !noPrice;
                    return (
                      <li
                        key={`${i.kind}:${i.id}`}
                        id={`test-sugg-${idx}`}
                        role="option"
                        aria-selected={false}
                        aria-disabled={!addable}
                        data-active={idx === suggIdx}
                        className={`combo__opt${addable ? '' : ' combo__opt--dead'}`}
                        // pointerdown, not click: click lands after the
                        // input's blur, by which point the list is gone.
                        onPointerDown={(e) => { e.preventDefault(); if (addable) addSuggestion(i); }}
                        onPointerEnter={() => setSuggIdx(idx)}
                      >
                        <span className="combo__label">
                          {plainText(i.name) || i.code}
                          <span className="muted mono" style={{ fontSize: '.72rem' }}> {i.code}</span>
                        </span>
                        <span className="combo__hint">
                          {already ? 'already added'
                            : noPrice ? 'no price for this client'
                            : i.rate != null ? inr(i.rate) : ''}
                        </span>
                      </li>
                    );
                  })}
                  {searching && results.length === 0 && (
                    <li className="combo__empty" role="presentation">Searching…</li>
                  )}
                  {!searching && results.length === 0 && (
                    <li className="combo__empty" role="presentation">Nothing matches “{search}”.</li>
                  )}
                </ul>
              )}
            </div>

          {/* ---- the selected tests, at the prices that will bill ---- */}
          {cart.items.length > 0 && preview && (
            <div style={{ marginTop: '.9rem' }}>
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
                        {/* An icon, not the word. "Remove" repeated down the
                            column was the widest thing in it and pushed a
                            five-column table into a horizontal scroll, on the
                            panel used for every order. The label survives on
                            aria-label and the tooltip. */}
                        <td className="cart__x">
                          <button className="iconbtn"
                                  title={'Remove ' + (l.name ?? 'this line')}
                                  aria-label={'Remove ' + (l.name ?? 'this line')}
                                  onClick={() => void act(() => cartApi.remove(l.kind, l.id))}>
                            ×
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

              {/* The tubes this order will need. B2C only — in B2B the SID
                  fields themselves are on screen just below, each named for
                  its tube, and this line would say the same thing twice. */}
              {!b2b && preview.groups.length > 0 && (
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

          {/* ---- barcodes, beside the tests they label ----
              One barcode per TUBE, not per test: several tests usually share
              a tube — T3, T4 and TSH are one serum draw — and the LIS accepts
              exactly one label for it. A box on every test row would collect
              three barcodes where one is wanted, which is why these are
              grouped, each field naming its tube and the tests in it.

              B2B: inline and always on screen, because the counter is holding
              the tubes and the sticker sheet right now, and a disclosure to
              open on every order taught nobody anything. B2C keeps the
              collapsed panel — a walk-in's sample is usually drawn later and
              there is nothing to scan yet. */}
          {b2b && groups.length > 0 && (
            <div className="sid-inline">
              <h3 className="sid-inline__title">
                Sample IDs <span className="muted">· one per tube · blank ones attach later on Accessioning</span>
              </h3>
              {groups.map((g) => (
                <SidField
                  key={g.sampleTypeId}
                  group={g}
                  value={sids[g.sampleTypeId] ?? ''}
                  status={sidStatus[g.sampleTypeId] ?? 'idle'}
                  dupInForm={dupSid(sids[g.sampleTypeId] ?? '')}
                  onChange={(v) => setSids((s) => ({ ...s, [g.sampleTypeId]: v }))}
                  onStatus={(st) => setSidStatus((s) => (
                    s[g.sampleTypeId] === st ? s : { ...s, [g.sampleTypeId]: st }))}
                />
              ))}
            </div>
          )}

          {!b2b && groups.length > 0 && (
            <div className="sid-panel" style={{ marginTop: '1rem' }}>
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
                  Leave blank to barcode later on <b>Accessioning</b>. Either way they still
                  need registering.
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
                    // the cursor out of whatever they are typing.
                    autoFocus={i === 0 && sidsOpen === true}
                    onChange={(v) => setSids((s) => ({ ...s, [g.sampleTypeId]: v }))}
                    onStatus={(st) => setSidStatus((s) => (
                      s[g.sampleTypeId] === st ? s : { ...s, [g.sampleTypeId]: st }))}
                  />
                ))}
              </div>
            </div>
          )}
          </div>

          {/* ---- 4. payment ----

               B2B collects nothing here. A client order is settled later, in
               bulk, against the centre's wallet, so there is no money to take
               at the counter and no discount to type: the bill states what is
               owed and the ledger does the rest. The whole step becomes a line
               saying so, rather than a disabled control that reads as
               something someone forgot to fill in.

               The server strips these fields for B2B whatever is posted (see
               PlaceOrder) — hiding them is the courtesy, not the control. */}
          {isB2b ? (
            <div className="card order-step">
              <div className="order-step__head">
                <span className="order-step__num order-step__num--on">4</span>
                <h2 className="order-step__title">Payment</h2>
              </div>
              <p className="muted" style={{ fontSize: '.82rem', margin: 0 }}>
                Nothing is collected on a client order. The bill records what is
                owed, and it is settled later against the centre's account.
              </p>
            </div>
          ) : (
          <div className={`card order-step${cart.items.length > 0 ? '' : ' order-step--off'}`}>
            <div className="order-step__head">
              <span className={`order-step__num${cart.items.length > 0 ? ' order-step__num--on' : ''}`}>4</span>
              <h2 className="order-step__title">Payment</h2>
              {cart.items.length === 0 && (
                <span className="muted" style={{ fontSize: '.76rem' }}>
                  Add at least one test.
                </span>
              )}
            </div>

            {cart.items.length > 0 && (
              <>

              {/* ---- money taken at the counter ----
                  Every field here already existed on the create procedure and
                  Infinity sent zeros for all of them, so an order could be
                  booked but not paid for. Left blank it still sends zeros and
                  behaves exactly as before. The card supplies the title now,
                  so the fieldset and its legend went with the move. */}
              <div>
                {/* B2C keeps the box on show; B2B hides it behind a button.
                    A discount on a B2B bill is the exception — that bill is
                    the patient's at MRP and the centre's margin is the thing
                    being adjusted — whereas at a walk-in counter it is
                    everyday. An empty box on every B2B order is a field to
                    skip past a hundred times a day. */}
                {showDiscount ? (
                  <label className="field" style={{ maxWidth: '11rem' }}>
                    <span>Discount ₹</span>
                    <input className="input mono" inputMode="numeric" placeholder="0" autoFocus={isB2b}
                           value={discount}
                           onChange={(e) => setDiscount(e.target.value.replace(/\D/g, ''))} />
                  </label>
                ) : (
                  <button className="btn btn--ghost btn--sm" style={{ marginBottom: '.4rem' }}
                          onClick={() => setDiscountOpen(true)}>
                    + Add discount
                  </button>
                )}

                {/* Split tender. One row per method, as Telo collects it —
                    "₹500 cash and the rest on UPI" is one transaction at the
                    counter, and it used to take two visits to the order screen
                    with the second one after the patient had gone. */}
                {payments.map((p, i) => (
                  <div className="payline" key={i}>
                    <select className="input" aria-label="Method" value={p.method}
                            onChange={(e) => setPayments((ps) =>
                              ps.map((x, n) => (n === i ? { ...x, method: e.target.value } : x)))}>
                      {PAYMENT_MODES.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
                    </select>

                    <input className="input mono" inputMode="numeric" placeholder="0"
                           aria-label="Amount" value={p.amount}
                           onChange={(e) => setPayments((ps) => ps.map((x, n) =>
                             (n === i ? { ...x, amount: e.target.value.replace(/\D/g, '') } : x)))} />

                    {/* Cash has no reference to keep, so the box goes away
                        rather than sitting there inviting one. */}
                    {p.method !== 'Cash' ? (
                      <input className="input" placeholder="UTR, slip no…" maxLength={50}
                             aria-label="Reference" value={p.ref}
                             onChange={(e) => setPayments((ps) => ps.map((x, n) =>
                               (n === i ? { ...x, ref: e.target.value } : x)))} />
                    ) : <span />}

                    <button className="btn btn--ghost btn--sm" aria-label="Remove this payment"
                            onClick={() => setPayments((ps) => ps.filter((_, n) => n !== i))}>
                      Remove
                    </button>
                  </div>
                ))}

                <div className="row" style={{ gap: '.6rem', marginTop: '.35rem', flexWrap: 'wrap' }}>
                  <button className="btn btn--ghost btn--sm"
                          onClick={() => setPayments((ps) => [...ps,
                            { method: 'Cash', amount: '', ref: '' }])}>
                    + Add payment
                  </button>
                  {paidNow > 0 && (
                    <span className="muted" style={{ fontSize: '.76rem' }}>
                      Taking <b>{inr(paidNow)}</b> of {inr(payable)}
                      {paidNow > payable && ' — more than the bill'}
                      {paidNow < payable && ` · ${inr(payable - paidNow)} left to pay`}
                    </span>
                  )}
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
              </div>

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
              </>
            )}
          </div>
          )}

      </div>{/* right column */}

      </div>{/* the grid */}

      {busy && <div className="center" style={{ marginTop: '1rem' }}><InfinityLoader /></div>}
    </div>
  );
}
