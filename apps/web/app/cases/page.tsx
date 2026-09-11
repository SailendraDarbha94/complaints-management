import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchCases, isUnauthorized, type CaseListRow } from '@/lib/api';
import { STATE_LABEL, WAITING_ON_LABEL, formatDate, label } from '@/lib/labels';

export const dynamic = 'force-dynamic';

/**
 * Every case, newest first.
 *
 * Distinct from the register at /register: that one is the formal book, laid out as it
 * would be printed or filed. This is the working list — what the officer scans to find a
 * case, so it is open cases first and the columns that help you recognise one.
 */
export default async function CasesPage() {
  let data: { cases: CaseListRow[] };
  try {
    data = await fetchCases();
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }

  const open = data.cases.filter((c) => c.state !== 'closed');
  const closed = data.cases.filter((c) => c.state === 'closed');

  return (
    <main className="shell">
      <nav className="crumbs">
        <Link href="/today">Today</Link>
        <span aria-hidden="true">/</span>
        <span className="here">Cases</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>Cases</h1>
          <p className="case-summary">
            {open.length} open, {closed.length} closed.{' '}
            <Link href="/register">The formal register</Link> has every column and exports
            to CSV.
          </p>
        </div>
      </header>

      {open.length > 0 && <CaseTable title="Open" rows={open} />}
      {closed.length > 0 && <CaseTable title="Closed" rows={closed} closed />}

      {data.cases.length === 0 && (
        <div className="empty">
          <strong>No cases yet.</strong>
          Complaints entered into the register will appear here.
        </div>
      )}
    </main>
  );
}

function CaseTable({
  title,
  rows,
  closed,
}: {
  title: string;
  rows: CaseListRow[];
  closed?: boolean;
}) {
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
              <th className="num">Sl.</th>
              <th>Case no.</th>
              <th>Complainant</th>
              <th>Grievance</th>
              <th>{closed ? 'Closed' : 'Waiting on'}</th>
              <th className="num">{closed ? '' : 'Days'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="num mono">{c.register_sl_no}</td>
                <td>
                  <Link className="case-link" href={`/cases/${c.id}`}>
                    {c.case_number}
                  </Link>
                  {c.on_hold && <span className="chip chip-hold">on hold</span>}
                  {c.is_backfilled && <span className="chip chip-reconstructed">from the book</span>}
                </td>
                <td>{c.complainant_name ?? <span className="muted">suo motu</span>}</td>
                <td className="grievance">{c.summary}</td>
                <td>
                  {closed ? (
                    formatDate(c.closed_at)
                  ) : (
                    <>
                      {label(WAITING_ON_LABEL, c.waiting_on)}
                      <span className="meta">{label(STATE_LABEL, c.state)}</span>
                    </>
                  )}
                </td>
                <td className="num mono">
                  {closed ? '' : c.days_waiting != null ? Number(c.days_waiting) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
