import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Combobox } from './Combobox';

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
   * One status, or '' for the page's own default set. Reporting pins its own
   * (authorised/printed) and does not offer this control at all, which is why
   * it is optional rather than assumed.
   */
  statusId: number | '';
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

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

export interface FilterOptions {
  departments: { id: number; name: string | null }[];
  businessUnits: { id: number; name: string | null }[];
  clientCodes: { code: string; name: string | null }[];
  tests: { code: string; name: string | null }[];
}

const EMPTY_OPTIONS: FilterOptions = { departments: [], businessUnits: [], clientCodes: [], tests: [] };

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
): { key: keyof SampleFilterValues; label: string }[] {
  const out: { key: keyof SampleFilterValues; label: string }[] = [];

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
  value, options, onChange,
}: {
  value: SampleFilterValues;
  options: FilterOptions;
  onChange: (next: SampleFilterValues) => void;
}) {
  const active = useMemo(() => describeFilters(value, options), [value, options]);
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
  value, options, onChange, statusOptions, children,
}: {
  value: SampleFilterValues;
  options: FilterOptions;
  onChange: (next: SampleFilterValues) => void;
  statusOptions?: { id: number; label: string }[];
  children?: React.ReactNode;
}) {
  const set = <K extends keyof SampleFilterValues>(key: K, v: SampleFilterValues[K]) =>
    onChange({ ...value, [key]: v });

  // The dates always have a value, so "clear" means the narrowing filters —
  // wiping the window would leave the page asking for every sample ever taken.
  const clearable = hasNarrowingFilters(value);

  return (
    <div className="card filter-panel">
      <div className="filter-panel__grid">
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

        {statusOptions && (
          <label className="field">
            <span>Status</span>
            <Combobox
              value={value.statusId === '' ? '' : String(value.statusId)}
              emptyLabel="Any status"
              onChange={(v) => set('statusId', v === '' ? '' : Number(v))}
              options={statusOptions.map((st) => ({ value: String(st.id), label: st.label }))}
            />
          </label>
        )}

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

        <label className="field">
          <span>Client code</span>
          <Combobox
            value={value.clientCode}
            emptyLabel="Any centre in your scope"
            onChange={(v) => set('clientCode', v)}
            // Code and name as separate columns rather than one "AG0050A — MEHAR"
            // string: both are searchable, and an operator knows one or the other.
            options={options.clientCodes.map((c) => ({ value: c.code, label: c.code, hint: c.name }))}
          />
        </label>

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

        <label className="field">
          <span>Test</span>
          {/* Was free text, which only helped someone who already knew the code.
              The filter still SENDS a code — the server matches on the sample's
              stored codes — but you can now find it by the test's name. */}
          <Combobox
            value={value.testCode}
            emptyLabel="Any test"
            onChange={(v) => set('testCode', v)}
            options={options.tests.map((t) => ({ value: t.code, label: t.code, hint: t.name }))}
          />
        </label>

        <label className="field">
          <span>Patient number</span>
          <input className="input mono" placeholder="PID" inputMode="numeric" value={value.pid}
                 onChange={(e) => set('pid', e.target.value.replace(/D/g, ''))} />
        </label>

        <div className="field">
          <span>Time of day</span>
          <div className="row" style={{ gap: '.35rem' }}>
            {/* Native, deliberately: 00:00 to 24:00 is an ordered scale you scan,
                not a set you search, and a combobox over it is slower. */}
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
      </div>

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
