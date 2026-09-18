import { notFound, redirect } from 'next/navigation';
import { RTI_EXEMPTIONS } from '@ksdc/contracts';
import { PendingLink } from '@/app/components/pending-link';
import { fetchRtiFile, isUnauthorized, type RtiFile } from '@/lib/api';
import {
  RTI_CHANNEL_LABEL,
  RTI_DECISION_LABEL,
  RTI_STAGE_LABEL,
  RTI_STATE_LABEL,
  formatDate,
  label,
} from '@/lib/labels';
import { DecisionForm, FeeAndTransfer, ReplyPanel, ThirdPartySteps } from './rti-actions';

export const dynamic = 'force-dynamic';

/**
 * One RTI application.
 *
 * Read top to bottom it answers the four questions in the order they are actually asked:
 * how long have I got, what did they ask for, what am I deciding, and is the letter fit to
 * send. The branches that only sometimes apply - a further fee, a transfer, a third party -
 * sit in the side column, out of the way until they are needed.
 */
export default async function RtiFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let file: RtiFile;
  try {
    file = await fetchRtiFile(id);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }
  if (!file.request) notFound();

  const r = file.request;
  const clock = file.clock;
  const answered = Boolean(r.reply_despatched_on || r.transferred_on);

  return (
    <main className="shell shell-wide">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/rti">RTI</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">{r.rti_no}</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>{r.rti_no}</h1>
          <p className="case-summary">
            {r.applicant_name} &middot; received {formatDate(r.received_on)}{' '}
            {label(RTI_CHANNEL_LABEL, r.received_via).toLowerCase()} &middot;{' '}
            {label(RTI_STATE_LABEL, r.state)}
          </p>
        </div>
      </header>

      <Clock clock={clock} answered={answered} despatchedOn={r.reply_despatched_on} />

      {clock.warnings.map((w) => (
        <div className={`rti-warn ${w.includes('AFTER the statutory') || clock.deemedRefusal ? 'grave' : ''}`} key={w}>
          {w}
        </div>
      ))}

      <div className="case-grid">
        <div className="case-main">
          <section className="panel">
            <div className="panel-head">
              <h2>What was asked for</h2>
              {r.external_ref_no && <span className="n">{r.external_ref_no}</span>}
            </div>
            <div className="panel-body">
              <div className="rti-asked">{r.request_text}</div>
              <p className="rti-hint">
                Held exactly as it was written. The scope of the request decides whether the
                reply was complete, whether a ground covers it, and whether the Commission
                agrees.
              </p>
            </div>
          </section>

          <section className="panel panel-consequential">
            <div className="panel-head">
              <h2>The decision</h2>
              {r.decision && <span className="n">{label(RTI_DECISION_LABEL, r.decision)}</span>}
            </div>
            <div className="panel-body">
              {r.decision ? (
                <>
                  <dl className="pairs">
                    <div>
                      <dt>Decided</dt>
                      <dd>{formatDate(r.decided_on)}</dd>
                    </div>
                  </dl>
                  {r.decision_reasons && <p className="wrap">{r.decision_reasons}</p>}
                  {file.exemptions.map((e) => {
                    const clause = RTI_EXEMPTIONS.find((x) => x.section === e.section);
                    return (
                      <div className="rti-ground" key={e.id}>
                        <div className="cite">
                          {clause?.cite ?? e.section} &middot; {e.applies_to}
                        </div>
                        {clause && <p className="statute">&ldquo;{clause.text}&rdquo;</p>}
                        <p className="because">{e.reasoning}</p>
                      </div>
                    );
                  })}
                </>
              ) : (
                <p className="rti-hint">
                  Nothing decided yet. Information may be withheld only under section 8(1) or
                  section 9 - never under section 11, which is the procedure to follow before
                  disclosing a third party&rsquo;s information and is not a ground at all.
                </p>
              )}
              {!r.reply_despatched_on && <DecisionForm rtiRequestId={r.id} current={r.decision} />}
            </div>
          </section>

          <ReplyPanel
            rtiRequestId={r.id}
            despatchedOn={r.reply_despatched_on}
            hasDecision={Boolean(r.decision)}
          />
        </div>

        <div className="case-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Particulars</h2>
            </div>
            <div className="panel-body">
              <dl className="pairs">
                <div>
                  <dt>Applicant</dt>
                  <dd>
                    {r.applicant_name}
                    {r.applicant_address_lines.map((l) => (
                      <span className="meta" key={l}>
                        {l}
                      </span>
                    ))}
                  </dd>
                </div>
                {r.applicant_email && (
                  <div>
                    <dt>Email</dt>
                    <dd>
                      <a href={`mailto:${r.applicant_email}`}>{r.applicant_email}</a>
                    </dd>
                  </div>
                )}
                {r.applicant_phone && (
                  <div>
                    <dt>Phone</dt>
                    <dd>{r.applicant_phone}</dd>
                  </div>
                )}
                <div>
                  <dt>Application fee</dt>
                  <dd>
                    {r.is_bpl
                      ? 'Not payable - below the poverty line'
                      : r.application_fee_received
                        ? 'Received'
                        : 'Not recorded'}
                  </dd>
                </div>
                <div>
                  <dt>Register</dt>
                  <dd className="mono">
                    Sl. {r.register_sl_no} of {r.fiscal_year}
                  </dd>
                </div>
              </dl>
              {r.life_or_liberty && (
                <div className="rti-warn grave">
                  Accepted as a life-or-liberty request, so the reply was due within
                  forty-eight hours. Reason recorded: {r.life_or_liberty_reason}
                </div>
              )}
            </div>
          </section>

          <ThirdPartySteps rtiRequestId={r.id} request={r} clock={clock} />

          <FeeAndTransfer rtiRequestId={r.id} request={r} />

          <section className="panel">
            <div className="panel-head">
              <h2>Cases</h2>
              <span className="n">{file.cases.length}</span>
            </div>
            <div className="panel-body">
              {file.cases.length === 0 ? (
                <p className="rti-hint">
                  This application is not linked to a case. Most are not, and that is not a
                  gap to be filled.
                </p>
              ) : (
                file.cases.map((c) => (
                  <div className="followup-row" key={c.case_file_id}>
                    <PendingLink className="case-link" href={`/cases/${c.case_file_id}`}>
                      {c.case_number}
                    </PendingLink>
                    <span className="meta">{c.summary}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Timers</h2>
              <span className="n">{file.followups.length}</span>
            </div>
            <div className="panel-body">
              {file.followups.length === 0 ? (
                <p className="rti-hint">Nothing outstanding on this file.</p>
              ) : (
                file.followups.map((f) => (
                  <div className="followup-row" key={f.id}>
                    <strong>{label(RTI_STAGE_LABEL, f.stage)}</strong>
                    <span className="meta">
                      {f.title} &middot; due {formatDate(f.due_on)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          {file.letters.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Letters</h2>
                <span className="n">{file.letters.length}</span>
              </div>
              <div className="panel-body">
                {file.letters.map((l) => (
                  <div className="followup-row" key={l.id}>
                    <strong>{l.subject}</strong>
                    <span className="meta">
                      {l.sent_at ? `Sent ${formatDate(l.sent_at)}` : 'Draft'}
                      {l.despatch_no ? ` \u00b7 dispatch ${l.despatch_no}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function Clock({
  clock,
  answered,
  despatchedOn,
}: {
  clock: RtiFile['clock'];
  answered: boolean;
  despatchedOn: string | null;
}) {
  const tone = clock.daysRemaining < 0 ? 'is-late' : clock.daysRemaining <= 7 ? 'is-soon' : '';

  return (
    <div className={`rti-clock ${answered ? '' : tone}`}>
      <span className="due">{formatDate(clock.dueOn)}</span>
      <span className="left">
        {answered ? (
          despatchedOn ? (
            <>
              Replied <strong>{formatDate(despatchedOn)}</strong>
            </>
          ) : (
            'Transferred out'
          )
        ) : clock.daysRemaining < 0 ? (
          <>
            <strong>{-clock.daysRemaining} days over.</strong> Deemed refused under s.7(2),
            and free of charge under s.7(6).
          </>
        ) : (
          <>
            <strong>{clock.daysRemaining} days</strong> to dispatch the reply
          </>
        )}
      </span>
      {clock.excludedDays > 0 && (
        <span className="left">
          {clock.excludedDays} days excluded under s.7(3)(a) while the fee was outstanding
        </span>
      )}
      {clock.penaltyExposureRupees > 0 && (
        <span className="penalty">
          s.20(1) exposure Rs {clock.penaltyExposureRupees.toLocaleString('en-IN')}
        </span>
      )}
    </div>
  );
}
