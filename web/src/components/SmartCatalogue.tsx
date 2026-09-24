import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * What the Smart Report is sold with, on the client home: every single
 * test, profile and package that carries the booklet, grouped by the tier
 * it earns, with the tier's price — and a "New" mark on anything that
 * joined the list in the last 24 hours, so a centre notices the day a
 * test it orders often starts carrying the booklet.
 *
 * Prices are optional: a sub-franchise sees the coverage but not the
 * money, exactly as the rest of its portal.
 */

interface Item { kind: 'test' | 'profile' | 'package'; code: string; name: string; addedAt: string | null; isNew: boolean }
interface Tier { tier: 'mini' | 'multi' | 'package'; listMrp: number; offerMrp: number | null }
interface Catalogue { items: Item[]; tiers: Tier[]; offerUntil: string | null; offerNote: string | null }

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

function Price({ tier }: { tier?: Tier }) {
  if (!tier) return null;
  return tier.offerMrp != null ? (
    <span className="smartcat__price">
      <s>{inr(tier.listMrp)}</s> <b>{inr(tier.offerMrp)}</b>
    </span>
  ) : (
    <span className="smartcat__price"><b>{inr(tier.listMrp)}</b></span>
  );
}

export function SmartCatalogue({ showPrices }: { showPrices: boolean }) {
  const [data, setData] = useState<Catalogue | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<Catalogue>('/api/dashboard/smart-report-catalogue')
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  // A panel that cannot load says nothing rather than something broken:
  // the home page is the account, this is a leaflet beside it.
  if (failed || (data && data.items.length === 0)) return null;

  const tierOf = (t: Tier['tier']) => data?.tiers.find((x) => x.tier === t);
  const tests = data?.items.filter((i) => i.kind === 'test') ?? [];
  const profiles = data?.items.filter((i) => i.kind === 'profile') ?? [];
  const packages = data?.items.filter((i) => i.kind === 'package') ?? [];
  const fresh = data?.items.filter((i) => i.isNew).length ?? 0;
  const until = data?.offerUntil
    ? new Date(data.offerUntil + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  const List = ({ items }: { items: Item[] }) => (
    <ul className="smartcat__list">
      {items.map((i) => (
        <li key={`${i.kind}:${i.code}`} className={i.isNew ? 'smartcat__item smartcat__item--new' : 'smartcat__item'}
            title={i.isNew ? 'Added to the Smart Report in the last 24 hours' : i.code}>
          <span className="smartcat__name">{i.name}</span>
          {i.isNew && <span className="badge badge--new">New</span>}
        </li>
      ))}
    </ul>
  );

  return (
    <section className="card smartcat" aria-busy={!data}>
      <div className="smartcat__head">
        <div>
          <h2 className="clienthome__title">Smart Report</h2>
          <p className="muted smartcat__sub">
            The patient-friendly booklet you can add to an order. It is offered with the tests below
            {until && data?.offerNote ? <> · introductory prices {data.offerNote}</> : until ? <> · introductory prices till {until}</> : null}.
          </p>
        </div>
        {fresh > 0 && (
          <span className="badge badge--new smartcat__fresh" title="Added in the last 24 hours">
            {fresh} new
          </span>
        )}
      </div>

      {!data ? (
        <p className="muted" style={{ fontSize: '.8rem' }}>Loading…</p>
      ) : (
        <div className="smartcat__groups">
          {tests.length > 0 && (
            <div className="smartcat__group">
              <h3 className="smartcat__group-title">
                Single tests
                {showPrices && (
                  <span className="smartcat__tiers">
                    <span>one test <Price tier={tierOf('mini')} /></span>
                    {tierOf('multi') && <span>two or more <Price tier={tierOf('multi')} /></span>}
                  </span>
                )}
              </h3>
              <List items={tests} />
            </div>
          )}
          {profiles.length > 0 && (
            <div className="smartcat__group">
              <h3 className="smartcat__group-title">
                Profiles
                {showPrices && <span className="smartcat__tiers"><span><Price tier={tierOf('package')} /></span></span>}
              </h3>
              <List items={profiles} />
            </div>
          )}
          {packages.length > 0 && (
            <div className="smartcat__group">
              <h3 className="smartcat__group-title">
                Health packages
                {showPrices && <span className="smartcat__tiers"><span><Price tier={tierOf('package')} /></span></span>}
              </h3>
              <List items={packages} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
