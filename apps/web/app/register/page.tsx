import { redirect } from 'next/navigation';
import { PendingLink } from '@/app/components/pending-link';
import { PUBLIC_API_URL, fetchRegister, isUnauthorized, type RegisterRow } from '@/lib/api';
import { CANCELLED_LABEL } from '@/lib/labels';

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

  // Cases cancelled as opened in error. The view keeps them - a number missing from the
  // book is a gap nobody can explain - with "Status" saying cancelled and the reason in a
  // column appended at the end (CREATE OR REPLACE VIEW can only append). That column is
  // found by its heading rather than named here, so rewording the heading in a migration
  // cannot silently unmark every cancelled row on this screen.
  const reasonColumn = columns.find(
    (k) => k !== 'Status' && /cancel|opened in error|deletion/i.test(k),
  );
  const isCancelled = (row: RegisterRow): boolean =>
    /^cancel/i.test(String(row['Status'] ?? '')) ||
    (reasonColumn !== undefined && Boolean(row[reasonColumn]));
  const cancelledCount = data.rows.filter(isCancelled).length;

  const exportUrl = `${PUBLIC_API_URL}/v1/register/export.csv${fy ? `?fiscalYear=${encodeURIComponent(fy)}` : ''}`;

  return (
    <main className="shell shell-wide">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
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

      {cancelledCount > 0 && (
        <div className="banner banner-void">
          <span className="tag">{CANCELLED_LABEL}</span>
          <span>
            {cancelledCount === 1
              ? 'One case was cancelled as opened in error. It keeps its number, so the register has no gap, and is struck through below'
              : `${cancelledCount} cases were cancelled as opened in error. They keep their numbers, so the register has no gap, and are struck through below`}
            {reasonColumn ? <> with the reason under &ldquo;{reasonColumn}&rdquo;</> : ''}.{' '}
            {cancelledCount === 1 ? 'Its case number opens it' : 'Each case number opens the case'},
            where it can be restored.
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
              {data.rows.map((row, i) => {
                const cancelled = isCancelled(row);
                const reason = reasonColumn ? row[reasonColumn] : null;
                return (
                  <tr key={String(row['Case No.'] ?? i)} className={cancelled ? 'cancelled' : undefined}>
                    {columns.map((c) => (
                      <td
                        key={c}
                        className={
                          NUMERIC.has(c) ? 'num mono' : c === reasonColumn ? 'reason' : undefined
                        }
                        // The cells are cut to a width with an ellipsis; a reason is a sentence,
                        // and the whole of it is one hover away.
                        title={c === reasonColumn && reason ? String(reason) : undefined}
                      >
                        {c === 'Case No.' ? (
                          <CaseNo row={row} cancelled={cancelled} reason={reason} />
                        ) : (
                          render(row[c])
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const NUMERIC = new Set(['Sl. No.', 'Days waiting']);

/**
 * The case number, as a way into the case.
 *
 * Linked on every row, but it is the cancelled ones that need it: they are on no working
 * list, so this book is the only place the officer can find one again to restore it. A
 * cancelled number is struck through - still in the book, visibly not a live case - with
 * the chip saying so in words and carrying the reason on hover.
 */
function CaseNo({
  row,
  cancelled,
  reason,
}: {
  row: RegisterRow;
  cancelled: boolean;
  reason: RegisterRow[string] | null | undefined;
}) {
  const number = String(row['Case No.'] ?? '');
  const id = row.case_file_id;
  const text = cancelled ? <s>{number}</s> : number;
  return (
    <>
      {typeof id === 'string' ? (
        <PendingLink className="case-link" href={`/cases/${id}`}>
          {text}
        </PendingLink>
      ) : (
        text
      )}
      {cancelled && (
        <span className="chip chip-cancelled" title={reason ? String(reason) : undefined}>
          {CANCELLED_LABEL.toLowerCase()}
        </span>
      )}
    </>
  );
}

function render(value: RegisterRow[string] | undefined): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">-</span>;
  if (value === true) return 'Yes';
  if (value === false) return <span className="muted">-</span>;
  return String(value);
}
