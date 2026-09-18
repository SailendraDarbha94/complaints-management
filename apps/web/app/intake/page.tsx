import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchCases, fetchTray, isUnauthorized, type CaseListRow, type TrayCard } from '@/lib/api';
import { FORWARD_KIND_LABEL, label } from '@/lib/labels';
import { TrayActions } from './tray-actions';
import { SyncButton } from './sync-button';

export const dynamic = 'force-dynamic';

/**
 * The inward tray.
 *
 * Everything forwarded to the intake address that has not yet become a case or been set
 * aside. Each card shows the COMPLAINANT — dug out of the forward — rather than the
 * officer whose name is on the envelope, because the officer already knows they forwarded
 * it and what they need to see is who is complaining and about what.
 *
 * Nothing on this screen has spent a case number. That is the point of the screen.
 */
export default async function TrayPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = 'unfiled' } = await searchParams;

  let tray: { status: string; messages: TrayCard[] };
  let cases: { cases: CaseListRow[] };
  try {
    [tray, cases] = await Promise.all([fetchTray(status), fetchCases()]);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }

  const openCases = cases.cases
    .filter((c) => c.state !== 'closed')
    .map((c) => ({ id: c.id, caseNumber: c.case_number, summary: c.summary }));

  return (
    <main className="shell">
      <nav className="crumbs">
        <Link href="/today">Today</Link>
        <span aria-hidden="true">/</span>
        <span className="here">Inward mail</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>Inward mail</h1>
          <p className="case-summary">
            Forward a complaint to the intake address and it appears here. Nothing becomes a
            case until you say so — except a reply that quotes a case number, which files
            itself onto that case.
          </p>
        </div>
        <SyncButton />
      </header>

      <nav className="crumbs">
        <Link href="/intake" className={status === 'unfiled' ? 'here' : undefined}>
          Waiting
        </Link>
        <span aria-hidden="true">/</span>
        <Link href="/intake?status=filed" className={status === 'filed' ? 'here' : undefined}>
          Filed
        </Link>
        <span aria-hidden="true">/</span>
        <Link href="/intake?status=dismissed" className={status === 'dismissed' ? 'here' : undefined}>
          Set aside
        </Link>
      </nav>

      {tray.messages.length === 0 ? (
        <div className="empty">
          <strong>
            {status === 'unfiled' ? 'Nothing waiting.' : 'Nothing here.'}
          </strong>
          {status === 'unfiled'
            ? 'Forward a complaint to the intake address and it will appear here within half a minute.'
            : 'Messages you have filed or set aside will appear here.'}
        </div>
      ) : (
        <section className="group">
          <div className="group-head g-needs_decision">
            <span>{status === 'unfiled' ? 'Waiting for you' : 'Messages'}</span>
            <span className="n">{tray.messages.length}</span>
          </div>
          {tray.messages.map((m) => (
            <Card key={m.id} message={m} cases={openCases} />
          ))}
        </section>
      )}
    </main>
  );
}

function Card({
  message,
  cases,
}: {
  message: TrayCard;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
}) {
  // The complainant, not the forwarder. Falling back to the envelope only when this was
  // written to us directly rather than forwarded.
  const who = message.original_from_name ?? message.original_from ?? message.envelope_from_name ?? message.envelope_from;
  const what = message.original_subject ?? message.subject;

  return (
    <div className="row">
      <div className="t">
        <Link className="case-link" href={`/intake/${message.id}`}>
          {what}
        </Link>
        {message.attachment_count > 0 && (
          <span className="chip chip-verbatim">
            {message.attachment_count} file{message.attachment_count === 1 ? '' : 's'}
          </span>
        )}
        {message.skipped_count > 0 && (
          <span className="chip chip-draft">{message.skipped_count} not stored</span>
        )}

        {/* Prose, so not `.meta` — inside a .row that renders monospace. */}
        <p className="action-why">{message.snippet}</p>

        <span className="meta">
          {who}
          {' · '}
          {label(FORWARD_KIND_LABEL, message.forward_kind)}
          {' · arrived '}
          {formatWhen(message.ingested_at)}
          {message.original_date_text && ` · sent ${message.original_date_text}`}
        </span>

        {message.suggestion_note && <p className="action-why">{message.suggestion_note}</p>}
      </div>

      <TrayActions
        messageId={message.id}
        cases={cases}
        suggestedCaseFileId={message.suggested_case_file_id}
        status={message.status}
      />
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const hours = (Date.now() - d.getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
