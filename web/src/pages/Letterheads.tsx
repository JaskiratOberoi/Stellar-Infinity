import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  letterheadApi,
  type LetterheadEdit,
  type LetterheadKind,
  type LetterheadProfile,
} from '../api/client';
import { ClientPicker, loadClients } from '../components/ClientPicker';

/**
 * Letterheads — a client's own report paper (Admin → Letterheads).
 *
 * A profile is the four clear bands of one client's paper — the head of the
 * first sheet (often taller: it carries the full letterhead), the head of
 * every later sheet, the foot and the sides — plus, for a DIGITAL letterhead,
 * the artwork the PDF is printed onto. A PRE-PRINTED one composites nothing:
 * its artwork, if uploaded, is only a guide to drag the bands against.
 *
 * The canvas is the page at scale. Drag a guide or type the figure; the shaded
 * bands are where the report will never print. Then:
 *   · the calibration sheet, printed at 100% on the client's own paper, shows
 *     the box against the real stationery (and measures printer drift, which
 *     goes in as the nudge);
 *   · "Preview with a report" downloads a real report on this profile.
 *
 * The clients listed default to this paper; their users can still choose
 * Noble's papers from the same drop-down. Admins only — the API answers 404
 * to anyone else.
 */

const A4_W = 210;
const A4_H = 297;
/** Canvas pixels per millimetre. 2.2 → a 462 × 653 sheet. */
const SCALE = 2.2;

type Guide = 'firstTop' | 'top' | 'bottom' | 'side';
type Sheet = 'first' | 'later';

interface Draft {
  name: string;
  kind: LetterheadKind;
  firstTopMm: number;
  topMm: number;
  bottomMm: number;
  sideMm: number;
  nudgeXMm: number;
  nudgeYMm: number;
}

const draftOf = (p: LetterheadProfile): Draft => ({
  name: p.name, kind: p.kind,
  firstTopMm: p.firstTopMm, topMm: p.topMm, bottomMm: p.bottomMm, sideMm: p.sideMm,
  nudgeXMm: p.nudgeXMm, nudgeYMm: p.nudgeYMm,
});

const round5 = (v: number) => Math.round(v * 2) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ---- artwork → an image the canvas can draw ------------------------------ */

async function rasterPdf(url: string, pageIndex: number): Promise<string | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
  try {
    const page = await doc.getPage(Math.min(pageIndex + 1, doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (A4_W * SCALE * 2) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    void doc.destroy();
  }
}

function useArtwork(p: LetterheadProfile | null, sheet: Sheet): { src: string | null; busy: boolean; error: string | null } {
  const [state, setState] = useState<{ src: string | null; busy: boolean; error: string | null }>({ src: null, busy: false, error: null });
  const id = p?.id, version = p?.version, has = p?.hasArtwork, mime = p?.artworkMime;
  useEffect(() => {
    if (!id || !has || version == null) { setState({ src: null, busy: false, error: null }); return; }
    const url = letterheadApi.artworkUrl({ id, version });
    if (mime !== 'application/pdf') { setState({ src: url, busy: false, error: null }); return; }
    let live = true;
    setState((s) => ({ ...s, busy: true, error: null }));
    rasterPdf(url, sheet === 'first' ? 0 : 1)
      .then((src) => { if (live) setState({ src, busy: false, error: null }); })
      .catch(() => { if (live) setState({ src: null, busy: false, error: 'Could not draw this PDF here — the calibration sheet will still show it.' }); });
    return () => { live = false; };
  }, [id, version, has, mime, sheet]);
  return state;
}

/* ---- the page ------------------------------------------------------------ */

export function LetterheadsPage() {
  const [list, setList] = useState<LetterheadProfile[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<LetterheadKind>('stationery');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (select?: number) => {
    try {
      const rows = await letterheadApi.list();
      setList(rows);
      setSelectedId((cur) => select ?? cur ?? rows[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the letterheads.');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const selected = list?.find((p) => p.id === selectedId) ?? null;
  const replace = (p: LetterheadProfile) => setList((l) => l?.map((x) => (x.id === p.id ? p : x)) ?? l);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const p = await letterheadApi.create(name, newKind);
      setNewName('');
      await reload(p.id);
      setNotice(`Created “${p.name}”. Set its margins below, then assign its clients.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the letterhead.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1 className="page__title">Letterheads</h1>
      <p className="muted" style={{ marginTop: '.2rem', maxWidth: 820 }}>
        A client’s own report paper. Mark where the report may print on the client’s sheet; its reports then
        default to this paper, and every user can still pick Noble’s papers from the same drop-down.
        Standard reports only — the Smart Report keeps its own design.
      </p>

      {error && <div className="alert alert--error" style={{ marginTop: '1rem' }}>{error}</div>}
      {notice && <div className="alert" style={{ marginTop: '1rem' }}>{notice}</div>}

      <div className="lhd">
        <aside className="card lhd__list">
          <div className="lhd__list-head">Profiles</div>
          {list === null ? <p className="muted">Loading…</p> : list.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul>
              {list.map((p) => (
                <li key={p.id}>
                  <button type="button"
                          className={`lhd__item${p.id === selectedId ? ' is-on' : ''}${p.isActive ? '' : ' is-off'}`}
                          onClick={() => { setSelectedId(p.id); setNotice(null); setError(null); }}>
                    <b>{p.name}</b>
                    <small>
                      {p.kind === 'digital' ? 'Digital' : 'Pre-printed'}
                      {' · '}{p.clients.length} client{p.clients.length === 1 ? '' : 's'}
                      {p.isActive ? '' : ' · retired'}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="lhd__new">
            <input className="input input--sm" placeholder="New letterhead name" value={newName}
                   maxLength={120} onChange={(e) => setNewName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
            <select className="input input--sm" value={newKind} onChange={(e) => setNewKind(e.target.value as LetterheadKind)}>
              <option value="stationery">Pre-printed stationery</option>
              <option value="digital">Digital (artwork in the PDF)</option>
            </select>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !newName.trim()} onClick={() => void create()}>
              Add letterhead
            </button>
          </div>
        </aside>

        {selected ? (
          <Editor key={selected.id} profile={selected} onSaved={replace}
                  onError={setError} onNotice={setNotice} />
        ) : list && list.length > 0 ? null : (
          <div className="card muted" style={{ alignSelf: 'start' }}>Add a letterhead to begin.</div>
        )}
      </div>
    </div>
  );
}

/* ---- one profile --------------------------------------------------------- */

function Editor({ profile, onSaved, onError, onNotice }: {
  profile: LetterheadProfile;
  onSaved: (p: LetterheadProfile) => void;
  onError: (m: string | null) => void;
  onNotice: (m: string | null) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [sheet, setSheet] = useState<Sheet>('first');
  const [saving, setSaving] = useState(false);
  const [clients, setClients] = useState<string[]>(profile.clients);
  const [sid, setSid] = useState('ZZTRN3A');
  const [paste, setPaste] = useState('');
  /* Many codes at once — a chain's twenty centres pasted from a sheet.
     Commas, spaces, semicolons or new lines all separate. Codes are checked
     against the LIS on Save; any that are not client codes are named then. */
  const addPasted = () => {
    const codes = paste.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0 && c.length <= 50);
    if (codes.length === 0) return;
    setClients((l) => [...l, ...codes.filter((c, i) => !l.includes(c) && codes.indexOf(c) === i)]);
    setPaste('');
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const art = useArtwork(profile, sheet);

  const dirty = useMemo(() => JSON.stringify(draftOf(profile)) !== JSON.stringify(draft), [profile, draft]);
  const clientsDirty = useMemo(() => [...profile.clients].sort().join(',') !== [...clients].sort().join(','), [profile.clients, clients]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const run = async (what: () => Promise<void>) => {
    setSaving(true); onError(null); onNotice(null);
    try { await what(); } catch (e) { onError(e instanceof Error ? e.message : 'Could not save.'); } finally { setSaving(false); }
  };

  const save = () => run(async () => {
    const edit: LetterheadEdit = { ...draft };
    const p = await letterheadApi.update(profile.id, edit);
    onSaved(p);
    setDraft(draftOf(p));
    onNotice('Saved. Reports downloaded from now on use these margins.');
  });

  const saveClients = () => run(async () => {
    const r = await letterheadApi.setClients(profile.id, clients);
    onSaved(r.letterhead);
    setClients(r.letterhead.clients);
    onNotice(r.unknown.length
      ? `Saved. Not a client code, so left out: ${r.unknown.join(', ')}.`
      : `Saved. ${r.letterhead.clients.length} client${r.letterhead.clients.length === 1 ? '' : 's'} now default to this letterhead.`);
  });

  const upload = (f: File) => run(async () => {
    const p = await letterheadApi.uploadArtwork(profile.id, f);
    onSaved(p);
    onNotice(profile.kind === 'digital' || draft.kind === 'digital'
      ? 'Artwork uploaded. It is printed under every report on this letterhead.'
      : 'Guide uploaded. On pre-printed stationery it is only a guide — nothing is printed from it.');
  });

  const removeArt = () => run(async () => {
    const p = await letterheadApi.removeArtwork(profile.id);
    onSaved(p);
    onNotice('Artwork removed.');
  });

  const toggleActive = () => run(async () => {
    const p = await letterheadApi.setActive(profile.id, !profile.isActive);
    onSaved(p);
    onNotice(p.isActive ? 'Back in use.' : 'Retired: no longer offered, and its clients fall back to Noble’s paper.');
  });

  const topKey: Guide = sheet === 'first' ? 'firstTop' : 'top';
  const topMm = sheet === 'first' ? draft.firstTopMm : draft.topMm;
  const box = A4_H - Math.max(draft.firstTopMm, draft.topMm) - draft.bottomMm;
  const zoom = clamp((A4_H - draft.topMm - draft.bottomMm) / 246, 0.75, 1);

  return (
    <section className="card lhd__editor">
      <div className="lhd__row">
        <div className="field" style={{ flex: '2 1 220px' }}>
          <label>Name</label>
          <input value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label>Kind</label>
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as LetterheadKind })}>
            <option value="stationery">Pre-printed stationery — nothing printed</option>
            <option value="digital">Digital — artwork printed into the PDF</option>
          </select>
        </div>
      </div>

      <div className="lhd__work">
        <div>
          <div className="lhd__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={sheet === 'first'} className={`chip${sheet === 'first' ? ' chip--on' : ''}`} onClick={() => setSheet('first')}>First sheet</button>
            <button type="button" role="tab" aria-selected={sheet === 'later'} className={`chip${sheet === 'later' ? ' chip--on' : ''}`} onClick={() => setSheet('later')}>Later sheets</button>
          </div>
          <SheetCanvas
            art={art.src}
            topMm={topMm}
            bottomMm={draft.bottomMm}
            sideMm={draft.sideMm}
            onDrag={(g, mm) => {
              if (g === 'firstTop' || g === 'top') set({ [topKey]: clamp(round5(mm), 0, 120) } as Partial<Draft>);
              else if (g === 'bottom') set({ bottomMm: clamp(round5(mm), 0, 120) });
              else set({ sideMm: clamp(round5(mm), 0, 40) });
            }}
            topGuide={topKey}
          />
          {art.busy && <p className="muted lhd__hint">Drawing the artwork…</p>}
          {art.error && <p className="muted lhd__hint">{art.error}</p>}
          {!profile.hasArtwork && (
            <p className="muted lhd__hint">
              Upload the letterhead (a PDF, or a PNG/JPEG scan of the full A4 sheet) to drag the guides against it.
            </p>
          )}
        </div>

        <div className="lhd__side">
          <fieldset className="lhd__set">
            <legend>Print area (mm)</legend>
            <MmInput label="Top — first sheet" value={draft.firstTopMm} max={120} onChange={(v) => set({ firstTopMm: v })} />
            <MmInput label="Top — later sheets" value={draft.topMm} max={120} onChange={(v) => set({ topMm: v })} />
            <MmInput label="Bottom" value={draft.bottomMm} max={120} onChange={(v) => set({ bottomMm: v })} />
            <MmInput label="Sides" value={draft.sideMm} max={40} onChange={(v) => set({ sideMm: v })} />
            <p className="muted lhd__hint">
              {box < 97
                ? 'Too little room left for the report.'
                : `Report area ${A4_W - 2 * draft.sideMm} × ${A4_H - draft.topMm - draft.bottomMm} mm; the report is drawn at ${Math.round(zoom * 100)}% of its Noble size so it breaks pages the same way.`}
            </p>
          </fieldset>

          <fieldset className="lhd__set">
            <legend>Printer nudge (mm)</legend>
            <MmInput label="Across (+ right)" value={draft.nudgeXMm} min={-10} max={10} onChange={(v) => set({ nudgeXMm: v })} />
            <MmInput label="Down (+ down)" value={draft.nudgeYMm} min={-10} max={10} onChange={(v) => set({ nudgeYMm: v })} />
            <p className="muted lhd__hint">
              Only if the client’s printer shifts everything: print the calibration sheet on their paper, measure the
              shift against its rulers, enter it here.
            </p>
          </fieldset>

          <div className="lhd__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!dirty || saving} onClick={() => setDraft(draftOf(profile))}>
              Undo changes
            </button>
          </div>

          <fieldset className="lhd__set">
            <legend>Artwork</legend>
            <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg" hidden
                   onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
            <div className="lhd__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={() => fileRef.current?.click()}>
                {profile.hasArtwork ? 'Replace…' : 'Upload…'}
              </button>
              {profile.hasArtwork && (
                <button type="button" className="btn btn--danger btn--sm" disabled={saving} onClick={() => void removeArt()}>Remove</button>
              )}
            </div>
            <p className="muted lhd__hint">
              {draft.kind === 'digital'
                ? 'Printed under every sheet. A two-page PDF: page 1 for the first sheet, page 2 for the rest.'
                : 'A guide only. Nothing is printed on pre-printed stationery.'}
            </p>
          </fieldset>

          <fieldset className="lhd__set">
            <legend>Check it</legend>
            <div className="lhd__actions">
              <a className="btn btn--ghost btn--sm" href={letterheadApi.calibrationUrl(profile)} target="_blank" rel="noreferrer"
                 title="Print at 100% on the client’s paper: the dashed box must clear its header and footer.">
                Calibration sheet
              </a>
            </div>
            <div className="lhd__actions" style={{ marginTop: '.5rem' }}>
              <input className="input input--sm" style={{ maxWidth: 140 }} value={sid} onChange={(e) => setSid(e.target.value.trim())}
                     aria-label="Sample ID to preview" />
              <a className={`btn btn--ghost btn--sm${!sid || dirty ? ' is-disabled' : ''}`}
                 aria-disabled={!sid || dirty}
                 href={sid && !dirty ? `/api/reports/${encodeURIComponent(sid)}/pdf?paper=lh:${profile.id}&lhPreview=true&v=${profile.version}` : undefined}
                 target="_blank" rel="noreferrer"
                 title={dirty ? 'Save first — the preview uses the saved letterhead.' : 'Download this report on this letterhead.'}>
                Preview with a report
              </a>
            </div>
          </fieldset>
        </div>
      </div>

      <fieldset className="lhd__set lhd__clients">
        <legend>Clients on this letterhead</legend>
        <div className="lhd__chips">
          {clients.length === 0 && <span className="muted">No clients yet.</span>}
          {clients.map((c) => (
            <span key={c} className="lhd__code">
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => setClients((l) => l.filter((x) => x !== c))}>×</button>
            </span>
          ))}
        </div>
        <div className="lhd__row" style={{ alignItems: 'center' }}>
          <div style={{ flex: '1 1 280px', maxWidth: 380 }}>
            {/* Held at null: the picker is an "add" box, not a selection. Its
                onClient only fires when its value changes, so the chosen id is
                resolved to its code here instead. */}
            <ClientPicker value={null} allowNone={false} placeholder="Add a client code or name…"
                          onChange={(id) => {
                            if (id == null) return;
                            void loadClients().then((all) => {
                              const code = all.find((c) => c.id === id)?.code.trim();
                              if (code) setClients((l) => (l.includes(code) ? l : [...l, code]));
                            });
                          }} />
          </div>
          <button type="button" className="btn btn--primary btn--sm" disabled={!clientsDirty || saving} onClick={() => void saveClients()}>
            Save clients
          </button>
        </div>
        <div className="lhd__row" style={{ alignItems: 'flex-start', marginTop: '.6rem' }}>
          <textarea className="input input--sm" rows={2} style={{ flex: '1 1 280px', maxWidth: 380, resize: 'vertical' }}
                    placeholder="Or paste several codes — MDCARE, MDCARE01 MDCARE02 …"
                    aria-label="Paste client codes" value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addPasted(); } }} />
          <button type="button" className="btn btn--ghost btn--sm" disabled={!paste.trim()} onClick={addPasted}>
            Add codes
          </button>
          {clients.length > 1 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClients([])}>
              Clear list
            </button>
          )}
        </div>
        <p className="muted lhd__hint">
          {clients.length > 0 && `${clients.length} client${clients.length === 1 ? '' : 's'} listed${clientsDirty ? ' — not saved yet' : ''}. `}
          A client is on one letterhead at a time — adding it here moves it from any other. Its users start on this
          paper and can still choose Noble’s.
        </p>
      </fieldset>

      <div className="lhd__actions" style={{ marginTop: '1rem' }}>
        <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={() => void toggleActive()}>
          {profile.isActive ? 'Retire this letterhead' : 'Bring back into use'}
        </button>
        <span className="muted" style={{ fontSize: '.75rem' }}>Version {profile.version} · updated {new Date(profile.updatedAt + 'Z').toLocaleString()}</span>
      </div>
    </section>
  );
}

function MmInput({ label, value, onChange, min = 0, max }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max: number;
}) {
  return (
    <label className="lhd__mm">
      <span>{label}</span>
      <input type="number" className="input input--sm" step={0.5} min={min} max={max} value={value}
             onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(clamp(v, min, max)); }} />
    </label>
  );
}

/* ---- the sheet at scale, with draggable guides ---------------------------- */

function SheetCanvas({ art, topMm, bottomMm, sideMm, onDrag, topGuide }: {
  art: string | null;
  topMm: number;
  bottomMm: number;
  sideMm: number;
  onDrag: (g: Guide, mm: number) => void;
  topGuide: Guide;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Guide | null>(null);

  const mmAt = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * A4_W, y: ((e.clientY - r.top) / r.height) * A4_H };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const { x, y } = mmAt(e);
    if (drag === 'firstTop' || drag === 'top') onDrag(drag, y);
    else if (drag === 'bottom') onDrag(drag, A4_H - y);
    else onDrag(drag, x < A4_W / 2 ? x : A4_W - x);
  };
  const start = (g: Guide) => (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag(g);
  };

  const px = (mm: number) => mm * SCALE;
  return (
    <div ref={ref} className={`lhd__sheet${drag ? ' is-dragging' : ''}`}
         style={{ width: px(A4_W), height: px(A4_H) }}
         onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      {art && <img src={art} alt="" className="lhd__art" draggable={false} />}
      {/* The bands the report will never print into. */}
      <div className="lhd__band" style={{ left: 0, right: 0, top: 0, height: px(topMm) }} />
      <div className="lhd__band" style={{ left: 0, right: 0, bottom: 0, height: px(bottomMm) }} />
      <div className="lhd__band" style={{ left: 0, width: px(sideMm), top: px(topMm), bottom: px(bottomMm) }} />
      <div className="lhd__band" style={{ right: 0, width: px(sideMm), top: px(topMm), bottom: px(bottomMm) }} />
      {/* A few ghost lines of report, so the box reads as a page. */}
      <div className="lhd__ghost" style={{ left: px(sideMm), right: px(sideMm), top: px(topMm), bottom: px(bottomMm) }}>
        {Array.from({ length: 14 }, (_, i) => <i key={i} style={{ width: `${[92, 70, 84, 60, 88, 76, 94, 58, 80, 66, 90, 72, 86, 64][i]}%` }} />)}
      </div>
      <GuideLine axis="h" at={px(topMm)} label={`${topMm} mm`} onPointerDown={start(topGuide)} />
      <GuideLine axis="h" at={px(A4_H - bottomMm)} label={`${bottomMm} mm`} onPointerDown={start('bottom')} below />
      <GuideLine axis="v" at={px(sideMm)} label={`${sideMm} mm`} onPointerDown={start('side')} />
      <GuideLine axis="v" at={px(A4_W - sideMm)} onPointerDown={start('side')} />
    </div>
  );
}

function GuideLine({ axis, at, label, onPointerDown, below }: {
  axis: 'h' | 'v'; at: number; label?: string; below?: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  return (
    <div className={`lhd__guide lhd__guide--${axis}`}
         style={axis === 'h' ? { top: at } : { left: at }}
         onPointerDown={onPointerDown}
         role="slider" aria-label={label ?? 'side margin'}>
      {label && <span className={below ? 'is-below' : undefined}>{label}</span>}
    </div>
  );
}
