import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

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
  clientCode: string;
  departmentId: number | '';
  businessUnitId: number | '';
  testCode: string;
  pid: string;
  fromHour: number;
  toHour: number;
}

export const EMPTY_FILTERS: SampleFilterValues = {
  clientCode: '',
  departmentId: '',
  businessUnitId: '',
  testCode: '',
  pid: '',
  fromHour: 0,
  toHour: 24,
};

export interface FilterOptions {
  departments: { id: number; name: string | null }[];
  businessUnits: { id: number; name: string | null }[];
  clientCodes: { code: string; name: string | null }[];
}

const EMPTY_OPTIONS: FilterOptions = { departments: [], businessUnits: [], clientCodes: [] };

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

export function SampleFilters({
  value, options, onChange,
}: {
  value: SampleFilterValues;
  options: FilterOptions;
  onChange: (next: SampleFilterValues) => void;
}) {
  const set = <K extends keyof SampleFilterValues>(key: K, v: SampleFilterValues[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div className="card filter-panel">
      <div className="filter-panel__grid">
        <label className="field">
          <span>Client code</span>
          <select className="input" value={value.clientCode}
                  onChange={(e) => set('clientCode', e.target.value)}>
            <option value="">Any centre in your scope</option>
            {options.clientCodes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}{c.name ? ` — ${c.name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Department</span>
          <select className="input" value={value.departmentId}
                  onChange={(e) => set('departmentId', e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">Any department</option>
            {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Business unit</span>
          <select className="input" value={value.businessUnitId}
                  onChange={(e) => set('businessUnitId', e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">Any unit</option>
            {options.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Test code</span>
          <input className="input mono" placeholder="e.g. HE011" value={value.testCode}
                 onChange={(e) => set('testCode', e.target.value)} />
        </label>

        <label className="field">
          <span>Patient number</span>
          <input className="input mono" placeholder="PID" inputMode="numeric" value={value.pid}
                 onChange={(e) => set('pid', e.target.value.replace(/\D/g, ''))} />
        </label>

        <div className="field">
          <span>Time of day</span>
          <div className="row" style={{ gap: '.35rem' }}>
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

      <p className="muted" style={{ fontSize: '.72rem', marginTop: '.7rem', lineHeight: 1.6 }}>
        The same filters the LIS worksheet offers, with one exception: the LIS's <b>TAT</b> checkbox is
        passed to its stored procedure but never used by it, so ticking it there changes nothing. It is
        left out here rather than reproduced as a control that does nothing.
      </p>
    </div>
  );
}
