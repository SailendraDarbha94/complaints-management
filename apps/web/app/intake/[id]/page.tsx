import type { Route } from 'next';
import { notFound, redirect } from 'next/navigation';
import { fetchCases, fetchTrayMessage, isUnauthorized, type TrayMessage } from '@/lib/api';
import { FORWARD_KIND_LABEL, MATCH_RUNG_LABEL, formatDate, label } from '@/lib/labels';
import { PendingLink } from '@/app/components/pending-link';
import { MessageActions } from './message-actions';

export const dynamic = 'force-dynamic';

/**
 * One message from the tray.
 *
 * The whole thing, in the order somebody reads it: who complained and about what, then
 * their words, then what came attached, then what the register thinks it might belong to.
 *
 * The forwarding officer's own covering note is shown separately and below, because it is
 * not part of the complaint — it is how the complaint got here.
 */
export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: TrayMessage;
  let cases: Awaited<ReturnType<typeof fetchCases>>;
  try {
    [data, cases] = await Promise.all([fetchTrayMessage(id), fetchCases()]);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }
  if (!data.message) notFound();

  const m = data.message;
  // Decided by the server, never the Council's own address. Null means the message does
  // not say, and the officer is asked below rather than the case going to the wrong person.
  const who = m.complainant?.name ?? null;
  const address = m.complainant?.email ?? null;
  const what = m.original_subject ?? m.subject;
  const forwarded = m.forward_kind !== 'none';

  return (
    <main className="shell shell-wide">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/intake">Inward mail</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">{what}</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>{what}</h1>
          <p className="case-summary">
            {who ? (
              <>
                From {who} {address && address !== who && <span className="mono">&lt;{address}&gt;</span>}
              </>
            ) : (
              <>Complainant not known, via <span className="mono">{m.envelope_from}</span></>
            )}{' '}
            &middot;{' '}
            {label(FORWARD_KIND_LABEL, m.forward_kind)} &middot; arrived{' '}
            {formatDate(m.ingested_at)}
            {m.original_date_text && ` · sent ${m.original_date_text}`}
          </p>
        </div>
      </header>

      {m.status === 'filed' && m.case_file_id && (
        <div className="banner banner-ok">
          <span className="tag">Filed</span>
          <span>
            On <PendingLink href={`/cases/${m.case_file_id}` as Route}>{m.case_number}</PendingLink>
            {m.matched_rung && ` — ${label(MATCH_RUNG_LABEL, m.matched_rung)}`}.
          </span>
        </div>
      )}
      {m.status === 'dismissed' && (
        <div className="banner banner-demo">
          <span className="tag">Set aside</span>
          <span>{m.dismissed_reason}</span>
        </div>
      )}
      {!who && m.status === 'unfiled' && (
        <div className="rti-warn">
          This came from the Council&rsquo;s own address, and the original sender could not be
          read from it. Enter the complainant&rsquo;s name and email before opening a case &mdash;
          their details are usually in the letter below.
        </div>
      )}
      {m.suggestion_note && m.status === 'unfiled' && (
        <div className="rti-warn">{m.suggestion_note}</div>
      )}

      <div className="case-grid">
        <div className="case-main">
          <section className="panel">
            <div className="panel-head">
              <h2>{forwarded ? 'What was sent to the Council' : 'What they wrote'}</h2>
            </div>
            <div className="panel-body">
              <div className="rti-asked">{m.original_body ?? m.body_text ?? '(no text)'}</div>
            </div>
          </section>

          {forwarded && m.body_text && (
            <section className="panel">
              <div className="panel-head">
                <h2>How it reached us</h2>
                <span className="n">{m.envelope_from}</span>
              </div>
              <div className="panel-body">
                <p className="rti-hint">
                  The message as it arrived at the intake address, covering note and all.
                  The complaint itself is above.
                </p>
                <div className="rti-letter">{m.body_text}</div>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Attached</h2>
              <span className="n">{data.attachments.length}</span>
            </div>
            <div className="panel-body">
              {data.attachments.length === 0 ? (
                <p className="rti-hint">Nothing came attached.</p>
              ) : (
                <div className="table-scroll">
                  <table className="inner-table">
                    <thead>
                      <tr>
                        <th>File</th>
                        <th className="num">Size</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.attachments.map((a) => (
                        <tr key={a.id} className={a.skipped_reason ? 'withdrawn' : undefined}>
                          <td>{a.filename}</td>
                          <td className="num mono">{readableSize(a.size_bytes)}</td>
                          <td>
                            {a.document_id ? (
                              'On the case file'
                            ) : a.skipped_reason ? (
                              <>
                                Not stored
                                <span className="meta">{a.skipped_reason}</span>
                              </>
                            ) : (
                              'Held, goes on the case when you file this'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="case-side">
          <MessageActions
            messageId={m.id}
            status={m.status}
            defaults={{
              summary: what,
              complainantName: who ?? '',
              complainantEmail: address ?? '',
            }}
            candidates={data.candidates}
            cases={cases.cases
              .filter((c) => c.state !== 'closed')
              .map((c) => ({ id: c.id, caseNumber: c.case_number, summary: c.summary }))}
          />

          <section className="panel">
            <div className="panel-head">
              <h2>Particulars</h2>
            </div>
            <div className="panel-body">
              <dl className="pairs">
                <div>
                  <dt>Complainant</dt>
                  <dd>
                    {who}
                    <span className="meta">{address}</span>
                  </dd>
                </div>
                <div>
                  <dt>Reached us</dt>
                  <dd>
                    {label(FORWARD_KIND_LABEL, m.forward_kind)}
                    <span className="meta">via {m.envelope_from}</span>
                  </dd>
                </div>
                {m.original_date_text && (
                  <div>
                    <dt>Sent</dt>
                    <dd>
                      {m.original_date_text}
                      {/* Kept as text on purpose: an in-body forward header carries no
                          timezone, so turning it into a timestamp would invent one. */}
                      <span className="meta">as written in the forward</span>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Subject line</dt>
                  <dd>{m.subject}</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
