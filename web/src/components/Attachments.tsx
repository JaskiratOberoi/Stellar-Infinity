import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attachmentApi, type AttachmentRow } from '../api/client';
import { fmtDateTime } from '../lib/format';

const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Documents attached to a sample — the analyser graph, a scanned trace, an
 * outside lab's PDF.
 *
 * ── TWO PLACES TO ATTACH, AND WHY BOTH ────────────────────────────────────
 * The panel at the foot of the worksheet attaches to the SAMPLE. That is the
 * common case by a distance: 6,724 attachments across 6,710 distinct vials in
 * the LIS, so very nearly one document per sample. It is also the only place
 * that works at all for the ~1,100 of 1,457 active tests the LIS never flagged
 * Has_graph — which is why most samples had no way to attach anything.
 *
 * The clip on each analyte row attaches to that ONE result. Some documents do
 * belong to a single parameter — an electrophoresis trace, a culture plate
 * photograph, one analyte's re-run — and filing those against the whole sample
 * loses which parameter they explain. The legacy table has always had a
 * nullable result_id for exactly this; nothing here is a new column.
 *
 * Both write to dbo.tbl_med_mcc_patient_test_result_attachment, so the LIS
 * screens and Crystal reports keep seeing them.
 *
 * The panel lists EVERYTHING, per-test rows included, each labelled with the
 * test it belongs to. A document filed against one analyte must not become
 * invisible from the sample it is on.
 */

/* ------------------------------------------------------------------ state --- */

/**
 * One fetch, shared.
 *
 * The panel and every row clip read the same list — a row needs to know
 * whether it has a document to show a count, and the panel needs the same rows
 * to list them. Fetching per row would be one request per analyte on a
 * forty-line CBC, and the two views could disagree after an upload.
 */
export function useAttachments(sid: string) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [maxBytes, setMaxBytes] = useState(10 * 1024 * 1024);
  const [canAttach, setCanAttach] = useState(false);
  const [canRemove, setCanRemove] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await attachmentApi.list(sid);
      setRows(r.rows);
      setMaxBytes(r.maxBytes);
      setCanAttach(r.canAttach);
      setCanRemove(r.canRemove);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load attachments.');
    } finally {
      setLoading(false);
    }
  }, [sid]);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * Throws rather than storing an error, so the caller can show it where the
   * upload was started — beside the row's clip, or under the panel. A single
   * shared error string would print the same message in both places.
   */
  const upload = useCallback(async (file: File, resultId: number | null = null) => {
    // Checked here as well as server-side, so an obvious mistake costs no
    // upload at all rather than a round-trip of a large file.
    if (file.size > maxBytes) {
      throw new Error(`That file is ${fmtSize(file.size)}. The limit is ${fmtSize(maxBytes)}.`);
    }
    await attachmentApi.upload(sid, file, resultId);
    await reload();
  }, [sid, maxBytes, reload]);

  const remove = useCallback(async (id: number) => {
    await attachmentApi.remove(sid, id);
    await reload();
  }, [sid, reload]);

  /** How many documents hang off one analyte. Drives the count on its clip. */
  const countFor = useCallback(
    (resultId: number) => rows.reduce((n, r) => (r.resultId === resultId ? n + 1 : n), 0),
    [rows],
  );

  return { rows, maxBytes, canAttach, canRemove, loading, loadError, upload, remove, countFor };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/* ------------------------------------------------------------------ parts --- */

function AttachmentItem({ sid, row, canRemove, busy, onRemove, showTest }: {
  sid: string;
  row: AttachmentRow;
  canRemove: boolean;
  busy: boolean;
  onRemove: (row: AttachmentRow) => void;
  /** Off inside a row's own list, where the test is the row you are on. */
  showTest: boolean;
}) {
  return (
    <li className="attachments__item">
      {/* A plain link, not a scripted download: the endpoint is same-origin
          and cookie-authenticated, so the browser can open it in a tab the
          way a person expects a document to open. */}
      <a href={attachmentApi.href(sid, row.id)} target="_blank" rel="noreferrer"
         className="attachments__link">
        <span className="attachments__kind">{(row.fileType ?? '').replace('.', '') || 'file'}</span>
        <span>
          {showTest ? (row.testName ?? 'Whole sample') : 'Open'}
          <span className="muted"> · {fmtSize(row.sizeBytes)}</span>
        </span>
      </a>
      <span className="muted attachments__meta">
        {row.uploadedBy
          ? `${row.uploadedBy}${row.uploadedAt ? ` · ${fmtDateTime(row.uploadedAt)}` : ''}`
          /* Rows the LIS created carry no uploader or timestamp — those columns
             do not exist on its table. Saying so is better than inventing a
             provenance. */
          : 'added in the LIS'}
      </span>
      {canRemove && (
        <button className="btn btn--ghost btn--sm" disabled={busy}
                onClick={() => onRemove(row)}>Remove</button>
      )}
    </li>
  );
}

/** Click-to-pick and drag-to-drop over the same handler. */
function DropZone({ onFile, busy, maxBytes, label }: {
  onFile: (f: File) => void;
  busy: boolean;
  maxBytes: number;
  label: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`attachments__drop${dragging ? ' is-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          // Cleared so choosing the SAME file twice fires change again.
          e.target.value = '';
        }}
      />
      {label}{' '}
      <button type="button" className="linkish" disabled={busy}
              onClick={() => fileRef.current?.click()}>
        {busy ? 'working…' : 'choose a file'}
      </button>
      <span className="muted"> · PDF, PNG or JPEG, up to {fmtSize(maxBytes)}.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ views --- */

/**
 * The sample-level panel, at the foot of the worksheet.
 *
 * Its drop zone files against the whole sample. Its list shows every document
 * on the sample, per-test ones included and labelled.
 */
export function Attachments({ sid, canEdit, state }: {
  sid: string;
  canEdit: boolean;
  state: AttachmentsState;
}) {
  const { rows, maxBytes, canAttach, canRemove, loading, loadError, upload, remove } = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = canEdit && canAttach;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : fallback); }
    finally { setBusy(false); }
  };

  const onRemove = (row: AttachmentRow) => {
    // Deleting is irreversible and the document may be the only evidence behind
    // a released result, so it asks. The legacy screen deletes on one click,
    // with no confirmation and no audit record.
    if (!window.confirm('Remove this attachment? This cannot be undone, though the removal is recorded.')) return;
    void run(() => remove(row.id), 'Could not remove it.');
  };

  return (
    <section className="attachments">
      <div className="attachments__head">
        <h3 className="attachments__title">
          Attachments
          {rows.length > 0 && <span className="attachments__count">{rows.length}</span>}
        </h3>
      </div>

      {(error || loadError) && (
        <div className="alert alert--error" style={{ marginBottom: '.5rem' }}>{error ?? loadError}</div>
      )}

      {loading ? (
        <p className="muted" style={{ fontSize: '.76rem' }}>Loading…</p>
      ) : (
        <>
          {rows.length > 0 && (
            <ul className="attachments__list">
              {rows.map((r) => (
                <AttachmentItem key={r.id} sid={sid} row={r} showTest
                                canRemove={canEdit && canRemove} busy={busy} onRemove={onRemove} />
              ))}
            </ul>
          )}

          {editable && (
            <DropZone
              busy={busy}
              maxBytes={maxBytes}
              label="Drop a graph or report for the whole sample here, or"
              onFile={(f) => void run(() => upload(f, null), 'The upload was rejected.')}
            />
          )}

          {editable && (
            <p className="muted attachments__hint">
              For a document that belongs to one parameter, use the clip on that row instead.
            </p>
          )}

          {!editable && rows.length === 0 && (
            <p className="muted" style={{ fontSize: '.76rem' }}>Nothing attached to this sample.</p>
          )}
        </>
      )}
    </section>
  );
}

/** The clip that sits beside an analyte's name. */
export function AttachClip({ count, open, onToggle, testName }: {
  count: number;
  open: boolean;
  onToggle: () => void;
  testName: string;
}) {
  return (
    <button
      type="button"
      className={`clip${count > 0 ? ' clip--has' : ''}${open ? ' clip--open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title={count > 0
        ? `${count} attachment${count === 1 ? '' : 's'} on ${testName}`
        : `Attach a file to ${testName}`}
      aria-label={count > 0
        ? `${count} attachment${count === 1 ? '' : 's'} on ${testName}`
        : `Attach a file to ${testName}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
      {count > 0 && <span className="clip__n">{count}</span>}
    </button>
  );
}

/**
 * What the clip opens: the documents on THIS analyte, and a way to add one.
 *
 * A row rather than a popover on purpose. The grid is a scroll container, so an
 * absolutely positioned panel inside a cell is clipped by it — the same reason
 * RangeCell has to position its tooltip fixed. A row cannot be clipped, and it
 * pushes the analytes below it down rather than covering them.
 */
export function RowAttachments({ sid, resultId, testName, canEdit, state }: {
  sid: string;
  resultId: number;
  testName: string;
  canEdit: boolean;
  state: AttachmentsState;
}) {
  const { rows, maxBytes, canAttach, canRemove, upload, remove } = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = useMemo(() => rows.filter((r) => r.resultId === resultId), [rows, resultId]);
  const editable = canEdit && canAttach;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : fallback); }
    finally { setBusy(false); }
  };

  const onRemove = (row: AttachmentRow) => {
    if (!window.confirm('Remove this attachment? This cannot be undone, though the removal is recorded.')) return;
    void run(() => remove(row.id), 'Could not remove it.');
  };

  return (
    <div className="rowattach">
      <p className="rowattach__title">Attachments on <b>{testName}</b></p>

      {error && <div className="alert alert--error" style={{ margin: '.35rem 0' }}>{error}</div>}

      {mine.length > 0 && (
        <ul className="attachments__list">
          {mine.map((r) => (
            <AttachmentItem key={r.id} sid={sid} row={r} showTest={false}
                            canRemove={canEdit && canRemove} busy={busy} onRemove={onRemove} />
          ))}
        </ul>
      )}

      {editable ? (
        <DropZone
          busy={busy}
          maxBytes={maxBytes}
          label={`Drop a file for ${testName} here, or`}
          onFile={(f) => void run(() => upload(f, resultId), 'The upload was rejected.')}
        />
      ) : mine.length === 0 && (
        <p className="muted" style={{ fontSize: '.74rem' }}>Nothing attached to this parameter.</p>
      )}
    </div>
  );
}
