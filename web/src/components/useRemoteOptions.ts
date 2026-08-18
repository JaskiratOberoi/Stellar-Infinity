import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ComboOption } from './Combobox';

/**
 * Options for a Combobox that are too many to ship.
 *
 * The worksheet filters used to carry every centre (3,624) and the whole test
 * catalogue (1,459) inside /api/reports/filters — 349 KB fetched on load by
 * three separate screens, and the largest single cost in a ten-second
 * worksheet. Both lists are now searched server-side as the operator types.
 *
 * Two details that are easy to get wrong and both bite silently:
 *
 *   - The SELECTED value is passed to the server and pinned into the results.
 *     A Combobox's value is only a string; its label lives in the option list,
 *     so a selected centre would vanish from the control the moment someone
 *     typed something that did not match it.
 *
 *   - Responses are sequenced. A slow reply for "AG" must not overwrite a fast
 *     reply for "AG005" — the user would be shown results for a query they had
 *     already moved past. Each request carries a number and only the newest is
 *     allowed to land.
 */
export function useRemoteOptions(
  path: string,
  selected: string,
  toOption: (row: Record<string, unknown>) => ComboOption,
) {
  const [options, setOptions] = useState<ComboOption[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const search = useCallback((query: string) => {
    window.clearTimeout(timer.current);
    // 220ms: long enough that a typed code is one request rather than six,
    // short enough that the list feels attached to the keyboard.
    timer.current = window.setTimeout(() => {
      const mine = ++seq.current;
      const q = new URLSearchParams();
      if (query.trim()) q.set('q', query.trim());
      if (selected) q.set('selected', selected);

      api.get<{ rows: Record<string, unknown>[] }>(`${path}?${q}`)
        .then((r) => {
          if (mine !== seq.current) return;   // a newer query has overtaken this one
          setOptions((r.rows ?? []).map(toOption));
        })
        .catch(() => {
          // A failed lookup leaves the previous options in place rather than
          // emptying the control: "no matches" and "the network blinked" look
          // identical to an operator, and one of them is a lie.
        });
    }, 220);
  }, [path, selected, toOption]);

  // One eager fetch so the control is not empty before the first keystroke,
  // and so an already-selected value can render its label.
  useEffect(() => {
    const mine = ++seq.current;
    const q = new URLSearchParams();
    if (selected) q.set('selected', selected);
    api.get<{ rows: Record<string, unknown>[] }>(`${path}?${q}`)
      .then((r) => { if (mine === seq.current) setOptions((r.rows ?? []).map(toOption)); })
      .catch(() => { /* leave empty; typing will retry */ });
    return () => window.clearTimeout(timer.current);
  }, [path, selected, toOption]);

  return { options, search };
}
