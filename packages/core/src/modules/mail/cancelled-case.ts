import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';

/**
 * What becomes of the mail filed on a case when the case is cancelled as opened in error,
 * and when that is undone.
 *
 * Two of the commonest reasons to cancel are about mail. A message that was not a
 * complaint was opened as a case from the tray; or a complainant's email was opened as a
 * new case when the complaint was already on file - typed in from the paper letter, say.
 * Either way the message is still something the Council received and has to account for,
 * and the cancelled case is not its home: the first should be marked "not a complaint",
 * the second added to the case it duplicates, with the complainant's bills and OPG.
 *
 * Left filed on the cancelled case, it could be neither. The tray refuses to dismiss or
 * re-file a message that is on a case, the case is on no list, and so the complaint's own
 * words and evidence would never reach the real case or the committee bundle built from
 * it. So cancelling puts the message back in the tray, and the officer does with it what
 * should have been done the first time.
 *
 * What is NOT undone, because it happened: the inbound letter the filing recorded on the
 * cancelled case, and the documents its attachments became. They stay on that case as the
 * record of what it held. case_file_id and correspondence_id stay on the message as well -
 * the status alone says it is back in the tray - which is how the tray card and the
 * message page can say where it had been, and how restore() finds what to put back.
 * Filing it anywhere else overwrites both, and its files are copied to the new case on the
 * way (see MailIntakeService.restageFromCancelledCase).
 */

/**
 * Put the mail filed on a case back in the tray, because the case has just been cancelled.
 * Returns how many messages went back.
 */
export async function returnMailToTray(
  tx: Tx,
  ctx: EngineContext,
  caseFileId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE mail_message SET status = 'unfiled'
    WHERE council_id = ${ctx.councilId}::uuid AND case_file_id = ${caseFileId}::uuid
      AND status = 'filed'
    RETURNING id
  `);
  return rows.rows.length;
}

/**
 * The other half, for a case being restored: whatever went back to the tray from it and is
 * still there, untouched, is filed on it again. Its letter and its documents never left
 * the case, so the status is all that changes - no second inbound letter, no second copy
 * of a file. Held files the store had not taken yet go on at the reader's next sweep, as
 * they would have done had the case never been cancelled.
 *
 * Not a message the officer has dealt with since. One added to another case points there
 * now; one marked "not a complaint" is no longer unfiled. Those were decisions a person
 * made after the cancellation, and undoing the cancellation does not overrule them.
 */
export async function refileMailFromTray(
  tx: Tx,
  ctx: EngineContext,
  caseFileId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE mail_message SET status = 'filed'
    WHERE council_id = ${ctx.councilId}::uuid AND case_file_id = ${caseFileId}::uuid
      AND status = 'unfiled'
    RETURNING id
  `);
  return rows.rows.length;
}

/** What the tray card says about a message that came back from a cancelled case. */
export function returnedToTrayNote(caseNumber: string, reason: string | null): string {
  return (
    `This was on ${caseNumber}, which was cancelled as opened in error` +
    (reason ? ` (${reason})` : '') +
    ', so it is back here. Add it to the right case, or mark it not a complaint.'
  );
}
