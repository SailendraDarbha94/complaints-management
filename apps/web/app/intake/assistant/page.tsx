import type { Route } from 'next';
import { redirect } from 'next/navigation';
import {
  MAIL_SUGGESTION_DECISIONS,
  MAIL_SUGGESTION_STATUSES,
  type MailSuggestionDecision,
} from '@ksdc/contracts';
import { fetchAssistantReport, isUnauthorized, type AssistantReport } from '@/lib/api';
import {
  RUPEES_PER_DOLLAR,
  SUGGESTION_DECISION_LABEL,
  SUGGESTION_OUTCOME_LABEL,
  SUGGESTION_STATUS_LABEL,
  formatDateTime,
  formatUsd,
  label,
  rupeesFromUsd,
} from '@/lib/labels';
import { PendingLink } from '@/app/components/pending-link';
import { MonthPicker } from './month-picker';

export const dynamic = 'force-dynamic';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * How the mail assistant is doing, a month at a time.
 *
 * Three questions, in the order the officer would ask them. Is it right? - how often what
 * finally happened to an email matched what it suggested, overall and for each kind of
 * suggestion, because being right about circulars says nothing about being right about
 * which case a reply belongs to. What became of its suggestions? - accepted, changed,
 * turned down, or overtaken by the ordinary buttons. And what did it cost? - in dollars,
 * which is how it is billed, and roughly in rupees, which is how it is budgeted.
 *
 * Then the disagreements themselves, each linked to its message, because a rate is only
 * worth trusting if the misses behind it can be read.
 *
 * Switched off, it says how to switch it on, and which setting is missing. This page and
 * a message still in the tray are the two places that say so; the rest of the app shows
 * nothing of an assistant that is off.
 */
export default async function AssistantReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  // A malformed month is dropped rather than sent: the route answers for the current month,
  // which is a better page than an error about a typo in an address bar.
  const asked = month && MONTH.test(month) ? month : undefined;

  let report: AssistantReport;
  try {
    report = await fetchAssistantReport(asked);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }

  const latest = currentMonth();
  const shown = MONTH.test(report.month) ? report.month : (asked ?? latest);
  const previous = shiftMonth(shown, -1);
  const next = shiftMonth(shown, 1);

  const made = MAIL_SUGGESTION_STATUSES.reduce((n, s) => n + (report.totals[s] ?? 0), 0);
  const { agreed, disagreed } = report.agreement.overall;

  // 'Not sure' is never counted as agreeing or disagreeing (there was nothing to agree
  // with), so its row would only ever read 0 and 0. It is shown only if that ever changes.
  const decisions = MAIL_SUGGESTION_DECISIONS.filter((d) => {
    const row = report.agreement.byDecision[d];
    return d !== 'unsure' || (row && row.agreed + row.disagreed > 0);
  });

  return (
    <main className="shell">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/intake">Inward mail</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">The mail assistant</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>The mail assistant</h1>
          <p className="case-summary">
            What it suggested for the mail that arrived in {monthName(shown)}, and how often
            you agreed. It only ever suggests: every change to the register was your click.
          </p>
        </div>
        {/* Keyed by the month on screen: the previous/next links keep this client component
            mounted, and without a new key its box would go on showing the month before. */}
        <MonthPicker key={shown} month={shown} latest={latest} />
      </header>

      <nav className="crumbs" aria-label="Other months">
        <PendingLink href={`/intake/assistant?month=${previous}` as Route}>
          &larr; {monthName(previous)}
        </PendingLink>
        {next <= latest && (
          <>
            <span aria-hidden="true">/</span>
            <PendingLink href={`/intake/assistant?month=${next}` as Route}>
              {monthName(next)} &rarr;
            </PendingLink>
          </>
        )}
      </nav>

      {!report.enabled && <SwitchedOff reason={report.reason ?? null} />}

      {made === 0 ? (
        <div className="empty">
          <strong>Nothing in {monthName(shown)}.</strong>
          {report.enabled
            ? 'The assistant made no suggestions this month.'
            : 'It was not reading mail this month.'}
        </div>
      ) : (
        <>
          <div className="summary">
            <div className="cell">
              <span className="v">{made}</span>
              <span className="k">Suggestions</span>
            </div>
            <div className="cell">
              <span className="v v-decision">{rate(agreed, disagreed)}</span>
              <span className="k">You agreed</span>
            </div>
            <div className="cell">
              <span className="v">{formatUsd(report.costUsd)}</span>
              <span className="k">Cost this month</span>
            </div>
            <div className="cell">
              <span className="v">{rupeesFromUsd(report.costUsd)}</span>
              <span className="k">In rupees, roughly</span>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>How often you agreed</h2>
            </div>
            <div className="panel-body">
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>It suggested</th>
                      <th className="num">You agreed</th>
                      <th className="num">You did otherwise</th>
                      <th className="num">Agreement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisions.map((d) => (
                      <AgreementRow key={d} decision={d} row={report.agreement.byDecision[d]} />
                    ))}
                    <tr>
                      <td>
                        <strong>All suggestions</strong>
                      </td>
                      <td className="num mono">{agreed}</td>
                      <td className="num mono">{disagreed}</td>
                      <td className="num mono">
                        <strong>{rate(agreed, disagreed)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* Says exactly what AssistantService.report() counts - the contract
                  (AssistantReport.agreement) writes the same rule down - so the words under
                  the table can never again contradict the numbers in it. */}
              <p className="rti-hint">
                Counted on what finally happened to each email. If you did what it suggested
                &mdash; by accepting it, with or without changes, or with the usual buttons
                &mdash; that is an agreement. If you did something else, added it to a
                different case, or turned the suggestion down, that counts against it. One
                where it was not sure counts neither way.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>What became of them</h2>
              <span className="n">{made}</span>
            </div>
            <div className="panel-body">
              <div className="table-scroll">
                <table className="inner-table">
                  <tbody>
                    {MAIL_SUGGESTION_STATUSES.map((s) => (
                      <tr key={s}>
                        <td>{SUGGESTION_STATUS_LABEL[s]}</td>
                        <td className="num mono">{report.totals[s] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}

      {report.recentDisagreements.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Where you went another way</h2>
            <span className="n">{report.recentDisagreements.length}</span>
          </div>
          <div className="panel-body">
            <p className="rti-hint">
              The most recent, newest first. Each opens the message, with the suggestion and
              what you did beside it.
            </p>
            <ul className="plain">
              {report.recentDisagreements.map((d) => (
                <li key={`${d.mailMessageId}-${d.at}`}>
                  <div className="followup-row">
                    <PendingLink href={`/intake/${d.mailMessageId}` as Route}>
                      {d.subject || '(no subject)'}
                    </PendingLink>
                    <span className="meta">{formatDateTime(d.at)}</span>
                  </div>
                  <p className="action-why">
                    It suggested: {label(SUGGESTION_DECISION_LABEL, d.decision).toLowerCase()}
                    {d.outcomeAction
                      ? `; you ${label(SUGGESTION_OUTCOME_LABEL, d.outcomeAction)}.`
                      : '.'}
                  </p>
                  {d.note && (
                    <p className="action-why">
                      <em>{d.note}</em>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <p className="rti-hint">
        Rupees are at a fixed &#8377;{RUPEES_PER_DOLLAR} to the dollar, as a guide for the
        budget; the bill itself is in dollars on the Council&rsquo;s Anthropic account.
        {report.model && <> Suggestions are made by {report.model}.</>}
      </p>
    </main>
  );
}

function AgreementRow({
  decision,
  row,
}: {
  decision: MailSuggestionDecision;
  row: { agreed: number; disagreed: number } | undefined;
}) {
  const a = row?.agreed ?? 0;
  const d = row?.disagreed ?? 0;
  return (
    <tr>
      <td>{SUGGESTION_DECISION_LABEL[decision]}</td>
      <td className="num mono">{a}</td>
      <td className="num mono">{d}</td>
      <td className="num mono">{rate(a, d)}</td>
    </tr>
  );
}

/**
 * How to switch it on, for whoever runs the app.
 *
 * The officer will not set environment variables, but they need to know the assistant
 * exists, that it is off, and what to ask for - and the person they ask needs the exact
 * names. The details (the daily limit, the model, the cost) live in the doc, not here,
 * so that there is one place to keep them true.
 */
function SwitchedOff({ reason }: { reason: string | null }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Switched off</h2>
      </div>
      <div className="panel-body assistant-off">
        <p className="action-why">
          The assistant is not reading new mail. With it off, the tray works exactly as it
          always has.
        </p>
        {/* The setting that is actually missing or wrong, from the server - so whoever
            switched it on and saw nothing happen is told which line to fix. */}
        {reason && (
          <p className="action-why">
            <strong>Why it is off:</strong> {reason}
          </p>
        )}
        <p className="action-why">
          When it is on, it reads each new email that does not file itself and suggests what
          to do with it &mdash; open a case, add it to a case, or set it aside. It never does
          any of that on its own: you accept, change or reject each suggestion.
        </p>
        <p className="action-why">It needs three things, and whoever runs the app restarts it after:</p>
        <ul className="assistant-switch">
          <li>
            The council&rsquo;s own AI switch, <span className="mono">aiEnabled</span> in its
            configuration &mdash; turned on only once the Registrar has signed the disclosure
            that complainants&rsquo; emails are sent outside India
          </li>
          <li>
            <span className="mono">MAIL_ASSISTANT=on</span>
          </li>
          <li>
            <span className="mono">ANTHROPIC_API_KEY</span>, the key from the Council&rsquo;s
            Anthropic account
          </li>
        </ul>
        <p className="rti-hint">
          Every setting, the daily limit that protects the credits, and what it costs are
          explained in <span className="mono">docs/mail-assistant.md</span> in the project.
        </p>
      </div>
    </section>
  );
}

/** "82%", or a dash when there is nothing to divide - never a misleading 0%. */
function rate(agreed: number, disagreed: number): string {
  const total = agreed + disagreed;
  return total === 0 ? '—' : `${Math.round((100 * agreed) / total)}%`;
}

/** This month, YYYY-MM, in India - the report's months are the officer's months. */
function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const mon = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${year}-${mon}`;
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "October 2026". */
function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
