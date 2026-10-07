'use client';

import { useState } from 'react';
import type { Route } from 'next';
import type { MailSuggestionView } from '@/lib/api';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { SUGGESTION_CONFIDENCE_LABEL } from '@/lib/labels';
import { BusyButton } from '@/app/components/busy-button';
import { PendingLink } from '@/app/components/pending-link';
import { useCardAction } from './card-scope';
import {
  acceptBlocker,
  closedCaseWarning,
  confidenceChipClass,
  joinNames,
  suggestionHeadline,
} from './suggestion-text';

/**
 * The assistant's suggestion, on a card in the tray.
 *
 * One line under the snippet, saying what it suggests and how sure it is, with its reasons
 * a click away rather than in the way: the officer scanning twenty cards needs the verdict,
 * and only the doubtful ones need the argument.
 *
 * Accepting goes through the very services the ordinary buttons use, so what it can do is
 * exactly what they can do, and it confirms in the same places. Opening a case spends a
 * number from the legal register, so it confirms - naming the complainant and the dentists,
 * which the card's one line may have cut short. Adding to a case and setting aside are one
 * click, because the button itself names the case, or says it sets the message aside: the
 * ordinary "File it" and "Set aside" are one click too once their single field is filled,
 * and here the suggestion has filled it, in words on the button. The exception is a CLOSED
 * case: filing there cannot be undone from the tray and may mean the case should be
 * reopened, so it confirms, saying so - as the tray's own matcher warns before it does.
 *
 * Rejecting changes nothing but the suggestion: the message stays in the tray, and the
 * officer still decides it. A failure says so quietly and offers nothing to press - there is
 * nothing to accept, and the ordinary buttons beside it still work.
 */
export function TraySuggestion({
  messageId,
  suggestion: s,
}: {
  messageId: string;
  suggestion: MailSuggestionView;
}) {
  const { busy, busyFor, step, setStep, send, errorFor } = useCardAction();
  const [note, setNote] = useState('');
  const mine = busyFor('suggestion');
  const error = errorFor('suggestion');

  const headline = suggestionHeadline(s);
  if (!headline) return null;

  const failed = s.status === 'failed';
  const chip = confidenceChipClass(s);
  const blocker = acceptBlocker(s);
  const review = `/intake/${messageId}` as Route;

  function post(path: '/suggestion/accept' | '/suggestion/reject', body: unknown) {
    send(
      'suggestion',
      async () => {
        const res = await fetch(`${PUBLIC_API_URL}/v1/intake/${messageId}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(payload.message ?? 'That did not go through.');
        }
      },
      // The card goes as the refreshed tray arrives: accepted, it has left the tray;
      // rejected, it comes back without the suggestion. Either way, in one render.
      (_result, router) => {
        setStep(null);
        setNote('');
        router.refresh();
      },
    );
  }

  if (failed) {
    return <p className="suggest suggest-quiet">{headline}</p>;
  }

  const nc = s.newComplaint;
  const dentists = nc ? joinNames(nc.respondents.map((r) => r.name)) : '';
  const closed = closedCaseWarning(s);

  return (
    <div className="suggest">
      <p className="suggest-line">
        {headline}
        {chip && s.confidence && (
          <span className={chip}>{SUGGESTION_CONFIDENCE_LABEL[s.confidence]}</span>
        )}
      </p>

      {/* 'Not sure' has its reasons in the line itself; repeating them below would be noise. */}
      {s.reasoning && s.decision !== 'unsure' && (
        <details className="suggest-why">
          <summary>Why it thinks so</summary>
          <p>{s.reasoning}</p>
        </details>
      )}

      {step === 'accept' && s.decision === 'follow_up' && s.followUp && closed ? (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            post('/suggestion/accept', {});
          }}
        >
          <span>
            {closed} <PendingLink href={review}>Pick another case instead</PendingLink>
          </span>
          {error && <span className="rti-error">{error}</span>}
          <div className="action-buttons">
            <BusyButton type="submit" busy={mine} disabled={busy} busyLabel="Adding…">
              Add it to the closed case
            </BusyButton>
            <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : step === 'accept' && nc ? (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            post('/suggestion/accept', {});
          }}
        >
          <span>
            Open a new case for <strong>{nc.complainantName}</strong>
            {nc.complainantEmail && (
              <>
                {' '}
                <span className="mono">&lt;{nc.complainantEmail}&gt;</span>
              </>
            )}
            {dentists ? (
              <>
                , naming <strong>{dentists}</strong>
              </>
            ) : (
              ', with no dentist named yet'
            )}
            ? It takes the next case number.{' '}
            <PendingLink href={review}>Change something first</PendingLink>
          </span>
          {error && <span className="rti-error">{error}</span>}
          <div className="action-buttons">
            <BusyButton type="submit" busy={mine} disabled={busy} busyLabel="Opening…">
              Open the case
            </BusyButton>
            <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : step === 'reject' ? (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            post('/suggestion/reject', note.trim() ? { note: note.trim() } : {});
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was wrong with it? (optional)"
            aria-label="What was wrong with the suggestion (optional)"
          />
          <span className="rti-hint">The message stays here for you to decide.</span>
          {error && <span className="rti-error">{error}</span>}
          <div className="action-buttons">
            <BusyButton type="submit" busy={mine} disabled={busy} busyLabel="Turning down…">
              Reject the suggestion
            </BusyButton>
            <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="suggest-actions">
            {s.decision === 'new_complaint' && !blocker && (
              <button type="button" className="link-button" disabled={busy} onClick={() => setStep('accept')}>
                Accept
              </button>
            )}
            {s.decision === 'follow_up' && !blocker && s.followUp && (
              <BusyButton
                type="button"
                className="link-button"
                busy={mine}
                disabled={busy}
                busyLabel="Adding…"
                // A closed case confirms first (see above); an open one is one click.
                onClick={() => (closed ? setStep('accept') : post('/suggestion/accept', {}))}
              >
                Accept: add to {s.followUp.caseNumber}
                {s.followUp.closed ? ' (closed)' : ''}
              </BusyButton>
            )}
            {s.decision === 'not_a_complaint' && !blocker && (
              <BusyButton
                type="button"
                className="link-button"
                busy={mine}
                disabled={busy}
                busyLabel="Setting aside…"
                onClick={() => post('/suggestion/accept', {})}
              >
                Accept: set aside
              </BusyButton>
            )}
            <PendingLink href={review}>Review</PendingLink>
            <button type="button" className="link-button" disabled={busy} onClick={() => setStep('reject')}>
              Reject
            </button>
          </div>
          {/* Said only where the officer can act on it: a follow-up to a number that is not
              a live case is fixed on the message page, by picking the right case; a new
              complaint with nobody named as complainant, by entering who. */}
          {s.decision === 'follow_up' && blocker && (
            <p className="suggest-note">{blocker} Review it to pick the right case.</p>
          )}
          {s.decision === 'new_complaint' && blocker && (
            <p className="suggest-note">{blocker} Review it to enter the complainant.</p>
          )}
          {error && <p className="rti-error">{error}</p>}
        </>
      )}
    </div>
  );
}
