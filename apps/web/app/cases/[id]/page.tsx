import { notFound, redirect } from 'next/navigation';
import { PendingLink } from '@/app/components/pending-link';
import {
  PUBLIC_API_URL,
  fetchCase,
  isUnauthorized,
  type CaseDetail,
  type CaseHistoryEntry,
  type CaseMail,
  type CaseMilestone,
} from '@/lib/api';
import {
  CLOSURE_REASON_LABEL,
  DOCUMENT_CLASS_LABEL,
  EVENT_LABEL,
  FORWARD_KIND_LABEL,
  LETTER_LABEL,
  MILESTONE_LABEL,
  NOTICE_STATE_LABEL,
  PARTY_ROLE_LABEL,
  STATE_LABEL,
  WAITING_ON_LABEL,
  formatBytes,
  formatDate,
  formatDateTime,
  label,
} from '@/lib/labels';
import { RespondentsPanel } from './add-respondent';
import { CaseActions } from './case-actions';
import { DocumentUpload } from './document-upload';

export const dynamic = 'force-dynamic';

/**
 * The case file.
 *
 * Everything the officer needs to decide what to do next, in the order they need it:
 * where the case stands, who it is waiting on, what is scheduled, then the chronology
 * that explains how it got here.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: CaseDetail;
  try {
    data = await fetchCase(id);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }
  if (!data.case) notFound();

  const c = data.case;
  const complainant = data.parties.find((p) => p.role === 'complainant');
  const patient = data.parties.find((p) => p.role === 'patient');
  const daysWaiting = Math.floor(
    (Date.now() - new Date(c.waiting_since).getTime()) / 86_400_000,
  );

  return (
    <main className="shell">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/cases">Cases</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">{c.case_number}</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>{c.case_number}</h1>
          <p className="case-summary">{c.summary}</p>
        </div>
        <dl className="case-status">
          <div>
            <dt>Status</dt>
            <dd>{label(STATE_LABEL, c.state)}</dd>
          </div>
          <div>
            <dt>Waiting on</dt>
            <dd>{label(WAITING_ON_LABEL, c.waiting_on)}</dd>
          </div>
          <div>
            <dt>Days waiting</dt>
            <dd className="mono">{c.state === 'closed' ? '-' : daysWaiting}</dd>
          </div>
          <div>
            <dt>Sl. No.</dt>
            <dd className="mono">{c.register_sl_no}</dd>
          </div>
        </dl>
      </header>

      {c.on_hold && (
        <div className="banner banner-demo">
          <span className="tag">On hold</span>
          <span>{c.hold_reason} — deadlines are suspended and this case is off the queue.</span>
        </div>
      )}

      {c.closed_at && (
        <div className="banner banner-ok">
          <span className="tag">Closed</span>
          <span>
            {formatDate(c.closed_at)} — {label(CLOSURE_REASON_LABEL, c.closure_reason)}
          </span>
        </div>
      )}

      {c.is_backfilled && (
        <div className="banner banner-demo">
          <span className="tag">From the book</span>
          <span>
            Entered from the physical register
            {c.legacy_register_ref ? ` (${c.legacy_register_ref})` : ''}. Dates marked
            &ldquo;reconstructed&rdquo; below were not recorded as they happened.
          </span>
        </div>
      )}

      <div className="case-grid">
        <div className="case-main">
          <Section title="What happens next">
            {data.followups.length === 0 ? (
              <p className="muted">
                Nothing is scheduled against this case. The nightly sweep will flag it.
              </p>
            ) : (
              <ul className="plain">
                {data.followups.map((f) => (
                  <li key={f.id} className="followup-row">
                    <span>{f.title}</span>
                    <span className="mono muted">
                      due {formatDate(f.dueOn)}
                      {f.escalationLevel > 0 && ` · reminder ${f.escalationLevel + 1}`}
                      {f.snoozedUntil && ` · snoozed to ${formatDate(f.snoozedUntil)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {data.mail[0] && <Complaint mail={data.mail[0]} />}

          {data.rtiRequests.length > 0 && (
            <Section title="Asked about under the RTI Act">
              {/*
                An RTI application on a case is not a note. It is the reason somebody
                outside the Council is entitled to see part of this file, and it runs on a
                statutory clock with a penalty attached to a named officer, so it belongs
                where the officer is already looking rather than only in its own book.
              */}
              <ul className="plain">
                {data.rtiRequests.map((r) => (
                  <li key={r.id} className="followup-row">
                    <PendingLink className="case-link" href={`/rti/${r.id}`}>
                      {r.rti_no}
                    </PendingLink>
                    <span className="mono muted">
                      received {formatDate(r.received_on)} · reply due {formatDate(r.due_on)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <CaseActions
            caseId={c.id}
            apiUrl={PUBLIC_API_URL}
            events={data.availableEvents.map((e) => ({ ...e, label: label(EVENT_LABEL, e.event) }))}
            respondents={data.respondents.map((r) => ({ id: r.id, name: r.full_name }))}
          />

          <Section
            title="Letters"
            action={
              c.state === 'closed' ? undefined : (
                <PendingLink className="button-link" href={`/cases/${c.id}/compose`}>
                  Draft a letter
                </PendingLink>
              )
            }
          >
            {data.letters.length === 0 ? (
              <p className="muted">Nothing sent or received yet.</p>
            ) : (
              <table className="inner-table">
                <thead>
                  <tr>
                    <th>Letter</th>
                    <th>To / from</th>
                    <th>Sent</th>
                    <th>Dispatch no.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.letters.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {label(LETTER_LABEL, l.kind)}
                        {l.direction === 'in' && <span className="chip chip-in">in</span>}
                        {l.body?.trim() ? (
                          // Every letter readable where it is listed, rather than a subject
                          // line and nothing behind it.
                          <details className="letter-body">
                            <summary className="meta">{l.subject}</summary>
                            <div className="rti-letter">{l.body}</div>
                          </details>
                        ) : (
                          <span className="meta">{l.subject}</span>
                        )}
                      </td>
                      <td>{l.to_name ?? l.from_email ?? '-'}</td>
                      <td className="mono">
                        {l.sent_at || l.received_at ? (
                          formatDate(l.sent_at ?? l.received_at)
                        ) : (
                          <span className="chip chip-draft">draft</span>
                        )}
                      </td>
                      <td className="mono">{l.despatch_no ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Documents">
            <DocumentUpload caseId={c.id} apiUrl={PUBLIC_API_URL} />
            {data.documents.length === 0 ? (
              <p className="muted">No documents filed.</p>
            ) : (
              <table className="inner-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Kind</th>
                    <th>Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((d) => (
                    <tr key={d.id} className={d.status === 'stored' ? '' : 'withdrawn'}>
                      <td>
                        {d.title}
                        <span className="meta">
                          {d.filename}
                          {d.versionNo > 1 && ` · v${d.versionNo}`}
                          {d.physicalOriginalHeld && !d.physicalReturnedAt && ' · original held'}
                        </span>
                      </td>
                      <td>
                        {label(DOCUMENT_CLASS_LABEL, d.documentClass)}
                        {!d.mayBeSummarised && (
                          <span className="chip chip-verbatim" title="Never summarised or extracted">
                            verbatim
                          </span>
                        )}
                      </td>
                      <td className="mono">{formatBytes(d.sizeBytes)}</td>
                      <td>
                        {d.status === 'stored' ? (
                          <a
                            className="link-like"
                            href={`${PUBLIC_API_URL}/v1/documents/${d.id}/download`}
                            data-download={d.id}
                          >
                            Open
                          </a>
                        ) : (
                          <span className="muted">withdrawn</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Chronology">
            <Chronology milestones={data.milestones} history={data.history} />
          </Section>
        </div>

        <aside className="case-side">
          <Section title="Complainant">
            {complainant ? (
              <dl className="pairs">
                <div>
                  <dt>Name</dt>
                  <dd>{complainant.full_name}</dd>
                </div>
                {complainant.mobile && (
                  <div>
                    <dt>Phone</dt>
                    <dd>
                      <a href={`tel:${complainant.mobile.replace(/\s/g, '')}`}>
                        {complainant.mobile}
                      </a>
                    </dd>
                  </div>
                )}
                {complainant.email && (
                  <div>
                    <dt>Email</dt>
                    <dd className="wrap">{complainant.email}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="muted">
                {c.case_kind === 'ethics_notice' ? 'Suo motu — no complainant.' : 'Not recorded.'}
              </p>
            )}
          </Section>

          {patient && patient.full_name !== complainant?.full_name && (
            <Section title="Patient">
              <dl className="pairs">
                <div>
                  <dt>Name</dt>
                  <dd>{patient.full_name}</dd>
                </div>
                {(patient.age_years || patient.sex) && (
                  <div>
                    <dt>Age / sex</dt>
                    <dd className="mono">
                      {[patient.age_years, patient.sex].filter(Boolean).join(' / ')}
                    </dd>
                  </div>
                )}
              </dl>
            </Section>
          )}

          {/* Its own panel rather than a Section: the add form opens in the body, and the
              client component holding it has to own the header button as well. */}
          <RespondentsPanel
            caseId={c.id}
            title={`Respondents (${data.respondents.length})`}
            disabled={c.state === 'closed'}
          >
            {data.respondents.length === 0 ? (
              <p className="muted">
                None named yet. A notice cannot be issued until one is — the ladder, ex
                parte eligibility and every respondent letter all hang off this.
              </p>
            ) : (
              <ul className="plain">
                {data.respondents.map((r) => (
                  <li key={r.id} className="respondent">
                    <strong>{r.full_name}</strong>
                    {r.registration_no && <span className="meta">Reg. {r.registration_no}</span>}
                    {r.clinic_name && <span className="meta">{r.clinic_name}</span>}
                    <span className={`chip chip-${r.notice_state}`}>
                      {label(NOTICE_STATE_LABEL, r.notice_state)}
                    </span>
                    <span className="meta">
                      {r.notice_count === 0
                        ? 'no notice sent'
                        : `${r.notice_count} notice${r.notice_count === 1 ? '' : 's'}` +
                          (r.last_notice_at ? `, last ${formatDate(r.last_notice_at)}` : '')}
                    </span>
                    {/* A warning, never a block: the three-notice rule came from one
                        sentence of discussion, not from a statute anyone has checked. */}
                    {r.ex_parte_eligible && r.notice_state === 'awaiting_reply' && (
                      <span className="meta warn">
                        Notice ladder exhausted — ex parte is available.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </RespondentsPanel>

          <Section title="Intake">
            <dl className="pairs">
              <div>
                <dt>Source</dt>
                <dd>{c.intake_source.replace(/_/g, ' ')}</dd>
              </div>
              {c.external_authority_name && (
                <div>
                  <dt>Forwarded by</dt>
                  <dd>
                    {c.external_authority_name}
                    {c.external_ref_no && <span className="meta mono">{c.external_ref_no}</span>}
                  </dd>
                </div>
              )}
              <div>
                <dt>Documents complete</dt>
                <dd>{formatDate(c.documents_complete_at)}</dd>
              </div>
            </dl>
          </Section>
        </aside>
      </div>
    </main>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * The complaint, as the complainant wrote it.
 *
 * The first mail filed on the case - the one it was opened from. Shown whole, because this
 * is the text every later decision on the case answers to, and the officer should not have
 * to go back to the tray (or the mailbox) to read it.
 */
function Complaint({ mail }: { mail: CaseMail }) {
  const who = mail.original_from_name ?? mail.original_from ?? mail.envelope_from_name ?? mail.envelope_from;
  const address = mail.original_from ?? mail.envelope_from;
  return (
    <Section
      title="The complaint"
      action={
        <PendingLink className="button-link" href={`/intake/${mail.id}`}>
          The message as received
        </PendingLink>
      }
    >
      <p className="rti-hint">
        {mail.original_subject ?? mail.subject}
        <br />
        From {who}
        {address !== who && <span className="mono"> &lt;{address}&gt;</span>}
        {mail.original_date_text && ` \u00b7 sent ${mail.original_date_text}`}
        {' \u00b7 '}
        {label(FORWARD_KIND_LABEL, mail.forward_kind)}
        {mail.forward_kind !== 'none' && ` by ${mail.envelope_from}`}
        {' \u00b7 arrived '}
        {formatDateTime(mail.envelope_date)}
      </p>
      <div className="rti-asked complaint-text">{mail.body?.trim() || '(the message had no text)'}</div>
    </Section>
  );
}

/**
 * Milestones and transitions on one timeline.
 *
 * A date whose source is not `recorded` is marked. A reconstructed date must never read
 * as a recorded fact — not on screen, and not in the RTI reply assembled from it.
 */
function Chronology({
  milestones,
  history,
}: {
  milestones: CaseMilestone[];
  history: CaseHistoryEntry[];
}) {
  const entries = [
    ...milestones.map((m) => ({
      at: m.occurred_at,
      text: label(MILESTONE_LABEL, m.milestone),
      note: m.note,
      reconstructed: m.date_source !== 'recorded',
      kind: 'milestone' as const,
    })),
    ...history
      .filter((h) => h.reason)
      .map((h) => ({
        at: h.occurred_at,
        text: label(EVENT_LABEL, h.event),
        note: h.reason,
        reconstructed: false,
        kind: (h.is_system ? 'system' : 'event') as 'system' | 'event',
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (entries.length === 0) return <p className="muted">Nothing recorded yet.</p>;

  return (
    <ol className="timeline">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className={e.kind === 'system' ? 'system' : ''}>
          <span className="when mono">{formatDateTime(e.at)}</span>
          <span className="what">
            {e.text}
            {e.reconstructed && (
              <span className="chip chip-reconstructed" title="Not recorded as it happened">
                reconstructed
              </span>
            )}
            {e.note && <span className="meta">{e.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
