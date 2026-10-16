'use client';

import { Fragment, useState } from 'react';
import { PendingLink } from '@/app/components/pending-link';
import type { CaseLetter } from '@/lib/api';
import { LETTER_LABEL, formatDate, label } from '@/lib/labels';

/**
 * The Letters table on the case page: every letter sent or received, each readable where
 * it is listed.
 *
 * An opened letter used to sit inside the first cell. A letter is long and set in a
 * monospace face that keeps its line breaks, so that one cell took the table: the Sent
 * dates broke over three lines and the dispatch number was pushed out of sight. So the row
 * now holds only what the officer scans - which letter, in or out, its subject - and the
 * subject is a button that opens the text in a row of its own beneath, the whole width of
 * the table.
 *
 * Its own file, taking the letters as props, so it can be looked at with sample data
 * without a case behind it.
 */

type Letter = Pick<
  CaseLetter,
  | 'id'
  | 'kind'
  | 'direction'
  | 'subject'
  | 'body'
  | 'to_name'
  | 'from_email'
  | 'sent_at'
  | 'received_at'
  | 'despatch_no'
  | 'copy_mail_id'
  | 'copy_emailed_at'
>;

const COLUMNS = 4;

export function LettersTable({ letters }: { letters: Letter[] }) {
  // Several may be open at once: comparing two letters side by side in the register is
  // ordinary, and closing one because another was opened would lose the officer's place.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  function toggle(id: string) {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    // Scrolls sideways inside the panel on a phone, rather than pushing the page wider.
    <div className="table-scroll">
      <table className="inner-table letters-table">
        <thead>
          <tr>
            <th>Letter</th>
            <th>To / from</th>
            <th>Sent</th>
            <th>Dispatch no.</th>
          </tr>
        </thead>
        <tbody>
          {letters.map((l) => {
            const readable = Boolean(l.body?.trim());
            const isOpen = readable && opened.has(l.id);
            const textId = `letter-text-${l.id}`;
            return (
              <Fragment key={l.id}>
                <tr className={isOpen ? 'letter-row is-open' : 'letter-row'}>
                  <td>
                    {label(LETTER_LABEL, l.kind)}
                    {l.direction === 'in' && <span className="chip chip-in">in</span>}
                    {readable ? (
                      <button
                        type="button"
                        className="letter-toggle"
                        aria-expanded={isOpen}
                        aria-controls={textId}
                        onClick={() => toggle(l.id)}
                      >
                        <span className="letter-caret" aria-hidden="true">
                          {isOpen ? '▾' : '▸'}
                        </span>
                        {l.subject}
                      </button>
                    ) : (
                      <span className="meta">{l.subject}</span>
                    )}
                  </td>
                  <td className="wrap">{l.to_name ?? l.from_email ?? '-'}</td>
                  <td className="mono letter-date">
                    {l.sent_at || l.received_at ? (
                      formatDate(l.sent_at ?? l.received_at)
                    ) : (
                      <span className="chip chip-draft">draft</span>
                    )}
                    {l.copy_mail_id && (
                      // A copy of this letter reached the intake mailbox and was filed
                      // against it: the proof of what was sent.
                      <PendingLink className="meta" href={`/intake/${l.copy_mail_id}`}>
                        Copy on file,{' '}
                        <span className="nowrap">emailed {formatDate(l.copy_emailed_at)}</span>
                      </PendingLink>
                    )}
                  </td>
                  <td className="mono letter-date">{l.despatch_no ?? '-'}</td>
                </tr>
                {readable && (
                  // Always rendered, hidden while closed, so the button's aria-controls
                  // names an element that exists.
                  <tr id={textId} className="letter-text-row" hidden={!isOpen}>
                    <td colSpan={COLUMNS}>
                      <div className="rti-letter">{l.body}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
