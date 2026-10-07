import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  masterProfileApi,
  type MasterProfileDetail, type MasterProfileRow, type MasterProfileSave, type PickerItem,
} from '../api/client';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import { inr } from '../lib/format';

/**
 * Master profiles — the packages (Lab → Master profiles).
 *
 * The port of the legacy Technical > Master Profile page, screen for screen:
 * a searchable, paged list with code, name, CT, MRP, an on/off status and
 * edit/delete; and the editor — name, code, C/T, MRP, status, and the two
 * lists, available on the left (profiles or tests, by radio there, by
 * segment here) and selected on the right, with the selected total.
 *
 * What is the same underneath: the SHARED catalogue tables are written
 * exactly as the LIS writes them (script 179), so a package made here is the
 * same package in the LIS, in Telo and on every order. What is better: the
 * list says what is in each package; the editor searches both lists, shows
 * each member's code and MRP, says when a member has been renamed or retired
 * since it was added; and a package that has been ordered cannot be deleted,
 * only switched off.
 *
 * The "Selected" total is the sum of the members' MRPs, as the LIS shows it
 * — a sanity figure against the package MRP, not a price anyone is charged.
 */

type Kind = 'profile' | 'test';
interface Picked { kind: Kind; id: number; code: string | null; name: string; mrp: number | null; note?: string }

export function MasterProfilesPage() {
  const [rows, setRows] = useState<MasterProfileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** null = closed; 0 = new; otherwise the package being edited. */
  const [editing, setEditing] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await masterProfileApi.list(search.trim(), page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the packages.');
    } finally {
      setLoading(false);
    }
  }, [search, page, pageSize]);

  // Debounced: the search is a contains-match over 500 rows, cheap, but
  // one query per keystroke is still one too many.
  useEffect(() => {
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [load]);

  const toggleActive = async (r: MasterProfileRow) => {
    setBusyId(r.id); setError(null); setNotice(null);
    try {
      await masterProfileApi.setActive(r.id, !r.isActive);
      setNotice(`${r.code} is now ${r.isActive ? 'off — it will not be offered on new orders' : 'on'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the status.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (r: MasterProfileRow) => {
    if (!window.confirm(`Delete the package ${r.code} — ${r.name}?\n\nIts members and its rate-list prices go with it. A package that has been ordered cannot be deleted; switch it off instead.`)) return;
    setBusyId(r.id); setError(null); setNotice(null);
    try {
      await masterProfileApi.remove(r.id);
      setNotice(`${r.code} deleted.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the package.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Master profiles</h1>
          <p className="page__sub">
            {search.trim()
              ?               : }
            {' — what the LIS calls Technical › Master Profile. A change here is the catalogue's: the LIS and every order see it at once.'}
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap', gap: '.5rem' }}>
          <input className="input" placeholder="Code or name…" value={search}
                 onChange={(e) => { setSearch(e.target.value); setPage(1); }} style={{ minWidth: 240 }}
                 aria-label="Search packages" />
          <button className="btn btn--primary" onClick={() => setEditing(0)}>Add package</button>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}
      {notice && <div className="alert" style={{ marginBottom: '.9rem' }}>{notice}</div>}

      {loading && rows.length === 0 ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading packages…</span></div>
      ) : (
        <>
          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Members</th>
                  <th style={{ textAlign: 'right' }}>CT</th>
                  <th style={{ textAlign: 'right' }}>MRP</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.isActive ? undefined : 'row--muted'}>
                    <td className="mono cell--lead"><b>{r.code}</b></td>
                    <td className="cell--head">{r.name}</td>
                    <td className="cell--meta" data-label="Members">
                      <span className="muted" style={{ fontSize: '.78rem' }}>
                        {r.profileCount} profile{r.profileCount === 1 ? '' : 's'} · {r.testCount} test{r.testCount === 1 ? '' : 's'}
                      </span>
                      {r.members && (
                        <span className="mp__members" title={r.members}>{r.members}</span>
                      )}
                    </td>
                    <td className="mono cell--meta" data-label="CT" style={{ textAlign: 'right' }}>{r.ct ?? '—'}</td>
                    <td className="mono cell--tag" style={{ textAlign: 'right' }}>{r.mrp != null ? inr(r.mrp) : '—'}</td>
                    <td className="cell--meta" data-label="Status">
                      <button
                        type="button" role="switch" aria-checked={r.isActive}
                        aria-label={`${r.code} ${r.isActive ? 'on' : 'off'}`}
                        className={`toggle${r.isActive ? ' toggle--on' : ''}`}
                        disabled={busyId === r.id}
                        title={r.isActive ? 'On — offered on orders. Click to switch off.' : 'Off — not offered. Click to switch on.'}
                        onClick={() => void toggleActive(r)}
                      />
                    </td>
                    <td className="cell--action">
                      <div className="rowacts">
                        <button className="btn btn--ghost btn--sm" disabled={busyId === r.id} onClick={() => setEditing(r.id)}>Edit</button>
                        <button className="btn btn--ghost btn--sm" disabled={busyId === r.id}
                                style={{ color: 'var(--danger)' }} onClick={() => void remove(r)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      No package matches “{search}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={pageSize} total={total} noun="package"
                 onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(1); }} sizes={[20, 50, 100, 250, 500]} />
        </>
      )}

      {editing !== null && (
        <MasterProfileEditor
          id={editing}
          onClose={() => setEditing(null)}
          onSaved={(d, created) => {
            setEditing(null);
            setNotice(`${d.code} ${created ? 'added' : 'saved'} — ${d.members.length} member${d.members.length === 1 ? '' : 's'}.`);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function MasterProfileEditor({ id, onClose, onSaved }: {
  id: number; onClose: () => void; onSaved: (d: MasterProfileDetail, created: boolean) => void;
}) {
  const isNew = id === 0;
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<MasterProfileDetail | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [ct, setCt] = useState('');
  const [mrp, setMrp] = useState('');
  const [active, setActive] = useState(true);
  const [picked, setPicked] = useState<Picked[]>([]);

  // The available list: profiles or tests, searched.
  const [kind, setKind] = useState<Kind>('profile');
  const [pickSearch, setPickSearch] = useState('');
  const [choices, setChoices] = useState<PickerItem[]>([]);
  const [pickLoading, setPickLoading] = useState(false);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    masterProfileApi.get(id)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setName(d.name); setCode(d.code);
        setCt(d.ct == null ? '' : String(d.ct)); setMrp(d.mrp == null ? '' : String(d.mrp));
        setActive(d.isActive);
        setPicked(d.members.map((m) => ({
          kind: m.kind, id: m.id, code: m.code,
          name: m.currentName ?? m.snapshotName ?? `#${m.id}`,
          mrp: m.mrp,
          note: !m.existsNow ? 'no longer in the catalogue'
            : !m.isActive ? 'switched off in the catalogue'
            : m.snapshotName && m.currentName && m.snapshotName.trim() !== m.currentName.trim()
              ? `was “${m.snapshotName.trim()}” when added` : undefined,
        })));
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the package.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, isNew]);

  useEffect(() => {
    let live = true;
    setPickLoading(true);
    const t = setTimeout(() => {
      masterProfileApi.picker(kind, pickSearch.trim())
        .then((r) => { if (live) setChoices(r); })
        .catch(() => { if (live) setChoices([]); })
        .finally(() => { if (live) setPickLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [kind, pickSearch]);

  const isPicked = (k: Kind, i: number) => picked.some((p) => p.kind === k && p.id === i);
  const add = (c: PickerItem) => {
    if (isPicked(kind, c.id)) return;
    setPicked((p) => [...p, { kind, id: c.id, code: c.code, name: c.name ?? `#${c.id}`, mrp: c.mrp }]);
  };
  const drop = (k: Kind, i: number) => setPicked((p) => p.filter((x) => !(x.kind === k && x.id === i)));

  const selectedTotal = useMemo(() => picked.reduce((s, p) => s + (p.mrp ?? 0), 0), [picked]);
  const profiles = picked.filter((p) => p.kind === 'profile');
  const tests = picked.filter((p) => p.kind === 'test');

  const save = async () => {
    setError(null);
    const body: MasterProfileSave = {
      code: code.trim(), name: name.trim(),
      ct: ct.trim() === '' ? null : Number(ct), mrp: mrp.trim() === '' ? null : Number(mrp),
      isActive: active,
      members: picked.map((p) => ({ kind: p.kind, id: p.id })),
    };
    if (!body.code) { setError('A package needs a code.'); return; }
    if (!body.name) { setError('A package needs a name.'); return; }
    if ((body.ct != null && !Number.isInteger(body.ct)) || (body.mrp != null && !Number.isInteger(body.mrp))) {
      setError('CT and MRP are whole rupees.'); return;
    }
    if (body.members.length === 0 && !window.confirm('This package has no members. Save it empty?')) return;
    setSaving(true);
    try {
      const d = isNew ? await masterProfileApi.create(body) : await masterProfileApi.update(id, body);
      onSaved(d, isNew);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the package.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-labelledby="mp-title">
        <h2 className="modal__title" id="mp-title">{isNew ? 'New package' : `Edit package · ${detail?.code ?? ''}`}</h2>

        {loading ? (
          <div className="center"><InfinityLoader /><span className="muted">Loading…</span></div>
        ) : (
          <>
            {error && <div className="alert alert--error" style={{ marginBottom: '.7rem' }}>{error}</div>}
            {detail && detail.orderedCount > 0 && (
              <p className="muted" style={{ fontSize: '.78rem', marginBottom: '.6rem' }}>
                On {detail.orderedCount.toLocaleString('en-IN')} order line{detail.orderedCount === 1 ? '' : 's'} so far
                {detail.smartReport ? ' · sold with the Smart Report' : ''}. Changing the members changes what a
                NEW order of it expands to; orders already placed keep theirs.
              </p>
            )}

            <div className="mp__fields">
              <label className="field">
                <span>Name</span>
                <input className="input" value={name} maxLength={400} onChange={(e) => setName(e.target.value)} autoFocus={isNew} />
              </label>
              <label className="field">
                <span>Code</span>
                <input className="input mono" value={code} maxLength={100}
                       onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. GHMT" />
              </label>
              <label className="field">
                <span>C/T</span>
                <input className="input mono" inputMode="numeric" value={ct}
                       onChange={(e) => setCt(e.target.value.replace(/\D/g, ''))} placeholder="cost" />
              </label>
              <label className="field">
                <span>MRP</span>
                <input className="input mono" inputMode="numeric" value={mrp}
                       onChange={(e) => setMrp(e.target.value.replace(/\D/g, ''))} placeholder="₹" />
              </label>
              <div className="field">
                <span>Status</span>
                <div className="row" style={{ gap: '.5rem', alignItems: 'center', minHeight: 38 }}>
                  <button type="button" role="switch" aria-checked={active} aria-label="Package on"
                          className={`toggle${active ? ' toggle--on' : ''}`} onClick={() => setActive((v) => !v)} />
                  <span className="muted" style={{ fontSize: '.78rem' }}>{active ? 'On — offered on orders' : 'Off — not offered'}</span>
                </div>
              </div>
            </div>

            <div className="mp__pick">
              <div className="mp__col">
                <div className="mp__colhead">
                  <div className="seg" role="radiogroup" aria-label="Pick from">
                    <button type="button" role="radio" aria-checked={kind === 'profile'}
                            className={`seg__btn${kind === 'profile' ? ' is-on' : ''}`} onClick={() => setKind('profile')}>Profiles</button>
                    <button type="button" role="radio" aria-checked={kind === 'test'}
                            className={`seg__btn${kind === 'test' ? ' is-on' : ''}`} onClick={() => setKind('test')}>Tests</button>
                  </div>
                  <input className="input input--sm" placeholder={`Search ${kind}s…`} value={pickSearch}
                         onChange={(e) => setPickSearch(e.target.value)} aria-label={`Search ${kind}s`} />
                </div>
                <ul className="mp__list" aria-label={`Available ${kind}s`}>
                  {choices.map((c) => {
                    const on = isPicked(kind, c.id);
                    return (
                      <li key={c.id}>
                        <button type="button" className={`mp__item${on ? ' mp__item--on' : ''}`} disabled={on}
                                onClick={() => add(c)} title={on ? 'Already in the package' : 'Add to the package'}>
                          <span className="mp__item-name">{c.name}</span>
                          <span className="mono muted mp__item-code">{c.code}</span>
                          <span className="mono mp__item-mrp">{c.mrp != null ? inr(c.mrp) : ''}</span>
                          <span className="mp__item-add" aria-hidden="true">{on ? '✓' : '+'}</span>
                        </button>
                      </li>
                    );
                  })}
                  {!pickLoading && choices.length === 0 && (
                    <li className="muted mp__empty">Nothing matches.</li>
                  )}
                </ul>
                <p className="muted" style={{ fontSize: '.72rem', marginTop: '.3rem' }}>
                  Active {kind}s only. {choices.length >= 400 ? 'The first 400 — search to narrow.' : ''}
                </p>
              </div>

              <div className="mp__col">
                <div className="mp__colhead">
                  <b>Selected</b>
                  <span className="muted" style={{ fontSize: '.78rem' }}>
                    {profiles.length} profile{profiles.length === 1 ? '' : 's'} · {tests.length} test{tests.length === 1 ? '' : 's'}
                    {' · '}members’ MRP <b className="mono">{inr(selectedTotal)}</b>
                  </span>
                </div>
                <ul className="mp__list" aria-label="Selected members">
                  {[...profiles, ...tests].map((p) => (
                    <li key={`${p.kind}:${p.id}`}>
                      <div className={`mp__item mp__item--sel${p.note ? ' mp__item--warn' : ''}`}>
                        <span className="mp__item-kind">{p.kind === 'profile' ? 'P' : 'T'}</span>
                        <span className="mp__item-name">
                          {p.name}
                          {p.note && <span className="mp__note">{p.note}</span>}
                        </span>
                        <span className="mono muted mp__item-code">{p.code}</span>
                        <span className="mono mp__item-mrp">{p.mrp != null ? inr(p.mrp) : ''}</span>
                        <button type="button" className="mp__item-x" aria-label={`Remove ${p.name}`} onClick={() => drop(p.kind, p.id)}>×</button>
                      </div>
                    </li>
                  ))}
                  {picked.length === 0 && <li className="muted mp__empty">Nothing selected — pick from the left.</li>}
                </ul>
                <p className="muted" style={{ fontSize: '.72rem', marginTop: '.3rem' }}>
                  Profiles first, then tests, as the LIS orders them. A member’s name is stored on the package at save
                  time, which is the name the order and the report print.
                </p>
              </div>
            </div>

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : isNew ? 'Add package' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
