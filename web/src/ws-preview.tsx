/*
 * Dev harness for the regrouped worksheet filter panel.
 *
 * Mounts Worksheet DIRECTLY rather than App, because another session is
 * mid-edit on NewOrder and App imports it — routing through App would fail on
 * someone else's half-written file rather than on anything here.
 *
 * Temporary — delete after verification. Not referenced by index.html.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { Worksheet } from './pages/Worksheet';
import './styles.css';

const rows = Array.from({ length: 8 }, (_, i) => ({
  sid: `2608${String(1000 + i)}`,
  pid: 3500000 + i,
  patientName: `PATIENT ${i + 1}`,
  clientCode: 'ABC01',
  sex: i % 2 ? 'F' : 'M',
  age: 30 + i,
  ageUnit: 'y',
  status: 'Registered',
  statusCode: 2,
  registeredAt: '2026-08-07T09:00:00+05:30',
  sampleDrawn: '2026-08-07T08:30:00+05:30',
  lastModifiedAt: '2026-08-07T09:05:00+05:30',
  departmentName: 'Biochemistry',
  testNames: 'Complete Blood Count (CBC)',
  clinicalHistory: null,
}));

const me = {
  id: 1, username: 'jas', displayName: 'Jaskirat Oberoi', email: null,
  role: 'super_admin',
  capabilities: ['result:enter', 'report:view', 'order:view', 'billing:view'],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// Echo the query back so the harness can assert what the panel actually sent.
(window as unknown as { __lastQuery?: string }).__lastQuery = '';

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);

  if (url.includes('/api/reports/filters')) {
    return json({
      departments: [{ id: 1, name: 'Biochemistry' }, { id: 2, name: 'Haematology' }],
      businessUnits: [{ id: 5, name: 'North' }],
      clientCodes: [{ code: 'ABC01', name: 'ABC DIAGNOSTIC CENTRE' }],
      tests: [{ code: 'HE011', name: 'Complete Blood Count (CBC)' }],
    });
  }
  if (url.includes('/api/reports/')) {
    (window as unknown as { __lastQuery?: string }).__lastQuery = url.split('?')[1] ?? '';
    return json({
      rows, count: rows.length, total: 1110, page: 1, pageSize: 100, pageCount: 12,
      scope: 'all', asOf: '2026-08-07T09:10:00+05:30',
    });
  }
  if (url.includes('/api/auth/me')) return json(me);
  return json({});
}) as typeof fetch;

document.cookie = 'inf_present=1; path=/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <AuthProvider>
        <Worksheet />
      </AuthProvider>
    </MemoryRouter>
  </StrictMode>,
);
