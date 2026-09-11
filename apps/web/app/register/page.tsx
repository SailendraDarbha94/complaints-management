import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PUBLIC_API_URL, fetchRegister, isUnauthorized, type RegisterRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The register.
 *
 * The formal book, laid out as it would be filed: every column, in order, one row per
 * case. Distinct from /cases, which is the working list.
 *
 * The export is what an RTI reply is assembled from, what a court is shown, and the
 * artefact that means the register survives this project ending — so it is offered
 * plainly and near the top, not buried in a settings screen.
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const { fy } = await searchParams;

  let data: { rows: RegisterRow[] };
  try {
    data = await fetchRegister(fy);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }

  // Internal identifiers are not part of the register and only make it harder to read.
  const columns = data.rows.length
    ? Object.keys(data.rows[0]!).filter((k) => k !== 'case_file_id' && k !== 'council_id')
    : [];

  const reconstructed = data.rows.filter((r) => r['Dates reconstructed']).length;
  const exportUrl = `${PUBLIC_API_URL}/v1/register/export.csv${fy ? `?fiscalYear=${encodeURIComponent(fy)}` : ''}`;

  return (
    <main className="shell shell-wide">
      <nav className="crumbs">
        <Link href="/today">Today</Link>
        <span aria-hidden="true">/</span>
        <span className="here">Register</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>The register</h1>
          <p className="case-summary">
            {data.rows.length} case{data.rows.length === 1 ? '' : 's'}
            {fy ? ` in ${fy}` : ''}. One row per case, in the order they were entered.
          </p>
        </div>
        <a className="button-link button-strong" href={exportUrl} download>
          Export to CSV
        </a>
      </header>

      <div className="banner banner-demo">
        <span className="tag">The book</span>
        <span>
          The physical register remains the legal record. This is a copy of it until the
          gated retirement, which needs ninety days of dual-running behind it.
        </span>
      </div>

      {reconstructed > 0 && (
        <div className="banner banner-bad">
          <span className="tag">Provenance</span>
          <span>
            {reconstructed} case{reconstructed === 1 ? '' : 's'} carr
            {reconstructed === 1 ? 'ies' : 'y'} dates reconstructed from the book or
            estimated, rather than recorded as they happened. The &ldquo;Dates
            reconstructed&rdquo; column names which, and the export footnotes it.
          </span>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="empty">
          <strong>The register is empty.</strong>
          Cases entered into the system will appear here.
        </div>
      ) : (
        <div className="table-scroll register-scroll">
          <table className="register-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className={NUMERIC.has(c) ? 'num' : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={String(row['Case No.'] ?? i)}>
                  {columns.map((c) => (
                    <td key={c} className={NUMERIC.has(c) ? 'num mono' : undefined}>
                      {render(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const NUMERIC = new Set(['Sl. No.', 'Days waiting']);

function render(value: RegisterRow[string] | undefined): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">-</span>;
  if (value === true) return 'Yes';
  if (value === false) return <span className="muted">-</span>;
  return String(value);
}
