import { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from '../api/client';
import { Combobox } from './Combobox';
import { useRemoteOptions } from './useRemoteOptions';

/**
 * The sample filter set, shared by the worksheet and reporting.
 *
 * Both screens read the same endpoint, which accepts the same filters, so they
 * are one component rather than two copies. A copy would drift the first time a
 * filter is added, and the copy that drifts is always the one you are not
 * looking at.
 *
 * These used to live behind a "More filters" disclosure on the worksheet, on
 * the reasoning that a technologist uses two of them on a normal shift and the
 * rest cost more attention than they save. That was wrong in practice: an
 * operator who cannot see a control does not know it exists, and reporting did
 * not offer them at all. They are all on screen now, and the panel folds to one
 * column on a phone rather than hiding anything.
 */

export interface SampleFilterValues {
  // The four that used to sit up in the page header, beside the title. They are
  // filters like any other and belong with the rest — see the note on
  // SampleFilters below.
  patient: string;
  sid: string;
  from: string;
  to: string;
  /**
   * One status, <c>''</c> for the page's own default set, or <c>'all'</c> for
   * no status filter at all.
   *
   * ── WHY 'all' EXISTS ────────────────────────────────────────────────────
   * The worksheet used to carry a separate "Outstanding only" checkbox, and
   * the two were one filter wearing two controls. It was handled honestly —
   * choosing a status disabled the checkbox rather than quietly overriding it
   * — but that is still a control in the panel's footer greying itself out
   * because of a dropdown several rows above, with nothing on either of them
   * saying so.
   *
   * They are one control now. '' is the page's own default set — "Outstanding"
   * on the worksheet — and 'all' is what unticking that checkbox used to mean.
   * A single selector cannot contradict itself, so nothing has to police it.
   *
   * Reporting pins its own statuses and passes no statusOptions, so the
   * control is absent there and this value is never read.
   */
  statusId: number | '' | 'all';
  clientCode: string;
  departmentId: number | '';
  businessUnitId: number | '';
  testCode: string;
  pid: string;
  fromHour: number;
  toHour: number;
}

/**
 * Everything cleared. The dates are blank here on purpose — a window is always
 * required, so each page supplies its own default through initialFilters()
 * rather than inheriting a shared guess about how far back to look.
 */
export const EMPTY_FILTERS: SampleFilterValues = {
  patient: '',
  sid: '',
  from: '',
  to: '',
  statusId: '',
  clientCode: '',
  departmentId: '',
  businessUnitId: '',
  testCode: '',
  pid: '',
  fromHour: 0,
  toHour: 24,
};

/**
 * n days back on the LOCAL calendar.
 *
 * toISOString() renders UTC, so for anyone east of Greenwich it names
 * yesterday for the first hours of every day — in IST, midnight to 05:30. The
 * window would silently open a day early, which on a worksheet is a shift's
 * worth of samples appearing or vanishing depending on what time you looked.
 */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoLocal(d);
};

/** Cleared filters over the page's own default window. */
export function initialFilters(fromDaysAgo: number): SampleFilterValues {
  return { ...EMPTY_FILTERS, from: daysAgo(fromDaysAgo), to: daysAgo(0) };
}

/** True when anything beyond the date window is narrowing the list. */
export function hasNarrowingFilters(f: SampleFilterValues): boolean {
  return Boolean(
    f.patient.trim() || f.sid.trim() || f.statusId !== '' || f.clientCode
    || f.departmentId !== '' || f.businessUnitId !== '' || f.testCode.trim()
    || f.pid.trim() || f.fromHour !== 0 || f.toHour !== 24,
  );
}

/** Local calendar date as yyyy-MM-dd — not toISOString, which is UTC. */
function isoLocal(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * The windows people actually ask for.
 *
 * Typing two dates is the most repeated act on this panel and the slowest — a
 * native date input takes six keystrokes or four clicks per side. "Today" is
 * one. The custom inputs stay right there for everything else.
 */
const DATE_PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 6 },
  { label: '30 days', days: 29 },
];

export interface FilterOptions {
  departments: { id: number; name: string | null }[];
  businessUnits: { id: number; name: string | null }[];
  /* clientCodes and tests no longer travel here: 3,624 and 1,459 entries
     made this payload 349 KB on every page load. Both are typeahead-
     searched now; the counts are kept so a screen can say how many exist. */
  clientCodeCount?: number;
  testCount?: number;
}

const EMPTY_OPTIONS: FilterOptions = { departments: [], businessUnits: [] };

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 0–24. 24 is "end of the to-date", which is why it is not 23. */
const HOURS = Array.from({ length: 25 }, (_, i) => i);

/**
 * Fetched once. Departments and business units are lab reference data, and the
 * client-code list is already scoped by the API to what this user can reach —
 * so there is nothing here to re-fetch as filters change.
 */
export function useFilterOptions(): FilterOptions {
  const [options, setOptions] = useState<FilterOptions>(EMPTY_OPTIONS);

  useEffect(() => {
    let live = true;
    api.get<FilterOptions>('/api/reports/filters')
      .then((r) => { if (live) setOptions(r); })
      .catch(() => { /* Dropdowns degrade to empty; the rest of the screen works. */ });
    return () => { live = false; };
  }, []);

  return options;
}

/** Human-readable labels for whatever filters are currently applied. */
export function describeFilters(
  f: SampleFilterValues,
  options: FilterOptions,
  statusOptions?: { id: number; label: string }[],
): { key: keyof SampleFilterValues; label: string }[] {
  const out: { key: keyof SampleFilterValues; label: string }[] = [];

  // Status leads: it is the filter that decides whether the list is a work
  // queue or an archive, and since it absorbed the old "Outstanding only"
  // checkbox it is the one most worth being able to see and undo from here.
  // '' is the page default and is not a narrowing, so it produces no chip.
  if (f.statusId === 'all') {
    out.push({ key: 'statusId', label: 'Any status' });
  } else if (f.statusId !== '') {
    const s = statusOptions?.find((x) => x.id === f.statusId);
    out.push({ key: 'statusId', label: s?.label ?? `Status ${f.statusId}` });
  }

  if (f.clientCode) out.push({ key: 'clientCode', label: `Client ${f.clientCode}` });
  if (f.departmentId !== '') {
    const d = options.departments.find((x) => x.id === f.departmentId);
    out.push({ key: 'departmentId', label: d?.name ?? `Department ${f.departmentId}` });
  }
  if (f.businessUnitId !== '') {
    const b = options.businessUnits.find((x) => x.id === f.businessUnitId);
    out.push({ key: 'businessUnitId', label: b?.name ?? `Unit ${f.businessUnitId}` });
  }
  if (f.testCode.trim()) out.push({ key: 'testCode', label: `Test ${f.testCode.trim()}` });
  if (f.pid.trim()) out.push({ key: 'pid', label: `PID ${f.pid.trim()}` });
  // The two hours read as one range: "08:00–20:00" is the thing the operator
  // set, not two independent facts.
  if (f.fromHour !== 0 || f.toHour !== 24) {
    out.push({ key: 'fromHour', label: `${pad2(f.fromHour)}:00–${pad2(f.toHour)}:00` });
  }

  return out;
}

/**
 * Write the applied filters onto a query string.
 *
 * Every filter goes to the SERVER so that paging and the total count describe
 * the same set the operator is looking at. Filtering a page after it arrives
 * makes 50 rows display as 6 with a dead Next button, which reads as "that is
 * all there is" when it is not.
 */
export function applyFilterParams(p: URLSearchParams, f: SampleFilterValues): void {
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.patient.trim()) p.set('patient', f.patient.trim());
  if (f.sid.trim()) p.set('sid', f.sid.trim());
  if (f.clientCode) p.set('clientCode', f.clientCode);
  if (f.departmentId !== '') p.set('departmentId', String(f.departmentId));
  if (f.businessUnitId !== '') p.set('businessUnitId', String(f.businessUnitId));
  if (f.testCode.trim()) p.set('testCode', f.testCode.trim());
  if (f.pid.trim()) p.set('pid', f.pid.trim());
  if (f.fromHour !== 0) p.set('fromHour', String(f.fromHour));
  if (f.toHour !== 24) p.set('toHour', String(f.toHour));
}

/** The chips above the panel: what is currently narrowing the list, removable. */
export function ActiveFilterChips({
  value, options, onChange, statusOptions,
}: {
  value: SampleFilterValues;
  options: FilterOptions;
  onChange: (next: SampleFilterValues) => void;
  statusOptions?: { id: number; label: string }[];
}) {
  const active = useMemo(
    () => describeFilters(value, options, statusOptions),
    [value, options, statusOptions],
  );
  if (active.length === 0) return null;

  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem', marginBottom: '.8rem' }}>
      {active.map((f) => (
        <button
          key={f.key}
          className="chip"
          title="Remove this filter"
          onClick={() => onChange({
            ...value,
            // The hour pair is one filter to the operator, so it clears as one.
            ...(f.key === 'fromHour'
              ? { fromHour: 0, toHour: 24 }
              : { [f.key]: EMPTY_FILTERS[f.key] }),
          })}
        >
          {f.label} <span aria-hidden="true">×</span>
        </button>
      ))}
      <button className="btn btn--ghost btn--sm" onClick={() => onChange(EMPTY_FILTERS)}>
        Clear all
      </button>
    </div>
  );
}

/**
 * One filter area.
 *
 * The name, SID, status and dates used to live up in the page header beside the
 * title, with the rest in a card below — so the same job was split across two
 * places that looked like different kinds of thing. They are all filters; they
 * are all here now, in one grid, in the order an operator reaches for them.
 *
 * `statusOptions` is what makes this reusable rather than worksheet-specific:
 * reporting pins its own status set and passes nothing, so the control is
 * absent there instead of offering a choice the page would override.
 *
 * `children` is the page's own switches — the worksheet's "Outstanding only"
 * and "Group by patient" — which sit in the panel's footer so that every
 * control that changes the list is inside one boundary.
 */
export function SampleFilters({
  value, options, onChange, statusOptions, defaultStatusLabel, lockClientCode, children,
}: {
  value: SampleFilterValues;
  options: FilterOptions;
  onChange: (next: SampleFilterValues) => void;
  statusOptions?: { id: number; label: string }[];
  /**
   * What the page's default status set is CALLED — "Outstanding" on the
   * worksheet. Naming it turns the empty value from "no filter" into a real,
   * selectable choice, which is what lets the separate checkbox go away.
   * Omit it and the empty value reads "Any status", with no default set.
   */
  defaultStatusLabel?: string;
  /**
   * Pin the client filter to the signed-in account's own scope.
   *
   * For a collection centre, whose reports are their own by definition. The
   * control stays visible — an absent filter reads as "this page shows
   * everything" — but it cannot be changed, because there is nothing else it
   * could legitimately be set to.
   *
   * Cosmetic, and deliberately so: the API resolves the client scope from the
   * session on every request, so a centre that edited this in the console
   * would still get exactly its own rows back. This stops the control implying
   * a choice that does not exist.
   */
  lockClientCode?: boolean;
  children?: React.ReactNode;
}) {
  /* The two lists that no longer travel in the filter payload. Each is told
     the current selection so the server can pin it into the results - without
     that, choosing a centre and then typing would blank the control. */
  const { options: clientOptions, search: searchClients } = useRemoteOptions(
    '/api/reports/clients/search',
    value.clientCode,
    // Code and name as separate columns rather than one joined string: both
    // are searchable and an operator knows one or the other.
    useCallback((r: Record<string, unknown>) => ({
      value: String(r.code ?? ''), label: String(r.code ?? ''),
      hint: (r.name as string | null) ?? null,
    }), []));

  const { options: testOptions, search: searchTests } = useRemoteOptions(
    '/api/reports/tests/search',
    value.testCode,
    useCallback((r: Record<string, unknown>) => ({
      value: String(r.code ?? ''), label: String(r.code ?? ''),
      hint: (r.name as string | null) ?? null,
    }), []));

  const set = <K extends keyof SampleFilterValues>(key: K, v: SampleFilterValues[K]) =>
    onChange({ ...value, [key]: v });

  // The dates always have a value, so "clear" means the narrowing filters —
  // wiping the window would leave the page asking for every sample ever taken.
  const clearable = hasNarrowingFilters(value);

  const preset = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    onChange({ ...value, from: isoLocal(from), to: isoLocal(to) });
  };

  const activePreset = DATE_PRESETS.find(
    (p) => value.to === daysAgo(0) && value.from === daysAgo(p.days),
  );

  return (
    <div className="card filter-panel">
      {/* Three groups, because there are three questions: which sample, from
          when, and narrowed how. They were one undifferentiated run of eleven
          identical boxes, which gives the eye no entry point and puts the two
          halves of the time window — the dates and the hours — on different
          rows with five unrelated controls between them.

          fieldset/legend rather than a div and a heading: this IS a group of
          form controls, and the grouping then reaches assistive technology for
          free instead of being purely visual. */}
      <fieldset className="fgroup fgroup--find">
        <legend>Find a sample</legend>
        <div className="fgroup__grid fgroup__grid--find">
          <label className="field">
            <span>Patient name</span>
            <input className="input" placeholder="Any patient" value={value.patient}
                   onChange={(e) => set('patient', e.target.value)} />
          </label>

          <label className="field">
            <span>SID</span>
            <input className="input mono" placeholder="Any sample" value={value.sid}
                   onChange={(e) => set('sid', e.target.value)} />
          </label>

          <label className="field">
            <span>Patient number</span>
            <input className="input mono" placeholder="PID" inputMode="numeric" value={value.pid}
                   onChange={(e) => set('pid', e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
      </fieldset>

      <fieldset className="fgroup fgroup--when">
        <legend>When</legend>
        <div className="fgroup__grid fgroup__grid--when">
          <label className="field">
            <span>From</span>
            <input className="input" type="date" value={value.from} max={value.to || undefined}
                   onChange={(e) => set('from', e.target.value)} />
          </label>

          <label className="field">
            <span>To</span>
            <input className="input" type="date" value={value.to} min={value.from || undefined}
                   onChange={(e) => set('to', e.target.value)} />
          </label>

          <div className="field">
            <span>Time of day</span>
            <div className="row" style={{ gap: '.35rem' }}>
              {/* Native, deliberately: 00:00 to 24:00 is an ordered scale you
                  scan, not a set you search, and a combobox over it is slower. */}
              <select className="input" value={value.fromHour} aria-label="From hour"
                      onChange={(e) => set('fromHour', Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>{pad2(h)}:00</option>)}
              </select>
              <span className="muted">to</span>
              <select className="input" value={value.toHour} aria-label="To hour"
                      onChange={(e) => set('toHour', Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>{pad2(h)}:00</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <span>Quick range</span>
            <div className="seg" role="group" aria-label="Quick date range">
              {DATE_PRESETS.map((p) => (
                <button key={p.label} type="button"
                        className={`seg__btn${activePreset?.label === p.label ? ' is-on' : ''}`}
                        aria-pressed={activePreset?.label === p.label}
                        onClick={() => preset(p.days)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset className="fgroup fgroup--narrow">
        <legend>Narrow to</legend>
        <div className="fgroup__grid fgroup__grid--narrow">
          {statusOptions && (
            <label className="field">
              <span>Status</span>
              {/* Absorbs what used to be a separate "Outstanding only"
                  checkbox in the footer — one filter that needed two controls
                  to police each other across the panel. See statusId. */}
              <Combobox
                value={value.statusId === '' ? '' : String(value.statusId)}
                emptyLabel={defaultStatusLabel ?? 'Any status'}
                onChange={(v) => set('statusId', v === '' ? '' : v === 'all' ? 'all' : Number(v))}
                options={[
                  ...(defaultStatusLabel ? [{ value: 'all', label: 'Any status' }] : []),
                  ...statusOptions.map((st) => ({ value: String(st.id), label: st.label })),
                ]}
              />
            </label>
          )}

          <label className="field">
            <span>Client code</span>
            {lockClientCode ? (
              /* A READ-BACK, not a greyed-out picker. The disabled combobox
                 said "Your account" and named nobody — a centre looking at its
                 own reports should see its own code where every other role sees
                 a code. The search endpoint already returns a client exactly
                 one row (their own centre), so the first option IS the account;
                 until it lands the wording falls back to the rule. */
              <div className="input" aria-readonly="true"
                   style={{ display: 'flex', alignItems: 'center', gap: '.45rem',
                            cursor: 'default', background: 'var(--accent-softer)' }}>
                <b className="mono">{clientOptions[0]?.label ?? 'Your account'}</b>
                {clientOptions[0]?.hint && (
                  <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clientOptions[0].hint}
                  </span>
                )}
                {/* a small lock, so the fixed value reads as pinned rather than broken */}
                <svg viewBox="0 0 16 16" aria-hidden="true"
                     style={{ width: 12, height: 12, marginLeft: 'auto', flex: 'none', opacity: .45 }}>
                  <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4"/>
                </svg>
              </div>
            ) : (
              <Combobox
                value={value.clientCode}
                emptyLabel="Any centre in your scope"
                onChange={(v) => set('clientCode', v)}
                // Code and name as separate columns rather than one "AG0050A — MEHAR"
                // string: both are searchable, and an operator knows one or the other.
                options={clientOptions}
                onQueryChange={searchClients}
              />
            )}
            {lockClientCode && (
              <span className="muted" style={{ fontSize: '.72rem' }}>
                Reports are limited to your own account.
              </span>
            )}
          </label>

          {/* Not for a client account. Departments are the LAB's sections —
              how work is benched, not how a centre thinks about its patients'
              reports — and the Test filter beside it already narrows by what
              was actually ordered. Unlike the unit list this is no leak (the
              department is printed on their own reports), so it is hidden
              rather than emptied server-side. */}
          {!lockClientCode && (
            <label className="field">
              <span>Department</span>
              <Combobox
                value={value.departmentId === '' ? '' : String(value.departmentId)}
                emptyLabel="Any department"
                onChange={(v) => set('departmentId', v === '' ? '' : Number(v))}
                options={options.departments.map((d) => ({
                  value: String(d.id), label: d.name ?? `Department ${d.id}`,
                }))}
              />
            </label>
          )}

          <label className="field">
            <span>Test</span>
            {/* Was free text, which only helped someone who already knew the code.
                The filter still SENDS a code — the server matches on the sample's
                stored codes — but you can now find it by the test's name. */}
            <Combobox
              value={value.testCode}
              emptyLabel="Any test"
              onChange={(v) => set('testCode', v)}
              options={testOptions}
              onQueryChange={searchTests}
            />
          </label>

          {/* Not for a client account. Their reports are pinned to their own
              client code, so a unit filter can only narrow a set that is
              already theirs — and the options are the lab's internal geography.
              The API empties the list for them too; hiding the control is what
              stops the panel offering an empty dropdown. */}
          {!lockClientCode && (
            <label className="field">
              <span>Business unit</span>
              <Combobox
                value={value.businessUnitId === '' ? '' : String(value.businessUnitId)}
                emptyLabel="Any unit"
                onChange={(v) => set('businessUnitId', v === '' ? '' : Number(v))}
                options={options.businessUnits.map((b) => ({
                  value: String(b.id), label: b.name ?? `Unit ${b.id}`,
                }))}
              />
            </label>
          )}
        </div>
      </fieldset>

      <div className="filter-panel__foot">
        {children}
        {clearable && (
          <button
            className="btn btn--ghost btn--sm filter-panel__clear"
            onClick={() => onChange({ ...EMPTY_FILTERS, from: value.from, to: value.to })}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
