import { redirect } from 'next/navigation';
import {
  fetchRtiRegister,
  isUnauthorized,
  type RtiClock,
  type RtiRequest,
} from '@/lib/api';
import { RTI_CHANNEL_LABEL, RTI_STATE_LABEL, label } from '@/lib/labels';
import { PendingLink } from '../components/pending-link';
import { OfficersPanel } from './officers-panel';

export const dynamic = 'force-dynamic';

type Row = RtiRequest & { clock: RtiClock };

/**
 * The RTI register.
 *
 * A second book, kept next to the complaints register rather than inside it. At about one
 * application a month this list is never long, so it is a single table with the only
 * column that decides anything - how long is left - carrying the colour.
 *
 * The banner at the top is not decoration. Until somebody records who the First Appellate
 * Authority is, every refusal this council issues is defective on its face under
 * s.7(8)(iii), and that is worth saying before the officer logs the next application
 * rather than at the moment they try to send a letter.
 */
export default async function RtiRegisterPage() {
  let data: { requests: Row[] };
  try {
    data = await fetchRtiRegister();
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }

  const live = data.requests.filter((r) => !r.closed_at && !r.reply_despatched_on);
  const answered = data.requests.filter((r) => r.closed_at || r.reply_despatched_on);
  const late = live.filter((r) => r.clock.daysRemaining < 0);
  const soon = live.filter((r) => r.clock.daysRemaining >= 0 && r.clock.daysRemaining <= 7);

  return (
    <main className="shell">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">RTI</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>Right to Information</h1>
          <p className="case-summary">
            {live.length} open, {answered.length} answered. Every period here is counted in
            calendar days from the Council&rsquo;s own inward date, because that is how the
            Commission counts them.
          </p>
        </div>
        <PendingLink className="action" href="/rti/new">
          Log an application
        </PendingLink>
      </header>

      <OfficersPanel />

      {(late.length > 0 || soon.length > 0) && (
        <div className={`banner ${late.length ? 'banner-bad' : 'banner-demo'}`}>
          <span className="tag">Deadlines</span>
          <span>
            {late.length > 0 &&
              `${late.length} past the statutory period. Under s.7(2) each is a deemed refusal, and s.20(1) exposes the Public Information Officer personally to Rs 250 a day. `}
            {soon.length > 0 && `${soon.length} due within a week.`}
          </span>
        </div>
      )}

      {live.length > 0 && <Table title="Open" rows={live} />}
      {answered.length > 0 && <Table title="Answered" rows={answered} answered />}

      {data.requests.length === 0 && (
        <div className="empty">
          <strong>No RTI applications yet.</strong>
          Applications arriving at registrar@ksdc.in or by post are entered here, and the
          thirty days starts from the day they arrived rather than the day they are typed in.
        </div>
      )}
    </main>
  );
}

function Table({ title, rows, answered }: { title: string; rows: Row[]; answered?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {title} <span className="n">{rows.length}</span>
        </h2>
      </div>
      <div className="table-scroll">
        <table className="inner-table">
          <thead>
            <tr>
              <th>RTI no.</th>
              <th>Received</th>
              <th>Applicant</th>
              <th>Asked for</th>
              <th>{answered ? 'Answered' : 'Stage'}</th>
              <th className="num">{answered ? 'Days taken' : 'Due'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <PendingLink className="case-link" href={`/rti/${r.id}`}>
                    {r.rti_no}
                  </PendingLink>
                  {r.life_or_liberty && <span className="chip chip-hold">48 hours</span>}
                </td>
                <td className="mono">{shortDate(r.received_on)}</td>
                <td>{r.applicant_name}</td>
                <td className="grievance">{truncate(r.request_text, 70)}</td>
                <td>
                  {label(RTI_STATE_LABEL, r.state)}
                  <span className="meta">{label(RTI_CHANNEL_LABEL, r.received_via)}</span>
                </td>
                <td className="num">
                  {answered ? (
                    <span className="mono">{daysTaken(r)}</span>
                  ) : (
                    <>
                      <span className={`rti-days ${urgencyClass(r.clock)}`}>
                        {r.clock.daysRemaining < 0
                          ? `${-r.clock.daysRemaining}d over`
                          : `${r.clock.daysRemaining}d`}
                      </span>
                      <span className="meta">{shortDate(r.clock.dueOn)}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function urgencyClass(clock: RtiClock): string {
  if (clock.daysRemaining < 0) return 'late';
  if (clock.daysRemaining <= 7) return 'soon';
  return '';
}

function daysTaken(r: Row): string {
  if (!r.reply_despatched_on) return '-';
  const from = Date.parse(`${r.received_on}T00:00:00Z`);
  const to = Date.parse(`${r.reply_despatched_on}T00:00:00Z`);
  return `${Math.round((to - from) / 86_400_000)}`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}\u2026`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}
