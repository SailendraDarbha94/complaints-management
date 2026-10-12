'use client';

import { useState, type ReactNode } from 'react';
import type { Route } from 'next';
import type { AssistantState, CouncilCopyMode, CouncilCopyPlan, MailSuggestionView } from '@/lib/api';
import { dayInputValue, formatDate } from '@/lib/labels';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';
import { askAgainFailed } from '../suggestion-text';
import { AssistantPanel, type AssistantPath } from './assistant-panel';

type Doing = '/open-case' | '/file' | '/dismiss' | '/restore' | '/council-copy' | AssistantPath;

/**
 * What to do with this message.
 *
 * Opening a case is the consequential action on this screen, and unlike the quick button
 * in the tray it shows the fields first: this is where the officer corrects a name the
 * parser got from a display header, or writes a summary better than the sender's subject
 * line. What goes in here is what the register will carry for the life of the case.
 *
 * The assistant's panel sits above the forms and runs through the same `post`: accepting
 * its suggestion and pressing one of the forms below are two ways of making the same
 * decision, and only one of them may land.
 */
export function MessageActions({
  messageId,
  status,
  defaults,
  candidates,
  cases,
  suggestion,
  assistant,
  isCouncilCopy = false,
  councilCopy = null,
}: {
  messageId: string;
  status: string;
  defaults: { summary: string; complainantName: string; complainantEmail: string };
  candidates: Array<{
    caseFileId: string;
    caseNumber: string;
    summary: string;
    isClosed: boolean;
    because: string;
  }>;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
  suggestion: MailSuggestionView | null;
  assistant: AssistantState;
  /** The register knows this message is a copy of a letter the Council sent. */
  isCouncilCopy?: boolean;
  /**
   * Set when the message is a copy of a letter the Council sent: the case chosen for it
   * (the suggested one, or the one picked in its panel), and what filing it there would mean.
   */
  councilCopy?: {
    caseFileId: string | null;
    plan: CouncilCopyPlan | null;
    error: string | null;
    /**
     * Only the assistant took it for a copy; the register did not (page.tsx). Filing it from
     * the panel then says so, or the register would refuse it as not a copy.
     */
    asCouncilCopy?: boolean;
  } | null;
}) {
  const [summary, setSummary] = useState(defaults.summary);
  const [name, setName] = useState(defaults.complainantName);
  const [email, setEmail] = useState(defaults.complainantEmail);
  const [caseFileId, setCaseFileId] = useState(candidates[0]?.caseFileId ?? cases[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const { pending: busy, error, setError, run } = useAction();
  // Which of the forms was sent. All of them stop taking clicks while one is in flight -
  // opening a case and setting the message aside must not both land - but only the one
  // pressed spins, and a refusal is shown beside the button that caused it.
  const [doing, setDoing] = useState<Doing | null>(null);

  function post(path: Doing, body?: unknown) {
    setDoing(path);
    run(
      async () => {
        const res = await fetch(`${PUBLIC_API_URL}/v1/intake/${messageId}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          message?: string;
          caseFileId?: string;
          suggestion?: MailSuggestionView;
        };
        if (!res.ok) throw new Error(payload.message ?? 'That did not go through.');
        return {
          caseFileId: payload.caseFileId,
          // A failed "Ask again" the refreshed page will not show (see askAgainFailed).
          unseen: path === '/suggestion/refresh' ? askAgainFailed(suggestion, payload.suggestion) : null,
        };
      },
      // Inside the transition, so "Opening…" holds until the case page is on screen. The
      // case exists by now; a button that woke up in the meantime would only invite a
      // second press and a "that message is already on a case" for the officer's trouble.
      ({ caseFileId, unseen }, router) => {
        if (caseFileId) router.push(`/cases/${caseFileId}`);
        else router.refresh();
        // Refreshed all the same: what that reading sent is on the panel's own line.
        if (unseen) setError(unseen);
      },
    );
  }

  const failed = (path: Doing) => (error && doing === path ? <p className="rti-error">{error}</p> : null);

  /**
   * Another case for the copy, or (for a subject that is two of the Council's letters)
   * another letter: the page is rendered again with that plan.
   */
  function chooseCopyCase(id: string, kind?: string | null) {
    setDoing('/council-copy');
    run(
      async () => id,
      (chosen, router) =>
        router.replace(
          `/intake/${messageId}?case=${chosen}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}` as Route,
          { scroll: false },
        ),
    );
  }

  // Keyed on the suggestion's status as well as its id, so that a reject - same suggestion,
  // new status - comes back to a panel that has closed its form, in the same render as the
  // refreshed page. (A fresh reading has a new id; page.tsx keys this whole component on
  // it, so the forms below take up the new suggestion's details too.)
  const assistantPanel = (
    <AssistantPanel
      key={suggestion ? `${suggestion.id}:${suggestion.status}` : 'none'}
      suggestion={suggestion}
      assistant={assistant}
      messageStatus={status}
      councilCopy={isCouncilCopy}
      candidates={candidates}
      cases={cases}
      busy={busy}
      busyOn={(path) => busy && doing === path}
      failed={failed}
      post={post}
    />
  );

  if (status !== 'unfiled') {
    return (
      <>
        {assistantPanel}
        <section className="panel">
          <div className="panel-head">
            <h2>{status === 'filed' ? 'Filed' : 'Set aside'}</h2>
          </div>
          <div className="panel-body">
            {status === 'dismissed' ? (
              <>
                <p className="rti-hint">
                  Set aside, not deleted. The message stays on the record either way.
                </p>
                <div className="action-row">
                  <BusyButton type="button" busy={busy} busyLabel="Putting back…" onClick={() => post('/restore')}>
                    Put it back in the tray
                  </BusyButton>
                </div>
              </>
            ) : (
              <p className="rti-hint">
                This message is on a case. Its attachments went on with it.
              </p>
            )}
            {failed('/restore')}
          </div>
        </section>
      </>
    );
  }

  // A copy of the Council's own letter is filed from its own panel, never opened as a case,
  // and "Not a complaint" becomes "Not needed": it never was one.
  if (councilCopy) {
    return (
      <>
        <CouncilCopyActions
          key={`${councilCopy.caseFileId ?? 'none'}:${councilCopy.plan?.actions.join(',') ?? ''}`}
          copy={councilCopy}
          candidates={candidates}
          cases={cases}
          busy={busy}
          busyOn={busy && doing === '/council-copy'}
          failed={failed('/council-copy')}
          choose={chooseCopyCase}
          file={(body) =>
            post('/council-copy', councilCopy.asCouncilCopy ? { ...body, asCouncilCopy: true } : body)
          }
          asReceived={{
            busyOn: busy && doing === '/file',
            failed: failed('/file'),
            file: (caseFileId) => post('/file', { caseFileId, asReceived: true }),
          }}
        />
        {assistantPanel}
        <ItIsAComplaint
          summary={summary}
          setSummary={setSummary}
          name={name}
          setName={setName}
          email={email}
          setEmail={setEmail}
          busy={busy}
          busyOn={busy && doing === '/open-case'}
          failed={failed('/open-case')}
          submit={() =>
            post('/open-case', {
              summary,
              complainantName: name,
              complainantEmail: email || null,
              asComplaint: true,
            })
          }
        />
        <NotNeeded
          reason={reason}
          setReason={setReason}
          busy={busy}
          busyOn={busy && doing === '/dismiss'}
          failed={failed('/dismiss')}
          submit={() => post('/dismiss', { reason })}
        />
      </>
    );
  }

  return (
    <>
      {assistantPanel}
      <section className="panel panel-consequential">
        <div className="panel-head">
          <h2>Open a case</h2>
        </div>
        <div className="panel-body">
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              post('/open-case', {
                summary,
                complainantName: name,
                complainantEmail: email || null,
              });
            }}
          >
            <p className="rti-hint">
              This takes the next number in the register. Check the three lines below first
              — they are what the case will carry from here on.
            </p>
            <div>
              <label htmlFor="summary">The grievance, in one line</label>
              <input id="summary" value={summary} onChange={(e) => setSummary(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="name">Complainant</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="email">Their email</label>
              <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {failed('/open-case')}
            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busy && doing === '/open-case'}
                busyLabel="Opening…"
                disabled={busy || !summary.trim() || !name.trim()}
              >
                Open the case
              </BusyButton>
            </div>
          </form>
        </div>
      </section>

      {(candidates.length > 0 || cases.length > 0) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Or add it to a case</h2>
          </div>
          <div className="panel-body">
            {candidates.length > 0 && (
              <p className="rti-hint">
                {candidates.length === 1
                  ? `${candidates[0]!.caseNumber} — ${candidates[0]!.because}.`
                  : 'More than one case matches; pick the right one.'}
              </p>
            )}
            <form
              className="action-form"
              onSubmit={(e) => {
                e.preventDefault();
                post('/file', { caseFileId });
              }}
            >
              <div>
                <label htmlFor="case">Case</label>
                <select id="case" value={caseFileId} onChange={(e) => setCaseFileId(e.target.value)}>
                  {candidates.map((c) => (
                    <option key={c.caseFileId} value={c.caseFileId}>
                      {c.caseNumber} — {c.because}
                      {c.isClosed ? ' (closed)' : ''}
                    </option>
                  ))}
                  {cases
                    .filter((c) => !candidates.some((k) => k.caseFileId === c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.caseNumber} — {c.summary}
                      </option>
                    ))}
                </select>
              </div>
              {failed('/file')}
              <div className="action-buttons">
                <BusyButton
                  type="submit"
                  busy={busy && doing === '/file'}
                  busyLabel="Adding…"
                  disabled={busy || !caseFileId}
                >
                  Add it to this case
                </BusyButton>
              </div>
            </form>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Not a complaint</h2>
        </div>
        <div className="panel-body">
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              post('/dismiss', { reason });
            }}
          >
            <p className="rti-hint">
              It stays on the record, marked with your reason. Nothing is deleted.
            </p>
            <div>
              <label htmlFor="reason">Why</label>
              <input
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Advertising; nothing to do with the Council"
              />
            </div>
            {failed('/dismiss')}
            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busy && doing === '/dismiss'}
                busyLabel="Setting aside…"
                disabled={busy || reason.trim().length < 3}
              >
                Set it aside
              </BusyButton>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}

/**
 * Filing a copy of a Council letter on a case.
 *
 * The plan (from the server, for the case chosen here) says which of three ways are open,
 * the recommended first:
 *
 *   link          the case records the letter as sent, and the copy is attached to it
 *   record_sent   the case does not record it: record it now, as "I have sent this" would -
 *                 which is what starts the reminder, or counts the notice
 *   record_only   put it on the case as a letter sent, and move nothing
 *
 * Opening a case is not offered here: a copy of the Council's own letter is not a complaint.
 * The officer can still say it is not a copy - "it is a reply" here, with a confirm that
 * names the reminders it stops, and "it is a complaint" in ItIsAComplaint below.
 */
function CouncilCopyActions({
  copy,
  candidates,
  cases,
  busy,
  busyOn,
  failed,
  choose,
  file,
  asReceived,
}: {
  copy: { caseFileId: string | null; plan: CouncilCopyPlan | null; error: string | null; asCouncilCopy?: boolean };
  candidates: Array<{ caseFileId: string; caseNumber: string; because: string; isClosed: boolean }>;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
  busy: boolean;
  busyOn: boolean;
  failed: ReactNode;
  choose: (caseFileId: string, kind?: string | null) => void;
  file: (body: {
    caseFileId: string;
    mode: CouncilCopyMode;
    sentAt?: string;
    kind?: string;
    caseRespondentId?: string | null;
  }) => void;
  /** "It is not a copy of our letter": filed as a letter received instead. */
  asReceived: { busyOn: boolean; failed: ReactNode; file: (caseFileId: string) => void };
}) {
  const plan = copy.plan;
  const today = dayInputValue(null);
  // The copy's own date, but never a day that has not come yet: a sender's clock can be
  // wrong. Not filled in at all when the copy only says when it was FORWARDED: that day
  // is not the day the letter went out, and recording it would put the reminder late.
  const copyDay = plan && plan.copyDateBasis !== 'forwarded' ? dayInputValue(plan.copyDate) : '';
  const [sentOn, setSentOn] = useState(copyDay && copyDay <= today ? copyDay : plan ? '' : today);
  // The dentist the copy went to; failing that, the only dentist; otherwise nobody until
  // the officer picks - a notice counted against the wrong dentist is a step towards an
  // ex parte finding against them.
  const [respondentId, setRespondentId] = useState(
    plan?.respondents.find((r) => r.sentTo)?.id ??
      (plan?.respondents.length === 1 ? plan.respondents[0]!.id : ''),
  );
  const [pressed, setPressed] = useState<CouncilCopyMode | null>(null);
  // "It is a reply" asks first: filing it as received stops every reminder on the case that
  // is waiting for a reply, which is the very thing a copy must never do by mistake.
  const [confirmingReply, setConfirmingReply] = useState(false);
  const respondent = plan?.respondents.find((r) => r.id === respondentId) ?? null;
  // The subject is two letters and nobody has said which: nothing that records it can be
  // pressed until the officer does (the server refuses it too).
  const undecided = Boolean(plan && plan.kindOptions.length > 1 && !plan.kind);

  const send = (mode: CouncilCopyMode) => {
    if (!plan) return;
    setPressed(mode);
    file({
      caseFileId: plan.caseFileId,
      mode,
      ...(mode === 'link' ? {} : { sentAt: sentOn }),
      ...(plan.kind ? { kind: plan.kind } : {}),
      ...(mode === 'record_sent' && plan.needsRespondent ? { caseRespondentId: respondentId || null } : {}),
    });
  };
  const spinning = (mode: CouncilCopyMode) => busyOn && pressed === mode;
  const dateOk = Boolean(sentOn) && sentOn <= today;
  const on = sentOn ? formatDate(sentOn) : 'that date';

  return (
    <section className="panel panel-consequential">
      <div className="panel-head">
        <h2>File the copy</h2>
      </div>
      <div className="panel-body">
        <div className="action-form">
          <div>
            <label htmlFor="copy-case">Case</label>
            <select
              id="copy-case"
              value={copy.caseFileId ?? ''}
              disabled={busy}
              // The letter chosen goes with the case, when the subject is two letters: the
              // new case's plan keeps it if it fits, and asks again if it does not.
              onChange={(e) =>
                e.target.value &&
                choose(e.target.value, plan && plan.kindOptions.length > 1 ? plan.kind : null)
              }
            >
              {!copy.caseFileId && <option value="">Choose the case it belongs to</option>}
              {candidates.map((c) => (
                <option key={c.caseFileId} value={c.caseFileId}>
                  {c.caseNumber} — {c.because}
                  {c.isClosed ? ' (closed)' : ''}
                </option>
              ))}
              {cases
                .filter((c) => !candidates.some((k) => k.caseFileId === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.caseNumber} — {c.summary}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {plan && plan.kindOptions.length > 1 && (
          <div className="action-form">
            <div>
              <label htmlFor="copy-kind">Which letter is this?</label>
              <select
                id="copy-kind"
                value={plan.kind ?? ''}
                disabled={busy}
                required
                onChange={(e) => e.target.value && choose(plan.caseFileId, e.target.value)}
              >
                {!plan.kind && <option value="">Choose the letter it is</option>}
                {plan.kindOptions.map((o) => (
                  <option key={o.kind} value={o.kind}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="rti-hint">
              Its subject is the same for both, and the person it went to is not on file as either.
            </p>
          </div>
        )}

        {copy.error && <p className="rti-error">{copy.error}</p>}
        {plan && <p className="rti-hint">{plan.explanation}</p>}

        {plan?.actions.includes('link') && plan.recordedLetter && (
          <div className="action-buttons">
            <BusyButton
              type="button"
              busy={spinning('link')}
              busyLabel="Filing…"
              disabled={busy}
              onClick={() => send('link')}
            >
              {/* Not sure it is that letter: said so on the button itself, not only in the
                  explanation above it - the copy of another dentist's notice must not be
                  filed as proof of this one by a button that reads like a certainty. */}
              {!plan.recordedLetter.sure ? (
                <>
                  If it is the copy of &ldquo;{plan.recordedLetter.subject}&rdquo;, sent on{' '}
                  {formatDate(plan.recordedLetter.sentAt)}, file it with that letter
                </>
              ) : plan.recordedLetter.copied ? (
                <>
                  Add it to &ldquo;{plan.recordedLetter.subject}&rdquo;, sent on{' '}
                  {formatDate(plan.recordedLetter.sentAt)}, as a second copy
                </>
              ) : (
                <>
                  File as the copy of &ldquo;{plan.recordedLetter.subject}&rdquo;, recorded as sent on{' '}
                  {formatDate(plan.recordedLetter.sentAt)}
                </>
              )}
            </BusyButton>
          </div>
        )}

        {plan && (plan.actions.includes('record_sent') || plan.actions.includes('record_only')) && (
          <div className="action-form">
            <div>
              <label htmlFor="copy-sent-on">Sent on</label>
              <input
                id="copy-sent-on"
                type="date"
                value={sentOn}
                max={today}
                disabled={busy}
                onChange={(e) => setSentOn(e.target.value)}
              />
              {/* What the copy itself says, beside the day it decides: an in-body forward
                  keeps the sending date only as text, without a timezone. */}
              {plan.dateText ? (
                <span className="meta">As written in the forward: &ldquo;{plan.dateText}&rdquo;</span>
              ) : null}
              {plan.copyDateBasis === 'forwarded' && (
                <span className="meta">
                  The copy only shows when it was forwarded ({formatDate(plan.copyDate)}). Enter the
                  day the letter itself went out.
                </span>
              )}
            </div>
          </div>
        )}

        {plan?.actions.includes('record_sent') && (
          <div className="action-form">
            {plan.needsRespondent &&
              (plan.respondents.length > 0 ? (
                <div>
                  <label htmlFor="copy-dentist">Dentist it went to</label>
                  <select
                    id="copy-dentist"
                    value={respondentId}
                    disabled={busy}
                    onChange={(e) => setRespondentId(e.target.value)}
                  >
                    {plan.respondents.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="rti-warn">
                  No dentist is named on this case yet. Name them on the case page first: a notice
                  is counted against one dentist.
                </p>
              ))}
            <p className="rti-hint">
              {plan.needsRespondent && respondent
                ? `This counts as notice ${respondent.noticeCount + 1} to ${respondent.name}, sent by email.`
                : plan.effect}
            </p>
            <div className="action-buttons">
              <BusyButton
                type="button"
                busy={spinning('record_sent')}
                busyLabel="Recording…"
                disabled={busy || undecided || !dateOk || (plan.needsRespondent && !respondentId)}
                onClick={() => send('record_sent')}
              >
                Record it as sent on {on} and file the copy
              </BusyButton>
            </div>
          </div>
        )}

        {plan?.actions.includes('record_only') && (
          <div className="action-form">
            <p className="rti-hint">Nothing on the case moves and no reminder starts or stops.</p>
            <div className="action-buttons">
              <BusyButton
                type="button"
                className={plan.actions[0] === 'record_only' ? undefined : 'link-button'}
                busy={spinning('record_only')}
                busyLabel="Filing…"
                disabled={busy || undecided || !dateOk}
                onClick={() => send('record_only')}
              >
                File it as a letter sent on {on} without recording a step
              </BusyButton>
            </div>
          </div>
        )}
        {failed}

        {plan && (
          <div className="action-form">
            <p className="rti-hint">
              Not a copy of our letter? If this is somebody&rsquo;s reply that quotes it, add it to{' '}
              {plan.caseNumber} as a letter received instead &mdash; that stops every reminder on the
              case that is waiting for a reply.
            </p>
            {confirmingReply ? (
              <>
                <p className="rti-warn">
                  This records it on {plan.caseNumber} as a letter received, not as a copy of our
                  letter
                  {plan.waitingForReply.length > 0 ? (
                    <>
                      , and stops every reminder there that is waiting for a reply:{' '}
                      {plan.waitingForReply.map((w) => w.label).join('; ')}.
                    </>
                  ) : (
                    <>. No reminder on the case is waiting for a reply.</>
                  )}
                </p>
                <div className="action-buttons">
                  <BusyButton
                    type="button"
                    busy={asReceived.busyOn}
                    busyLabel="Adding…"
                    disabled={busy}
                    onClick={() => asReceived.file(plan.caseFileId)}
                  >
                    Yes, add it as received
                  </BusyButton>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setConfirmingReply(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="action-buttons">
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => setConfirmingReply(true)}
                >
                  It is a reply &mdash; add it as received
                </button>
              </div>
            )}
            {asReceived.failed}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * "It is a complaint": the officer's word that a message the register took for a copy of
 * the Council's own letter is a complaint after all - a complainant's reply to the
 * Council's "please send your complaint in writing" mail, quoting it in a layout the
 * register misread. Without it such a message had no way onto the register at all: a copy
 * is never opened as a case, and there may be no case to file it on.
 *
 * Folded away behind one button, because the register's reading is usually right; opened,
 * it is the ordinary open-case form, filled in the same way.
 */
function ItIsAComplaint({
  summary,
  setSummary,
  name,
  setName,
  email,
  setEmail,
  busy,
  busyOn,
  failed,
  submit,
}: {
  summary: string;
  setSummary: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  busy: boolean;
  busyOn: boolean;
  failed: ReactNode;
  submit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Not our letter?</h2>
      </div>
      <div className="panel-body">
        {!open ? (
          <div className="action-form">
            <p className="rti-hint">
              If this is a complaint that only quotes a letter of ours, open a case from it instead.
            </p>
            <div className="action-buttons">
              <button type="button" className="link-button" disabled={busy} onClick={() => setOpen(true)}>
                It is a complaint &mdash; open a case
              </button>
            </div>
          </div>
        ) : (
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <p className="rti-hint">
              This takes the next number in the register. Check the three lines below first
              &mdash; they are what the case will carry from here on.
            </p>
            <div>
              <label htmlFor="complaint-summary">The grievance, in one line</label>
              <input
                id="complaint-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="complaint-name">Complainant</label>
              <input id="complaint-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="complaint-email">Their email</label>
              <input id="complaint-email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {failed}
            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busyOn}
                busyLabel="Opening…"
                disabled={busy || !summary.trim() || !name.trim()}
              >
                Open the case
              </BusyButton>
              <button type="button" className="link-button" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/** Setting a copy of a Council letter aside: a copy nobody needs on file. */
function NotNeeded({
  reason,
  setReason,
  busy,
  busyOn,
  failed,
  submit,
}: {
  reason: string;
  setReason: (reason: string) => void;
  busy: boolean;
  busyOn: boolean;
  failed: ReactNode;
  submit: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Not needed</h2>
      </div>
      <div className="panel-body">
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="rti-hint">
            It stays on the record, marked with your reason. Nothing is deleted.
          </p>
          <div>
            <label htmlFor="reason">Why</label>
            <input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="A second copy of a letter already on file"
            />
          </div>
          {failed}
          <div className="action-buttons">
            <BusyButton
              type="submit"
              busy={busyOn}
              busyLabel="Setting aside…"
              disabled={busy || reason.trim().length < 3}
            >
              Set it aside
            </BusyButton>
          </div>
        </form>
      </div>
    </section>
  );
}
