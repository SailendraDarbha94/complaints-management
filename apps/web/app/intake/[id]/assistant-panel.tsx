'use client';

import { useState, type ReactNode } from 'react';
import type { Route } from 'next';
import type {
  AssistantState,
  MailSuggestionView,
  SuggestedRespondent,
  SuggestionOverrides,
} from '@/lib/api';
import {
  SUGGESTION_CONFIDENCE_LABEL,
  SUGGESTION_OUTCOME_LABEL,
  SUGGESTION_STATUS_LABEL,
  formatDateTime,
  formatRupeesFromUsd,
  label,
} from '@/lib/labels';
import { BusyButton } from '@/app/components/busy-button';
import { PendingLink } from '@/app/components/pending-link';
import {
  acceptBlocker,
  closedCaseWarning,
  confidenceChipClass,
  joinNames,
  knownToRegister,
  normaliseRespondent,
  respondentParticulars,
  sameRespondents,
  suggestionHeadline,
} from '../suggestion-text';

export type AssistantPath = '/suggestion/accept' | '/suggestion/reject' | '/suggestion/refresh';

type CaseOption = { id: string; caseNumber: string; summary: string };
type Candidate = { caseFileId: string; caseNumber: string; because: string; isClosed: boolean };

/**
 * The assistant's panel on the message page - at the top of the side column, because it is
 * the first opinion on what to do with the message, and the forms below it are the means.
 *
 * Everything the card shows, in full: what it suggests, how sure it is, why, and the
 * particulars it would carry out - who the complainant is, which dentists, which case. From
 * here the officer can accept it, change it and accept, reject it with a note, or ask
 * again. None of that is the model acting: Accept goes through the same services as the
 * ordinary forms below, and only the officer's click changes the register.
 *
 * It owns no request of its own. MessageActions runs every request on this page through one
 * useAction, so accepting here and opening a case below can never both land; this panel is
 * handed that action's `post`, `busy` and per-button error.
 *
 * When the assistant is off it shows one quiet line saying so, and why - the setting to
 * fix - on a message still in the tray, and otherwise nothing, unless the message already
 * has a suggestion from when it was on: that is part of the record, and accepting it
 * needs no model.
 *
 * Accepting a NEW COMPLAINT confirms first, naming the complainant and the dentists, as the
 * tray does: it spends the next serial of a legal register, and this button is the
 * filled one at the top of the column - the one a hand finds by accident. So does filing
 * on a CLOSED case. Adding to an open case and setting aside are one click.
 */
export function AssistantPanel({
  suggestion: s,
  assistant,
  messageStatus,
  candidates,
  cases,
  busy,
  busyOn,
  failed,
  post,
}: {
  suggestion: MailSuggestionView | null;
  assistant: AssistantState;
  messageStatus: string;
  candidates: Candidate[];
  cases: CaseOption[];
  /** Anything on the page in flight: every button here is shut. */
  busy: boolean;
  /** This button's request in flight: it spins. */
  busyOn: (path: AssistantPath) => boolean;
  /** The refusal for this button's request, if the last one was its. */
  failed: (path: AssistantPath) => ReactNode;
  post: (path: AssistantPath, body?: unknown) => void;
}) {
  const [mode, setMode] = useState<'view' | 'confirm' | 'edit' | 'reject'>('view');
  const [note, setNote] = useState('');

  // Only for a message still in the tray: asking about a message already on a case would
  // spend credits on a question nobody can act on.
  const canAsk = assistant.enabled && messageStatus === 'unfiled';

  if (!s) {
    if (!canAsk) {
      // Off, on a message still waiting: one line, with the setting to fix. This is where
      // the guide sends whoever switched it on and sees nothing happen - a page that stayed
      // silent here would leave them guessing which line of which file was wrong.
      if (!assistant.enabled && messageStatus === 'unfiled') {
        return (
          <section className="panel">
            <div className="panel-head">
              <h2>Assistant</h2>
              <span className="n">Off</span>
            </div>
            <div className="panel-body">
              <p className="rti-hint">
                The mail assistant is switched off
                {assistant.reason ? <>: {assistant.reason}</> : '.'} The forms below work as
                always.
              </p>
            </div>
          </section>
        );
      }
      return null;
    }
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Assistant</h2>
        </div>
        <div className="panel-body">
          <p className="rti-hint">
            The assistant has not read this message. It can suggest whether it is a new
            complaint, a letter about a case already open, or not a complaint at all. It only
            suggests: nothing changes until you accept.
          </p>
          {failed('/suggestion/refresh')}
          <div className="action-row">
            <BusyButton
              type="button"
              className="action"
              busy={busyOn('/suggestion/refresh')}
              disabled={busy}
              busyLabel="Reading it…"
              onClick={() => post('/suggestion/refresh')}
            >
              Ask the assistant
            </BusyButton>
          </div>
          <p className="rti-hint">
            Each reading uses a little of the Council&rsquo;s Claude credits and counts towards
            the daily limit. It can take up to a minute.
          </p>
        </div>
      </section>
    );
  }

  const headline = suggestionHeadline(s);
  const chip = confidenceChipClass(s);
  const isFailed = s.status === 'failed';
  const open = s.status === 'pending' && messageStatus === 'unfiled';
  const blocker = acceptBlocker(s);
  const nc = s.newComplaint;
  const fu = s.followUp;
  const closed = closedCaseWarning(s);
  // See the header: these two confirm before they act; the rest are one click.
  const confirmFirst = s.decision === 'new_complaint' || Boolean(closed);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Assistant</h2>
        <span className="n">{SUGGESTION_STATUS_LABEL[s.status]}</span>
      </div>
      <div className="panel-body">
        {headline && (
          <p className={isFailed ? 'suggest-line suggest-quiet' : 'suggest-line'}>
            {headline}
            {chip && s.confidence && (
              <span className={chip}>{SUGGESTION_CONFIDENCE_LABEL[s.confidence]}</span>
            )}
          </p>
        )}

        {/* In full here, not behind a click: this is the page for looking closely. 'Not
            sure' already has its reasons in the headline. */}
        {!isFailed && s.reasoning && s.decision !== 'unsure' && (
          <p className="action-why assistant-reasoning">{s.reasoning}</p>
        )}

        {mode !== 'edit' && s.decision === 'new_complaint' && nc && (
          <dl className="pairs assistant-pairs">
            <div>
              <dt>The grievance</dt>
              <dd>{nc.summary}</dd>
            </div>
            <div>
              <dt>Complainant</dt>
              <dd>
                {nc.complainantName}
                {nc.complainantEmail && <span className="meta">{nc.complainantEmail}</span>}
              </dd>
            </div>
            <div>
              <dt>{nc.respondents.length === 1 ? 'Dentist' : 'Dentists'}</dt>
              <dd>
                {nc.respondents.length === 0 ? (
                  <span className="meta">None named. You can name one on the case.</span>
                ) : (
                  <ul className="plain">
                    {nc.respondents.map((r, i) => (
                      <li key={`${r.partyId ?? r.registeredDentistId ?? r.name}-${i}`}>
                        {r.name}
                        {respondentParticulars(r) && <span className="meta">{respondentParticulars(r)}</span>}
                        {knownToRegister(r) && <span className="meta">{knownToRegister(r)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        )}

        {mode !== 'edit' && s.decision === 'follow_up' && fu && (
          <dl className="pairs assistant-pairs">
            <div>
              <dt>Case</dt>
              <dd>
                {fu.caseFileId ? (
                  <>
                    <PendingLink href={`/cases/${fu.caseFileId}` as Route}>{fu.caseNumber}</PendingLink>
                    {fu.closed && <span className="meta warn">Closed.</span>}
                  </>
                ) : (
                  <>
                    {fu.caseNumber}
                    <span className="meta warn">Not a live case in the register.</span>
                  </>
                )}
              </dd>
            </div>
          </dl>
        )}

        {s.outcome && <Outcome outcome={s.outcome} />}

        {open && mode === 'view' && (
          // A form, so Accept is a submit button and takes the page's one filled style
          // (.action-buttons button[type='submit']) like every other "do it" on this page.
          <form
            className="action-form assistant-actions"
            onSubmit={(e) => {
              e.preventDefault();
              if (blocker) return;
              if (confirmFirst) setMode('confirm');
              else post('/suggestion/accept', {});
            }}
          >
            {blocker ? (
              <p className="rti-hint">
                {blocker}{' '}
                {s.decision === 'follow_up'
                  ? 'Change and accept to pick the right case.'
                  : s.decision === 'new_complaint'
                    ? "Change and accept to enter the complainant's name."
                    : 'Decide with the forms below; what you do is still recorded against this suggestion, so the figures stay honest.'}
              </p>
            ) : s.decision === 'new_complaint' ? (
              <p className="rti-hint">This takes the next number in the register.</p>
            ) : closed ? (
              <p className="rti-hint">{closed}</p>
            ) : null}
            {failed('/suggestion/accept')}
            <div className="action-buttons">
              {!blocker && (
                <BusyButton
                  type="submit"
                  busy={busyOn('/suggestion/accept')}
                  disabled={busy}
                  busyLabel={
                    s.decision === 'new_complaint'
                      ? 'Opening…'
                      : s.decision === 'follow_up'
                        ? 'Adding…'
                        : 'Setting aside…'
                  }
                >
                  {s.decision === 'new_complaint'
                    ? 'Accept: open the case'
                    : s.decision === 'follow_up' && fu
                      ? `Accept: add to ${fu.caseNumber}`
                      : 'Accept: set it aside'}
                </BusyButton>
              )}
              {s.decision !== 'unsure' && (
                <button type="button" className="link-button" disabled={busy} onClick={() => setMode('edit')}>
                  Change and accept
                </button>
              )}
              <button type="button" className="link-button" disabled={busy} onClick={() => setMode('reject')}>
                Reject
              </button>
            </div>
          </form>
        )}

        {open && mode === 'confirm' && (
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              post('/suggestion/accept', {});
            }}
          >
            {s.decision === 'new_complaint' && nc ? (
              <p className="action-why">
                Open a new case for <strong>{nc.complainantName}</strong>
                {nc.complainantEmail && <> &lt;{nc.complainantEmail}&gt;</>}
                {nc.respondents.length > 0 ? (
                  <>
                    , naming <strong>{joinNames(nc.respondents.map((r) => r.name))}</strong>
                  </>
                ) : (
                  ', with no dentist named yet'
                )}
                ? It takes the next number in the register, which cannot be taken back.
              </p>
            ) : (
              <p className="action-why">{closed}</p>
            )}
            {failed('/suggestion/accept')}
            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busyOn('/suggestion/accept')}
                disabled={busy}
                busyLabel={s.decision === 'new_complaint' ? 'Opening…' : 'Adding…'}
              >
                {s.decision === 'new_complaint' ? 'Open the case' : 'Add it to the closed case'}
              </BusyButton>
              <button type="button" className="link-button" disabled={busy} onClick={() => setMode('view')}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {open && mode === 'edit' && (
          <EditAndAccept
            suggestion={s}
            candidates={candidates}
            cases={cases}
            busy={busy}
            spinning={busyOn('/suggestion/accept')}
            refusal={failed('/suggestion/accept')}
            onAccept={(overrides) =>
              post('/suggestion/accept', Object.keys(overrides).length ? { overrides } : {})
            }
            onCancel={() => setMode('view')}
          />
        )}

        {open && mode === 'reject' && (
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              post('/suggestion/reject', note.trim() ? { note: note.trim() } : {});
            }}
          >
            <div>
              <label htmlFor="as-note">What was wrong with it? (optional)</label>
              <input id="as-note" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            </div>
            <p className="rti-hint">
              Nothing happens to the message: it stays in the tray for you to decide below.
              Your note helps show where the assistant goes wrong.
            </p>
            {failed('/suggestion/reject')}
            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busyOn('/suggestion/reject')}
                disabled={busy}
                busyLabel="Turning down…"
              >
                Reject the suggestion
              </BusyButton>
              <button type="button" className="link-button" disabled={busy} onClick={() => setMode('view')}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {canAsk && mode === 'view' && (
          <div className="assistant-ask">
            <BusyButton
              type="button"
              className="link-button"
              busy={busyOn('/suggestion/refresh')}
              disabled={busy}
              busyLabel="Reading it again…"
              onClick={() => post('/suggestion/refresh')}
            >
              Ask again
            </BusyButton>
            <p className="rti-hint">
              Reads the message afresh and replaces this suggestion. It uses the
              Council&rsquo;s Claude credits
              {s.costUsd > 0 ? <> &mdash; this reading cost {formatRupeesFromUsd(s.costUsd)}</> : null}{' '}
              &mdash; and can take up to a minute.
            </p>
            {failed('/suggestion/refresh')}
          </div>
        )}

        {/* "Accepting still works" only where Accept is on screen: a failed or settled
            suggestion has no buttons, and saying otherwise would send the officer looking
            for them. */}
        {!assistant.enabled && messageStatus === 'unfiled' && (
          <p className="rti-hint">
            The assistant is switched off{assistant.reason ? ` (${assistant.reason})` : ''}, so
            it cannot be asked again.
            {open ? ' Accepting or rejecting this suggestion still works.' : ''}
          </p>
        )}
      </div>
    </section>
  );
}

/** What became of the suggestion - told plainly, including when the officer went another way. */
function Outcome({ outcome }: { outcome: NonNullable<MailSuggestionView['outcome']> }) {
  if (outcome.action === 'rejected') {
    return (
      <p className="action-why assistant-outcome">
        You turned this suggestion down on {formatDateTime(outcome.at)}
        {outcome.note ? <>: <em>{outcome.note}</em></> : '.'}
      </p>
    );
  }
  return (
    <p className="action-why assistant-outcome">
      You {label(SUGGESTION_OUTCOME_LABEL, outcome.action)}
      {outcome.caseFileId && outcome.caseNumber && (
        <>
          {' '}
          &mdash;{' '}
          <PendingLink href={`/cases/${outcome.caseFileId}` as Route}>{outcome.caseNumber}</PendingLink>
        </>
      )}{' '}
      on {formatDateTime(outcome.at)}
      {outcome.agreed === true
        ? ', as it suggested.'
        : outcome.agreed === false
          ? ', which is not what it suggested.'
          : '.'}
      {outcome.note && <span className="meta">{outcome.note}</span>}
    </p>
  );
}

// ─── Change and accept ───────────────────────────────────────────────────────

/** A row in the dentists list, keyed for React, remembering what the model matched it to. */
interface DentistRow {
  key: number;
  value: SuggestedRespondent;
  /** The suggestion's own entry this row began as; null for a row the officer added. */
  origin: SuggestedRespondent | null;
}

/**
 * The suggestion's fields, editable, then accepted.
 *
 * Only what the officer actually changed is sent, because the server records ANY override
 * as an edit - and an agreement rate that counted "opened the form, changed nothing" as a
 * correction would undersell the assistant for no reason. Blank text and trailing spaces do
 * not count as changes (normaliseRespondent).
 *
 * A dentist the model matched to the register keeps that match - the partyId or register
 * entry that joins this complaint to their earlier cases - until its NAME is edited, which
 * clears it: a match made on one name must not be carried over to a different one. Typing
 * the name back as it was restores it, so a slip of the keyboard does not cost the match.
 */
function EditAndAccept({
  suggestion: s,
  candidates,
  cases,
  busy,
  spinning,
  refusal,
  onAccept,
  onCancel,
}: {
  suggestion: MailSuggestionView;
  candidates: Candidate[];
  cases: CaseOption[];
  busy: boolean;
  spinning: boolean;
  refusal: ReactNode;
  onAccept: (overrides: SuggestionOverrides) => void;
  onCancel: () => void;
}) {
  const nc = s.newComplaint;
  const fu = s.followUp;
  const nac = s.notComplaint;

  const [summary, setSummary] = useState(nc?.summary ?? '');
  const [name, setName] = useState(nc?.complainantName ?? '');
  const [email, setEmail] = useState(nc?.complainantEmail ?? '');
  const [rows, setRows] = useState<DentistRow[]>(() =>
    (nc?.respondents ?? []).map((r, i) => ({ key: i, value: { ...r }, origin: r })),
  );
  const [nextKey, setNextKey] = useState(nc?.respondents.length ?? 0);
  const [caseFileId, setCaseFileId] = useState(
    fu?.caseFileId ?? candidates[0]?.caseFileId ?? cases[0]?.id ?? '',
  );
  const [reason, setReason] = useState(nac?.reason ?? '');

  function update(key: number, change: Partial<SuggestedRespondent>) {
    setRows((all) => all.map((row) => (row.key === key ? { ...row, value: { ...row.value, ...change } } : row)));
  }

  function rename(row: DentistRow, next: string) {
    const back = row.origin && next.trim() === row.origin.name.trim();
    update(row.key, {
      name: next,
      partyId: back ? row.origin!.partyId : null,
      registeredDentistId: back ? row.origin!.registeredDentistId : null,
      priorCases: back ? row.origin!.priorCases : null,
    });
  }

  function addRow() {
    setRows((all) => [
      ...all,
      {
        key: nextKey,
        value: {
          name: '',
          registrationNo: null,
          clinicName: null,
          isEstablishment: false,
          partyId: null,
          registeredDentistId: null,
        },
        origin: null,
      },
    ]);
    setNextKey((k) => k + 1);
  }

  function overrides(): SuggestionOverrides {
    const o: SuggestionOverrides = {};
    if (s.decision === 'new_complaint' && nc) {
      if (summary.trim() !== nc.summary.trim()) o.summary = summary.trim();
      if (name.trim() !== nc.complainantName.trim()) o.complainantName = name.trim();
      const mail = email.trim() || null;
      if (mail !== (nc.complainantEmail?.trim() || null)) o.complainantEmail = mail;
      const now = rows.map((r) => r.value);
      if (!sameRespondents(now, nc.respondents)) o.respondents = now.map(normaliseRespondent);
    }
    if (s.decision === 'follow_up' && caseFileId && caseFileId !== fu?.caseFileId) {
      o.caseFileId = caseFileId;
    }
    if (s.decision === 'not_a_complaint' && nac && reason.trim() !== nac.reason.trim()) {
      o.reason = reason.trim();
    }
    return o;
  }

  const unnamed = rows.some((r) => !r.value.name.trim());
  const ready =
    s.decision === 'new_complaint'
      ? Boolean(summary.trim() && name.trim()) && !unnamed
      : s.decision === 'follow_up'
        ? Boolean(caseFileId)
        : reason.trim().length >= 3;

  // The suggested case first, even when it is closed and so missing from the open-case
  // list; then the register's own matches; then every other open case.
  const suggestedListed =
    fu?.caseFileId &&
    (candidates.some((c) => c.caseFileId === fu.caseFileId) || cases.some((c) => c.id === fu.caseFileId));

  return (
    <form
      className="action-form assistant-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onAccept(overrides());
      }}
    >
      <p className="rti-hint">
        Change what is wrong, then accept. What you change is recorded against the suggestion,
        which is how the report shows where the assistant goes wrong.
      </p>

      {s.decision === 'new_complaint' && (
        <>
          <div>
            <label htmlFor="as-summary">The grievance, in one line</label>
            <input id="as-summary" value={summary} onChange={(e) => setSummary(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="as-name">Complainant</label>
            <input id="as-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="as-email">Their email</label>
            <input id="as-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          <fieldset className="assistant-dentists">
            <legend>Dentists to name on the case</legend>
            {rows.length === 0 && <p className="rti-hint">None. You can also name one on the case later.</p>}
            {rows.map((row) => {
              const known = knownToRegister(row.value);
              const lost = Boolean(
                row.origin && (row.origin.partyId || row.origin.registeredDentistId) && !known,
              );
              return (
                <div className="assistant-dentist" key={row.key}>
                  <label>
                    Name
                    <input value={row.value.name} onChange={(e) => rename(row, e.target.value)} />
                  </label>
                  {known && <span className="meta">{known}</span>}
                  {lost && (
                    <span className="meta warn">
                      The name was changed, so this is no longer matched to the register.
                    </span>
                  )}
                  <label>
                    Registration number
                    <input
                      value={row.value.registrationNo ?? ''}
                      onChange={(e) => update(row.key, { registrationNo: e.target.value })}
                    />
                  </label>
                  <label>
                    Clinic
                    <input
                      value={row.value.clinicName ?? ''}
                      onChange={(e) => update(row.key, { clinicName: e.target.value })}
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={row.value.isEstablishment}
                      onChange={(e) => update(row.key, { isEstablishment: e.target.checked })}
                    />
                    <span>A clinic or chain, not one dentist</span>
                  </label>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <button type="button" className="link-button" disabled={busy} onClick={addRow}>
              Add a dentist
            </button>
            {unnamed && <p className="rti-hint">Each dentist needs a name, or remove the row.</p>}
          </fieldset>
          <p className="rti-hint">This takes the next number in the register.</p>
        </>
      )}

      {s.decision === 'follow_up' && (
        <div>
          <label htmlFor="as-case">Case</label>
          <select id="as-case" value={caseFileId} onChange={(e) => setCaseFileId(e.target.value)}>
            {!caseFileId && <option value="">Pick a case</option>}
            {fu?.caseFileId && !suggestedListed && (
              <option value={fu.caseFileId}>{fu.caseNumber} (suggested)</option>
            )}
            {candidates.map((c) => (
              <option key={c.caseFileId} value={c.caseFileId}>
                {c.caseNumber} — {c.because}
                {c.isClosed ? ' (closed)' : ''}
                {c.caseFileId === fu?.caseFileId ? ' (suggested)' : ''}
              </option>
            ))}
            {cases
              .filter((c) => !candidates.some((k) => k.caseFileId === c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.caseNumber} — {c.summary}
                  {c.id === fu?.caseFileId ? ' (suggested)' : ''}
                </option>
              ))}
          </select>
          {fu && <p className="rti-hint">It said: {fu.because}</p>}
        </div>
      )}

      {s.decision === 'not_a_complaint' && (
        <div>
          <label htmlFor="as-reason">Why it is not a complaint</label>
          <input id="as-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <p className="rti-hint">Recorded on the message when it is set aside. Nothing is deleted.</p>
        </div>
      )}

      {refusal}
      <div className="action-buttons">
        <BusyButton
          type="submit"
          busy={spinning}
          disabled={busy || !ready}
          busyLabel={
            s.decision === 'new_complaint' ? 'Opening…' : s.decision === 'follow_up' ? 'Adding…' : 'Setting aside…'
          }
        >
          {s.decision === 'new_complaint'
            ? 'Open the case'
            : s.decision === 'follow_up'
              ? 'Add it to this case'
              : 'Set it aside'}
        </BusyButton>
        <button type="button" className="link-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
