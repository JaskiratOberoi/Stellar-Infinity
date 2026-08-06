import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface ClientOption {
  id: number;
  code: string;
  name: string | null;
  isActive: boolean;
}

interface FiltersResponse {
  departments: unknown[];
  businessUnits: unknown[];
  clientCodes: ClientOption[];
}

/**
 * The client list, fetched once per page load and shared by every picker on it.
 *
 * Scoped server-side to what the caller may reach, so this is not a filtered
 * copy of the full roster — a user restricted to two centres receives two.
 */
let cached: Promise<ClientOption[]> | null = null;

export function loadClients(): Promise<ClientOption[]> {
  cached ??= api.get<FiltersResponse>('/api/reports/filters')
    .then((r) => r.clientCodes)
    .catch(() => {
      // Do not memoise a failure; the next mount should retry.
      cached = null;
      return [];
    });
  return cached;
}

/**
 * Choose a client.
 *
 * `activeOnly` is for order entry. A deactivated centre still has history worth
 * filtering a worklist by, but it cannot take a new order — the create
 * procedure refuses it with "Unknown or inactive collection centre". Offering
 * one on a booking form only produces that error after the operator has typed
 * out a whole patient.
 */
export function ClientPicker({
  value,
  onChange,
  activeOnly = false,
  allowNone = true,
  noneLabel = 'All clients (MRP)',
}: {
  value: number | null;
  onChange: (mcc: number | null) => void;
  activeOnly?: boolean;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const [clients, setClients] = useState<ClientOption[]>([]);

  useEffect(() => {
    let live = true;
    void loadClients().then((c) => { if (live) setClients(c); });
    return () => { live = false; };
  }, []);

  const options = activeOnly ? clients.filter((c) => c.isActive) : clients;

  return (
    <select
      className="input"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      style={{ minWidth: 220 }}
      aria-label="Client"
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.code}{c.name && c.name !== c.code ? ` — ${c.name}` : ''}
        </option>
      ))}
    </select>
  );
}
