/** Shared formatters. Indian locale throughout — this is an Indian lab. */

export const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n);

/**
 * Format an API timestamp for display.
 *
 * The API emits real +05:30 offsets (see the API's NobleTime), so these are
 * unambiguous instants and Intl can be trusted with them — no manual offset
 * arithmetic, which is where this kind of code usually goes wrong.
 */
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

/** LIS age_type codes on the bill: 1 = years, 2 = months, 3 = days. */
export const fmtAge = (age: number | null, ageType: number | null) => {
  if (age == null) return '—';
  const unit = ageType === 2 ? 'mo' : ageType === 3 ? 'd' : 'y';
  return `${age}${unit}`;
};

/** LIS gender codes: 1 = male, anything else = female (the LIS is binary). */
export const fmtGender = (g: number | null) => (g == null ? '—' : g === 1 ? 'Male' : 'Female');
