import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/**
 * Home for the lab's FRONT DESK — the LIS's ENTRY user type (id 33).
 *
 * In the LIS this desk opens seven pages and no dashboard: it registers
 * orders, receives and tracks tubes, keeps the referrer lists and looks up
 * patient reports. The lab Dashboard is gated on analytics:view, which this
 * role deliberately does not hold — the day's sales are not its picture —
 * so instead of a permission notice it gets the doors it uses, in the order
 * the day runs: register, receive, look up.
 */
export function EntryHome() {
  const { user } = useAuth();
  const doors: { to: string; title: string; text: string }[] = [
    { to: '/orders/new', title: 'Register a patient',
      text: 'Raise an order — walk-in or for a client — enter the patient, pick the tests, barcode the tubes.' },
    { to: '/accessioning', title: 'Accessioning',
      text: 'Every tube still marked Sample Sent: scan to find it, register it to the bench, or reject it.' },
    { to: '/inward', title: 'Inward scans',
      text: 'Scan a tube as it arrives to confirm the work order before it is received.' },
    { to: '/reports', title: 'Patient reports',
      text: 'Find a sample by patient, SID or number; see where it stands; view and download finished reports.' },
    { to: '/orders', title: 'Orders',
      text: 'What has been booked — by day, by client, by patient.' },
    { to: '/referrers', title: 'Doctors and customers',
      text: 'The referring doctors and customers an order can name.' },
  ];

  return (
    <div className="page">
      <h1 className="page__title">{user?.displayName ?? user?.username ?? 'Front desk'}</h1>
      <p className="muted" style={{ marginTop: '.2rem' }}>Front desk · register, receive, look up</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: '1rem', marginTop: '1.2rem', maxWidth: 980 }}>
        {doors.map((d) => (
          <Link key={d.to} to={d.to} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h2 style={{ fontSize: '1.02rem' }}>{d.title}</h2>
            <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem', lineHeight: 1.6 }}>{d.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
