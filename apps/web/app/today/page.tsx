import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  API_URL,
  fetchSession,
  fetchToday,
  isUnauthorized,
  type QueueGroup,
  type QueueItem,
  type Session,
  type TodayResponse,
} from '@/lib/api';
import { SignOutButton } from '../components/sign-out';
import { RowActions } from './row-actions';

export const dynamic = 'force-dynamic';

/**
 * Today.
 *
 * One list, grouped by who you are chasing, sorted by how late they are. In Phase 1 this
 * screen IS the product: the officer opens it and knows what to do, which is the thing
 * the paper register could never tell them.
 */
export default async function TodayPage() {
  let data: TodayResponse;
  let session: Session;
  try {
    [session, data] = await Promise.all([fetchSession(), fetchToday()]);
  } catch (err) {
    // An expired session is not an error to show the officer; it is a sign-in page.
    if (isUnauthorized(err)) redirect('/signin');
    return <ErrorState error={err} />;
  }

  const { summary, byUrgency, ticker } = data;
  const empty = summary.total === 0;

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <span className="council">Karnataka State Dental Council</span>
          <h1>Today</h1>
          <nav className="crumbs" style={{ marginTop: 6, marginBottom: 0 }}>
            <Link href="/cases">Cases</Link>
            <span aria-hidden="true">/</span>
            <Link href="/rti">RTI</Link>
            <span aria-hidden="true">/</span>
            <Link href="/register">Register</Link>
          </nav>
        </div>
        <span className="date">
          {formatLongDate(summary.today)}
          <br />
          <SignOutButton
            apiUrl={process.env.NEXT_PUBLIC_API_URL ?? API_URL}
            name={session.user.name}
          />
        </span>
      </header>

      <TickerBanner ticker={ticker} />

      {/* Until the four authorisation artefacts are filed, everything here is demo data. */}
      <div className="banner banner-demo">
        <span className="tag">Demo data</span>
        <span>
          This council is not yet authorised for production records. The paper register
          remains the legal record.
        </span>
      </div>

      <div className="summary">
        <div className="cell">
          <span className="v v-decision">{summary.needsDecision}</span>
          <span className="k">Needs a decision</span>
        </div>
        <div className="cell">
          <span className="v v-overdue">{summary.overdue}</span>
          <span className="k">Overdue</span>
        </div>
        <div className="cell">
          <span className="v v-today">{summary.dueToday}</span>
          <span className="k">Due today</span>
        </div>
        <div className="cell">
          <span className="v">{summary.thisWeek}</span>
          <span className="k">This week</span>
        </div>
        <div className="cell">
          <span className="v">
            {summary.snoozed}
            {summary.snoozedOverdue > 0 && (
              <span className="statutory" style={{ fontSize: '0.72em' }}>
                {' '}
                · {summary.snoozedOverdue} late
              </span>
            )}
          </span>
          <span className="k">Snoozed</span>
        </div>
      </div>

      {empty ? (
        <div className="empty">
          <strong>Nothing is waiting on anyone.</strong>
          Every open case has a next step scheduled, and none of them is due yet.
        </div>
      ) : (
        <>
          {byUrgency.map((group) => (
            <Group key={group.key} group={group} />
          ))}

          <p className="section-label">By who you are chasing</p>
          {data.byWaitingOn.map((group) => (
            <Group key={`w-${group.key}`} group={group} showUrgencyChip />
          ))}
        </>
      )}
    </main>
  );
}

function TickerBanner({ ticker }: { ticker: TodayResponse['ticker'] }) {
  // A silently dead ticker recreates the exact pain this product exists to remove, so its
  // status is visible to the person most harmed by it, depending on no alerting at all.
  if (ticker.stale) {
    return (
      <div className="banner banner-bad">
        <span className="tag">Reminders</span>
        <span>
          {ticker.lastSuccessAt
            ? `Last ran ${Math.round(ticker.hoursSince ?? 0)} hours ago. This list may be out of date.`
            : 'Have never run. Nothing on this list is being escalated.'}
        </span>
      </div>
    );
  }
  return (
    <div className="banner banner-ok">
      <span className="tag">Reminders</span>
      <span>Last ran {formatTime(ticker.lastSuccessAt!)} today.</span>
    </div>
  );
}

function Group({ group, showUrgencyChip }: { group: QueueGroup; showUrgencyChip?: boolean }) {
  return (
    <section className="group">
      <div className={`group-head g-${group.key}`}>
        <span>{group.label}</span>
        <span className="n">
          {group.count}
          {group.overdueCount > 0 && group.key !== 'overdue' && ` · ${group.overdueCount} late`}
        </span>
      </div>
      {group.items.map((item) => (
        <Row key={`${group.key}-${item.followUpId}`} item={item} showUrgencyChip={showUrgencyChip} />
      ))}
    </section>
  );
}

function Row({ item, showUrgencyChip }: { item: QueueItem; showUrgencyChip?: boolean }) {
  const chipKey = showUrgencyChip ? item.urgency : item.urgency;
  return (
    <div className="row">
      <div className="t">
        {item.title}
        {item.isStatutory && <span className="statutory"> · statutory</span>}
        <span className="meta">
          {item.caseFileId && item.caseNumber ? (
            <Link className="case-link" href={`/cases/${item.caseFileId}`}>
              {item.caseNumber}
            </Link>
          ) : item.rtiRequestId && item.rtiNo ? (
            // An RTI timer belongs to an application, not to a case. The Today screen is
            // still one list: an officer with four complaints and an RTI application does
            // not keep two queues in their head, and a statutory deadline on a separate
            // screen is a statutory deadline nobody looks at.
            <Link className="case-link" href={`/rti/${item.rtiRequestId}`}>
              {item.rtiNo}
            </Link>
          ) : (
            (item.caseNumber ?? 'No case')
          )}
          {item.rtiDueOn && item.rtiDueOn !== item.dueOn && ` · statutory date ${shortDate(item.rtiDueOn)}`}
          {item.caseSummary && ` · ${truncate(item.caseSummary, 60)}`}
          {item.escalationLevel > 0 && ` · reminder ${item.escalationLevel + 1}`}
          {item.caseQuietDays != null && item.caseQuietDays > 0 && ` · quiet ${item.caseQuietDays}d`}
          {item.partyMobile && (
            <>
              {' · '}
              <a href={`tel:${item.partyMobile.replace(/\s/g, '')}`}>{item.partyMobile}</a>
            </>
          )}
        </span>
      </div>
      <span className={`age age-${chipKey}`}>{ageLabel(item)}</span>
      <RowActions
        followUpId={item.followUpId}
        title={item.title}
        needsDecision={item.urgency === 'needs_decision'}
        caseFileId={item.caseFileId}
      />
    </div>
  );
}

function ageLabel(item: QueueItem): string {
  if (item.urgency === 'needs_decision') return 'decide';
  if (item.urgency === 'snoozed') return item.snoozedUntil ? `until ${shortDate(item.snoozedUntil)}` : 'snoozed';
  if (item.daysOverdue > 0) return `+${item.daysOverdue}d`;
  if (item.urgency === 'due_today') return 'today';
  return shortDate(item.dueOn);
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <span className="council">Karnataka State Dental Council</span>
          <h1>Today</h1>
        </div>
      </header>
      <div className="error">
        <h2>The queue could not be loaded</h2>
        <p>
          The API did not answer. Check that it is running on <code>{API_URL}</code>.
        </p>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </div>
    </main>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}
