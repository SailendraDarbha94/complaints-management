import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { fetchCases, fetchTray, isUnauthorized, type CaseListRow, type TrayCard } from '@/lib/api';
import { FORWARD_KIND_LABEL, label } from '@/lib/labels';
import { PendingLink } from '@/app/components/pending-link';
import { CardScope } from './card-scope';
import { TrayActions } from './tray-actions';
import { TraySuggestion } from './tray-suggestion';
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
        <PendingLink href="/today">Today</PendingLink>
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
        <div className="intake-head-actions">
          <SyncButton />
          {/* Shown whether or not the assistant is on: when it is off, the report page is
              where the officer learns how to switch it on, and there is no other way in. */}
          <PendingLink href="/intake/assistant" className="link-like">
            The mail assistant
          </PendingLink>
        </div>
      </header>

      <nav className="crumbs">
        <PendingLink href="/intake" className={status === 'unfiled' ? 'here' : undefined}>
          Waiting
        </PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/intake?status=filed" className={status === 'filed' ? 'here' : undefined}>
          Filed
        </PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/intake?status=dismissed" className={status === 'dismissed' ? 'here' : undefined}>
          Set aside
        </PendingLink>
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
  // The complainant, not the forwarder - as the server worked it out, so the card, the
  // message page and "Open a case" can never disagree about who it is.
  const who = message.complainant?.name ?? `complainant not known \u00b7 via ${message.envelope_from}`;
  const what = message.original_subject ?? message.subject;
  // Only a suggestion still waiting on the officer, or one that failed, belongs on the card.
  // Once it is accepted, rejected or overtaken by the ordinary buttons, the card is back to
  // what it was: the record of what became of it lives on the message page and the report.
  // `?.` and not `.`: a card from a route that does not send suggestions yet shows none.
  const suggestion =
    message.status === 'unfiled' &&
    (message.suggestion?.status === 'pending' || message.suggestion?.status === 'failed')
      ? message.suggestion
      : null;

  return (
    // The scope gives the suggestion's buttons and the ordinary ones a single "busy", so
    // one card can never send two decisions at once. It renders no element of its own.
    <CardScope>
      <div className="row">
        <div className="t">
          <PendingLink className="case-link" href={`/intake/${message.id}` as Route}>
            {what}
          </PendingLink>
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

          {suggestion && <TraySuggestion messageId={message.id} suggestion={suggestion} />}

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
          complainant={message.complainant}
        />
      </div>
    </CardScope>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const hours = (Date.now() - d.getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
