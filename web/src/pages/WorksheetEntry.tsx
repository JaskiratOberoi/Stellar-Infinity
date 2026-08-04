import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  worksheetApi,
  type ResultEdit,
  type WorksheetResultRow,
  type WorksheetSampleResponse,
} from '../api/client';
import { fmtDateTime } from '../lib/format';
import { WorksheetHistory } from './WorksheetHistory';
import { InfinityLoader } from '../components/InfinityLoader';

/** A row the operator has touched but not yet saved. */
interface Draft {
  value?: string;
  comments?: string;
  auth?: boolean;
}

/**
 * Reference-range cell: two lines by default, the whole thing on hover or
 * keyboard focus.
 *
 * These strings routinely carry adult, paediatric, newborn and per-trimester
 * bands. Printed in full they push one analyte to roughly 150px and a thyroid
 * profile off the screen, which makes the grid unusable for the data entry it
 * exists for — but the range is also exactly what an operator checks a value
 * against, so it cannot simply be dropped.
 *
 * The popover is position:FIXED rather than absolute. The grid is a scroll
 * container (maxHeight 46vh, overflow-y auto), so an absolutely positioned
 * panel inside a cell would be clipped by it — visible for the top rows and cut
 * off for the rest, which is worse than not having it.
 */
function RangeCell({ text }: { text: string }) {
  const [at, setAt] = useState<{ left: number; top: number; flip: boolean } | null>(null);

  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // Flip above when there is not enough room below, so the panel is never
    // half off-screen for rows near the bottom of the viewport.
    const flip = r.bottom + 200 > window.innerHeight;
    setAt({ left: r.left, top: flip ? r.top : r.bottom + 4, flip });
  };

  const multiline = text.includes('\n') || text.length > 48;

  return (
    <td className="muted range-cell" style={{ fontSize: '.75rem' }}>
      <div
        className="range-cell__clamp"
        tabIndex={multiline ? 0 : -1}
        // Native tooltip as a floor: it survives touch, high-contrast modes and
        // anything that stops the custom panel rendering.
        title={multiline ? text : undefined}
        onMouseEnter={(e) => multiline && show(e.currentTarget)}
        onMouseLeave={() => setAt(null)}
        onFocus={(e) => multiline && show(e.currentTarget)}
        onBlur={() => setAt(null)}
      >
        {text}
      </div>

      {at && (
        <div
          className="range-cell__full"
          style={{
            left: at.left,
            top: at.top,
            transform: at.flip ? 'translateY(-100%) translateY(-4px)' : undefined,
          }}
          role="tooltip"
        >
          {text}
        </div>
      )}
    </td>
  );
}

/**
 * Where a value sits relative to this patient's reference range.
 *
 * Computed in the browser purely for immediate feedback as the user types. The
 * server recomputes it in usp_inf_result_save and ignores whatever the client
 * believed — so a disagreement here is a display bug, never a data one.
 */
type RangePosition = 'low' | 'high' | 'normal' | 'unknown';

function positionOf(row: WorksheetResultRow, raw: string | null | undefined): RangePosition {
  if (row.rangeLow == null || row.rangeHigh == null) return 'unknown';
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'unknown';
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < row.rangeLow) return 'low';
  if (n > row.rangeHigh) return 'high';
  return 'normal';
}

/** Head and Profile rows carry no value — they are headings in the printed report. */
const isHeading = (r: WorksheetResultRow) => r.testType === 'Head' || r.testType === 'Profile';

export function WorksheetEntry({ sid, onClose, onSaved }: {
  sid: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [data, setData] = useState<WorksheetSampleResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sampleComments, setSampleComments] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await worksheetApi.getSample(sid);
      setData(r);
      setSampleComments(r.header.sampleComments ?? '');
      setDrafts({});
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this sample.');
    } finally {
      setLoading(false);
    }
  }, [sid]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const rows = data?.rows ?? [];
  const perms = data?.permissions;
  const header = data?.header;

  /** The effective value of a row: the draft if touched, otherwise what is stored. */
  const valueOf = (r: WorksheetResultRow) => drafts[r.resultId]?.value ?? r.value ?? '';
  const commentsOf = (r: WorksheetResultRow) => drafts[r.resultId]?.comments ?? r.comments ?? '';
  const authOf = (r: WorksheetResultRow) => drafts[r.resultId]?.auth ?? r.authorized;

  /**
   * Rows whose value is being OVERWRITTEN rather than entered fresh.
   *
   * This is the distinction the legacy system draws between Result_Entry and
   * Result_Edit, and it is the one that decides whether a reason is required.
   */
  const amendedRows = useMemo(
    () => rows.filter((r) => {
      const d = drafts[r.resultId];
      if (d?.value === undefined) return false;
      const original = (r.value ?? '').trim();
      return original !== '' && d.value !== (r.value ?? '');
    }),
    [rows, drafts],
  );

  const touchedCount = Object.keys(drafts).length;
  const needsReason = amendedRows.length > 0;
  const reasonOk = !needsReason || reason.trim().length >= 3;

  /** What the server will sign automatically on this save, so it is never a surprise. */
  const willAutoAuthorize = useMemo(
    () => rows.filter((r) =>
      r.autoAuthEligible &&
      !r.authorized &&
      drafts[r.resultId]?.auth !== true &&
      positionOf(r, valueOf(r)) === 'normal',
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, drafts],
  );

  /**
   * Apply an edit, and DROP the draft entirely when it no longer differs from
   * what is stored.
   *
   * Everything downstream keys off presence in this map — the changed-row tint,
   * the "N rows changed" counter, whether Save is enabled, and which edits are
   * sent. An earlier version always wrote an entry, so ticking the auth box and
   * immediately unticking it left `{auth: false}`: identical to the stored row,
   * but still counted as a change. The row stayed highlighted, Save stayed
   * enabled, and the save would have posted a no-op edit that the server would
   * have audited as a change that never happened.
   */
  const setDraft = (r: WorksheetResultRow, patch: Draft) =>
    setDrafts((d) => {
      const next = { ...d[r.resultId], ...patch };

      const valueSame = next.value === undefined || next.value === (r.value ?? '');
      const commentsSame = next.comments === undefined || next.comments === (r.comments ?? '');
      const authSame = next.auth === undefined || next.auth === r.authorized;

      if (valueSame && commentsSame && authSame) {
        const { [r.resultId]: _dropped, ...rest } = d;
        return rest;
      }

      return { ...d, [r.resultId]: next };
    });

  const save = async () => {
    if (!header || touchedCount === 0) return;
    if (!reasonOk) {
      setError('Changing a result that already has a value requires a reason.');
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const edits: ResultEdit[] = Object.entries(drafts).map(([id, d]) => {
        const resultId = Number(id);
        const row = rows.find((r) => r.resultId === resultId);
        const isAmend = amendedRows.some((r) => r.resultId === resultId);
        return {
          resultId,
          // undefined -> omitted -> null on the wire -> "not touched" in SQL.
          value: d.value,
          comments: d.comments,
          setAuth: d.auth === undefined || d.auth === row?.authorized ? null : d.auth,
          reason: isAmend ? reason.trim() : null,
        };
      });

      const outcome = await worksheetApi.saveResults(
        sid,
        edits,
        sampleComments !== (header.sampleComments ?? '') ? sampleComments : null,
      );

      const bits = [`${outcome.applied} change${outcome.applied === 1 ? '' : 's'} saved`];
      if (outcome.autoAuthorized > 0) {
        bits.push(`${outcome.autoAuthorized} auto-authorised`);
      }
      setNotice(bits.join(' · '));

      await load();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The save was rejected.');
    } finally {
      setSaving(false);
    }
  };

  const reopen = async () => {
    if (reopenReason.trim().length < 10) {
      setError('Reopening an authorised sample requires a reason of at least 10 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await worksheetApi.reopen(sid, reopenReason.trim());
      setReopening(false);
      setReopenReason('');
      setNotice('Sample reopened for editing. The reason has been recorded.');
      await load();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The sample could not be reopened.');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Enter moves to the next value box rather than submitting.
   *
   * Bench entry is a long column of numbers typed without looking up; a form
   * that submits on Enter loses that. Shift+Enter goes back.
   */
  const gridRef = useRef<HTMLDivElement>(null);
  const onValueKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>('[data-value-input]') ?? [],
    ).filter((el) => !(el as HTMLInputElement).disabled);
    const i = inputs.indexOf(e.currentTarget);
    const next = inputs[i + (e.shiftKey ? -1 : 1)];
    next?.focus();
    if (next instanceof HTMLInputElement) next.select();
  };

  const readOnly = !header?.isEditable || !perms?.canEnter;

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Worksheet ${sid}`}
      >
        {loading ? (
          <div className="center" style={{ minHeight: 200 }}><InfinityLoader /></div>
        ) : !header ? (
          <>
            <div className="alert alert--error">{error ?? 'This sample could not be found.'}</div>
            <div className="modal__actions"><button className="btn btn--ghost" onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            {/* ---- header ---- */}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal__title">{header.patientName ?? 'Unnamed patient'}</h2>
                <p className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>
                  SID <b className="mono">{header.sid}</b>
                  {header.clientCode && ` · ${header.clientCode}`}
                  {header.sex && ` · ${header.sex}`}
                  {header.age != null && ` · ${header.age} ${header.ageUnit ?? ''}`}
                  {header.registeredAt && ` · registered ${fmtDateTime(header.registeredAt)}`}
                </p>
              </div>
              <div className="row" style={{ gap: '.4rem' }}>
                <span className={`badge badge--${header.statusCode === 7 ? 'infinity' : 'lis'}`}>
                  {header.status ?? '—'}
                </span>
                <button className="btn btn--ghost btn--sm" onClick={() => setShowHistory(true)}>
                  History
                </button>
              </div>
            </div>

            {/* ---- state banners ---- */}
            {header.isRejected && (
              <div className="alert alert--error">
                This sample was rejected{header.rejectComments ? `: ${header.rejectComments}` : ''}. Results cannot be entered.
              </div>
            )}

            {header.needsReopen && !reopening && (
              <div className="alert alert--info">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '.6rem' }}>
                  <span>
                    Authorised{header.authorisedByUsername ? ` by ${header.authorisedByUsername}` : ''}
                    {header.signatoryName ? ` · signed ${header.signatoryName}` : ''}. Editing is locked.
                  </span>
                  {perms?.canReopen ? (
                    <button className="btn btn--danger btn--sm" onClick={() => setReopening(true)}>
                      Reopen
                    </button>
                  ) : (
                    <span className="muted" style={{ fontSize: '.75rem', whiteSpace: 'nowrap' }}>
                      Needs a lab manager
                    </span>
                  )}
                </div>
              </div>
            )}

            {reopening && (
              <div className="alert alert--error">
                <p style={{ marginBottom: '.5rem' }}>
                  <b>Reopening a signed-off sample.</b> The reason is recorded permanently against your name and
                  cannot be edited or removed afterwards.
                </p>
                <textarea
                  className="input"
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="Why is this being reopened? (at least 10 characters)"
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                />
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: '.5rem' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => { setReopening(false); setReopenReason(''); }}>
                    Cancel
                  </button>
                  <button
                    className="btn btn--danger btn--sm"
                    disabled={saving || reopenReason.trim().length < 10}
                    onClick={() => void reopen()}
                  >
                    Reopen sample
                  </button>
                </div>
              </div>
            )}

            {willAutoAuthorize.length > 0 && (
              <div className="alert alert--info">
                <b>{willAutoAuthorize.length}</b> in-range result{willAutoAuthorize.length === 1 ? '' : 's'} will be
                authorised automatically when you save, because auto-authorisation is switched on for{' '}
                {[...new Set(willAutoAuthorize.map((r) => r.testName ?? r.testCode))].slice(0, 3).join(', ')}
                {willAutoAuthorize.length > 3 ? ' and others' : ''}.
              </div>
            )}

            {error && <div className="alert alert--error">{error}</div>}
            {notice && <div className="alert alert--ok">{notice}</div>}

            {/* ---- grid ---- */}
            <div className="table-wrap worksheet-grid" ref={gridRef} style={{ maxHeight: '46vh', overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ minWidth: 200 }}>Test</th>
                    <th style={{ width: 150 }}>Result</th>
                    <th style={{ width: 70 }}>Unit</th>
                    <th style={{ width: 150 }}>Reference</th>
                    <th style={{ width: 180 }}>Comment</th>
                    <th style={{ width: 60, textAlign: 'center' }} title="Authorised">Auth</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    if (isHeading(r)) {
                      return (
                        <tr key={r.resultId} className="worksheet-grid__heading">
                          <td colSpan={6}>{r.testName}</td>
                        </tr>
                      );
                    }

                    const value = valueOf(r);
                    const pos = positionOf(r, value);
                    const touched = drafts[r.resultId] !== undefined;
                    const willSign = willAutoAuthorize.some((x) => x.resultId === r.resultId);

                    return (
                      <tr key={r.resultId} className={touched ? 'worksheet-grid__touched' : undefined}>
                        <td>
                          {r.testName ?? r.testCode ?? '—'}
                          {r.enteredBy && (
                            <div className="muted" style={{ fontSize: '.68rem' }}>
                              last updated {fmtDateTime(r.updatedAt)}
                            </div>
                          )}
                        </td>

                        <td>
                          {r.codedOptions.length > 0 ? (
                            <select
                              className="input input--sm"
                              data-value-input
                              disabled={readOnly}
                              value={value}
                              onKeyDown={onValueKeyDown}
                              onChange={(e) => setDraft(r, { value: e.target.value })}
                            >
                              <option value="">—</option>
                              {r.codedOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <div className="row" style={{ gap: '.3rem', alignItems: 'center' }}>
                              <input
                                className={`input input--sm mono${pos === 'low' || pos === 'high' ? ' input--flag' : ''}`}
                                data-value-input
                                disabled={readOnly}
                                value={value}
                                onKeyDown={onValueKeyDown}
                                onChange={(e) => setDraft(r, { value: e.target.value })}
                                aria-label={`Result for ${r.testName ?? r.testCode ?? 'test'}`}
                              />
                              {pos === 'high' && <span className="flag flag--high" title="Above reference range">H</span>}
                              {pos === 'low' && <span className="flag flag--low" title="Below reference range">L</span>}
                            </div>
                          )}
                        </td>

                        <td className="muted" style={{ fontSize: '.78rem' }}>{r.unit ?? '—'}</td>

                        {/* The frozen string is what the report prints, so it is
                            what the operator is shown. The live bounds only
                            drive the H/L flag.

                            Clamped to two lines: these strings routinely carry
                            paediatric, pregnancy and newborn bands, and printed
                            in full they push a single analyte to ~150px and make
                            the grid unusable for data entry. The whole text is
                            revealed on hover and on keyboard focus. */}
                        <RangeCell text={r.normalRange ?? (r.rangeLow != null ? `${r.rangeLow} – ${r.rangeHigh}` : '—')} />

                        <td>
                          <input
                            className="input input--sm"
                            disabled={readOnly}
                            value={commentsOf(r)}
                            placeholder="—"
                            onChange={(e) => setDraft(r, { comments: e.target.value })}
                          />
                        </td>

                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={authOf(r)}
                            // Disabled without the capability — AND the server
                            // refuses the change regardless, so this is a hint
                            // rather than the control. In the legacy LIS a
                            // disabled checkbox posted back as unchecked, which
                            // silently CLEARED authorisations on save.
                            disabled={readOnly || !perms?.canAuthorize}
                            title={
                              perms?.canAuthorize
                                ? 'Authorise this result'
                                : 'Your role cannot authorise results'
                            }
                            onChange={(e) => setDraft(r, { auth: e.target.checked })}
                          />
                          {willSign && !authOf(r) && (
                            <div className="muted" style={{ fontSize: '.6rem' }} title="Will be authorised automatically">
                              auto
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                        No analytes on this sample yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* ---- sample-level fields ---- */}
            <div className="field">
              <label htmlFor="ws-sample-comments">Sample comment</label>
              <input
                id="ws-sample-comments"
                className="input"
                disabled={readOnly}
                value={sampleComments}
                placeholder="Visible on the report"
                onChange={(e) => setSampleComments(e.target.value)}
              />
              {/* Worth stating: in the legacy LIS, saving any sample comment
                  forced the status to 10 (Pending), silently discarding the
                  transition it had just computed. */}
              <span className="muted" style={{ fontSize: '.7rem' }}>
                Saving a comment does not change the sample status.
              </span>
            </div>

            {needsReason && (
              <div className="field">
                <label htmlFor="ws-reason">
                  Reason for changing {amendedRows.length} existing result{amendedRows.length === 1 ? '' : 's'}
                  <span style={{ color: 'var(--danger)' }}> *</span>
                </label>
                <input
                  id="ws-reason"
                  className="input"
                  value={reason}
                  placeholder="e.g. re-run after clot detected"
                  onChange={(e) => setReason(e.target.value)}
                />
                <span className="muted" style={{ fontSize: '.7rem' }}>
                  Recorded permanently against your name, alongside the previous value.
                </span>
              </div>
            )}

            <div className="modal__actions">
              <span className="muted" style={{ marginRight: 'auto', fontSize: '.75rem' }}>
                {touchedCount > 0
                  ? `${touchedCount} row${touchedCount === 1 ? '' : 's'} changed`
                  : 'No changes'}
              </span>
              <button className="btn btn--ghost" disabled={saving} onClick={onClose}>Close</button>
              <button
                className="btn btn--primary"
                disabled={saving || readOnly || touchedCount === 0 || !reasonOk}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}

        {showHistory && <WorksheetHistory sid={sid} onClose={() => setShowHistory(false)} />}
      </div>
    </div>
  );
}
