import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ClientPicker } from '../components/ClientPicker';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * What a client's invoice says about the lab.
 *
 * ── THIS EDITS A TABLE TELO PRINTS FROM ────────────────────────────────────
 * The branding record is shared. Saving here changes the document Telo
 * produces for the same client, immediately. That is the intent — one record,
 * two front ends, no drift while both are live — but it is worth the operator
 * knowing, so the page says it rather than leaving it to be discovered.
 *
 * The three toggles are TRI-STATE and "Auto" is not a synonym for off. Auto
 * means "whatever this client's default is", which differs for MEDICARE, and
 * nearly every client is on Auto today. A checkbox would have collapsed three
 * states into two and quietly turned Auto into Off the first time anybody
 * opened a client and pressed Save — which is how the disclaimer would
 * disappear from a few thousand invoices in one afternoon.
 *
 * Logos are NOT here. The same table carries the uploaded logo and header
 * layout; Infinity has no logo editor and its invoice does not draw one, so
 * this screen leaves that block alone and says where it lives.
 */

interface InvoiceConfig {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  heading: string;
  labName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  preparedBy: string | null;
  hasConfig: boolean;
  flags: { onBehalf: 'client' | 'qugen'; showDisclaimer: boolean; showSignatory: boolean };
}

/** The form's own shape: nulls become empty strings, tri-states stay tri-state. */
interface Draft {
  labName: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  preparedBy: string;
  onBehalf: '' | 'client' | 'qugen';
  showDisclaimer: '' | 'on' | 'off';
  showSignatory: '' | 'on' | 'off';
}

const EMPTY: Draft = {
  labName: '', address: '', city: '', state: '', pincode: '', phone: '', email: '',
  preparedBy: '', onBehalf: '', showDisclaimer: '', showSignatory: '',
};

/**
 * The saved row, as a form.
 *
 * Binds to `stored` — the raw config values — NEVER to the resolved ones on
 * `config`, even though those are what the invoice prints.
 *
 * The resolved value of a field is the config's OR the LIS's. Rendering that
 * into a text box would present the LIS's own address as though somebody had
 * typed it, and the next Save would copy it into the config row, which then
 * stops tracking the LIS — for every field the operator never touched. Same
 * for the toggles: a resolved "Show" saved back becomes an explicit true, and
 * the client stops following its default forever.
 *
 * So stored values fill the boxes and resolved values are the PLACEHOLDER.
 * Blank therefore means what it says: fall back.
 */
function toDraft(stored: Stored): Draft {
  return {
    labName: stored.labName ?? '',
    address: stored.address ?? '',
    city: stored.city ?? '',
    state: stored.state ?? '',
    pincode: stored.pincode ?? '',
    phone: stored.phone ?? '',
    email: stored.email ?? '',
    preparedBy: stored.preparedBy ?? '',
    onBehalf: stored.onBehalf ?? '',
    showDisclaimer: stored.showDisclaimer === true ? 'on' : stored.showDisclaimer === false ? 'off' : '',
    showSignatory: stored.showSignatory === true ? 'on' : stored.showSignatory === false ? 'off' : '',
  };
}

interface Stored {
  labName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  preparedBy: string | null;
  onBehalf: 'client' | 'qugen' | null;
  showDisclaimer: boolean | null;
  showSignatory: boolean | null;
}

interface ConfigResponse {
  config: InvoiceConfig;
  stored: Stored;
  disclaimer: string;
}

export function InvoiceConfigPage() {
  const [mcc, setMcc] = useState<number | null>(null);
  const [config, setConfig] = useState<InvoiceConfig | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [disclaimer, setDisclaimer] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((r: ConfigResponse) => {
    setConfig(r.config);
    setDraft(toDraft(r.stored));
    setDisclaimer(r.disclaimer);
  }, []);

  useEffect(() => {
    setSaved(null);
    setError(null);
    if (mcc == null) { setConfig(null); setDraft(EMPTY); return; }

    let live = true;
    setLoading(true);
    api
      .get<ConfigResponse>(`/api/invoice-config/${mcc}`)
      .then((r) => { if (live) apply(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this client.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [mcc, apply]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(null);
  };

  async function save() {
    if (mcc == null) return;
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const r = await api.put<ConfigResponse>(`/api/invoice-config/${mcc}`, {
        labName: draft.labName,
        address: draft.address,
        city: draft.city,
        state: draft.state,
        pincode: draft.pincode,
        phone: draft.phone,
        email: draft.email,
        preparedBy: draft.preparedBy,
        // '' is Auto, which the API stores as NULL.
        onBehalf: draft.onBehalf || null,
        showDisclaimer: draft.showDisclaimer === '' ? null : draft.showDisclaimer === 'on',
        showSignatory: draft.showSignatory === '' ? null : draft.showSignatory === 'on',
      });
      apply(r);
      setSaved('Saved. This is what both Infinity and Telo will print for this client.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page">
      <header className="page__head">
        <div>
          <h1>Invoice branding</h1>
          <p className="muted" style={{ fontSize: '.82rem', marginTop: '.2rem' }}>
            What a client's invoice says about the lab. Shared with Telo — a change here
            takes effect on both immediately.
          </p>
        </div>
      </header>

      <section className="card" style={{ maxWidth: 560 }}>
        <label className="field">
          <span className="field__label">Client</span>
          <ClientPicker
            value={mcc}
            onChange={setMcc}
            allowNone
            noneLabel="Choose a client…"
            placeholder="Search client code or name…"
          />
        </label>
      </section>

      {loading && <div className="center" style={{ minHeight: 140 }}><InfinityLoader /></div>}

      {error && <div className="alert alert--error" style={{ marginTop: '1rem' }}>{error}</div>}
      {saved && <div className="alert alert--ok" style={{ marginTop: '1rem' }}>{saved}</div>}

      {config && !loading && (
        <>
          <section className="card" style={{ marginTop: '1rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 style={{ fontSize: '.95rem', fontWeight: 500 }}>
                {config.clientName || config.clientCode}
                {config.clientCode && (
                  <span className="muted mono" style={{ fontSize: '.78rem', marginLeft: '.5rem' }}>
                    {config.clientCode}
                  </span>
                )}
              </h2>
              <span className={`badge${config.hasConfig ? '' : ' badge--lis'}`}>
                {config.hasConfig ? 'configured' : 'using LIS defaults'}
              </span>
            </div>

            {!config.hasConfig && (
              <p className="muted" style={{ fontSize: '.8rem', marginTop: '.5rem', lineHeight: 1.6 }}>
                Nothing has been set for this client, so the letterhead below is coming
                from the LIS's own record of the centre. Saving creates a record that
                overrides it — anything you leave blank keeps falling back.
              </p>
            )}
          </section>

          <section className="card" style={{ marginTop: '1rem' }}>
            <h2 style={{ fontSize: '.8rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--teal)' }}>
              Letterhead
            </h2>
            <p className="muted" style={{ fontSize: '.78rem', margin: '.3rem 0 .8rem' }}>
              Leave a field blank to fall back to what the LIS holds for this centre.
            </p>

            {/* `falls` is the resolved value shown as a placeholder — what
                prints if this box stays empty. See toDraft for why it must not
                be the box's VALUE. */}
            <Field label="Lab name" value={draft.labName} onChange={(v) => set('labName', v)}
                   falls={config.clientName}
                   hint="Overrides the centre's name from the LIS." />
            <Field label="Address" value={draft.address} onChange={(v) => set('address', v)}
                   falls={config.address} />
            <div className="row" style={{ gap: '.6rem', alignItems: 'flex-start' }}>
              <Field label="City" value={draft.city} onChange={(v) => set('city', v)} falls={config.city} />
              {/* No LIS fallback: the centre master stores a state ID, not a name. */}
              <Field label="State" value={draft.state} onChange={(v) => set('state', v)}
                     hint="No LIS fallback — blank prints nothing." />
              <Field label="Pincode" value={draft.pincode} onChange={(v) => set('pincode', v)} falls={config.pincode} />
            </div>
            <div className="row" style={{ gap: '.6rem', alignItems: 'flex-start' }}>
              <Field label="Phone" value={draft.phone} onChange={(v) => set('phone', v)} falls={config.phone} />
              <Field label="Email" value={draft.email} onChange={(v) => set('email', v)} falls={config.email} />
            </div>
            <Field label="Prepared by" value={draft.preparedBy} onChange={(v) => set('preparedBy', v)}
                   hint="Printed in the footer. Blank uses whoever registered the bill." />
          </section>

          <section className="card" style={{ marginTop: '1rem' }}>
            <h2 style={{ fontSize: '.8rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--teal)' }}>
              What the document says
            </h2>
            <p className="muted" style={{ fontSize: '.78rem', margin: '.3rem 0 .8rem', lineHeight: 1.6 }}>
              <b>Auto</b> follows this client's default rather than turning the option off.
              Almost every client is on Auto, and the defaults differ for MEDICARE.
            </p>

            <Tri
              label="Billed on behalf of"
              value={draft.onBehalf}
              onChange={(v) => set('onBehalf', v as Draft['onBehalf'])}
              options={[['', 'Auto'], ['client', 'The client'], ['qugen', 'Qugen Pathlabs Pvt. Ltd.']]}
              resolved={config.flags.onBehalf === 'qugen' ? 'Qugen Pathlabs Pvt. Ltd.' : 'The client'}
            />
            <Tri
              label="Disclaimer"
              value={draft.showDisclaimer}
              onChange={(v) => set('showDisclaimer', v as Draft['showDisclaimer'])}
              options={[['', 'Auto'], ['on', 'Show'], ['off', 'Hide']]}
              resolved={config.flags.showDisclaimer ? 'Show' : 'Hide'}
            />
            <Tri
              label="Signature line"
              value={draft.showSignatory}
              onChange={(v) => set('showSignatory', v as Draft['showSignatory'])}
              options={[['', 'Auto'], ['on', 'Show'], ['off', 'Hide']]}
              resolved={config.flags.showSignatory ? 'Show' : 'Hide'}
            />

            {config.flags.showDisclaimer && disclaimer && (
              <blockquote className="muted" style={{
                fontSize: '.76rem', lineHeight: 1.6, margin: '.8rem 0 0',
                borderLeft: '2px solid var(--line-soft)', paddingLeft: '.6rem',
              }}>
                {disclaimer}
              </blockquote>
            )}
          </section>

          <div className="row" style={{ marginTop: '1rem', gap: '.6rem', alignItems: 'center' }}>
            <button className="btn btn--primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save branding'}
            </button>
            <span className="muted" style={{ fontSize: '.76rem' }}>
              Logos and header layout are not editable here — they stay as set in Telo.
            </span>
          </div>
        </>
      )}
    </main>
  );
}

/**
 * A field whose emptiness is meaningful.
 *
 * `falls` is what the invoice prints when this box is blank. It goes in the
 * placeholder rather than the value, so an operator can see the inherited
 * value without the act of opening the screen turning it into a stored one.
 */
function Field({
  label, value, onChange, hint, falls,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  falls?: string | null;
}) {
  const inherited = value === '' && falls;
  return (
    <label className="field" style={{ flex: 1, minWidth: 0 }}>
      <span className="field__label">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={falls ?? ''}
      />
      {inherited
        ? <span className="muted" style={{ fontSize: '.72rem' }}>From the LIS. Type to override.</span>
        : hint && <span className="muted" style={{ fontSize: '.72rem' }}>{hint}</span>}
    </label>
  );
}

/**
 * A tri-state, as three explicit choices plus what it currently resolves to.
 *
 * The resolved value is shown because "Auto" on its own does not tell an
 * operator what will print — and what will print is the only thing they are
 * trying to find out.
 */
function Tri({
  label, value, onChange, options, resolved,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  resolved: string;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
      <span className="muted" style={{ fontSize: '.72rem' }}>
        Currently prints: <b>{resolved}</b>
      </span>
    </label>
  );
}
