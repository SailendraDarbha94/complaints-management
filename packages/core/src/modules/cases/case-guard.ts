import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { ConflictError, NotFoundError } from '../../common/domain-error.js';
import type { EngineContext } from '../followups/followup.service.js';

/**
 * The one check every write onto a case makes: is it still a case?
 *
 * A case cancelled as opened in error is frozen. It keeps its number and everything on it,
 * and the register goes on listing it, but nothing more is added to it - no event, no
 * letter, no respondent, no document, no mail. Two reasons, and the second is the one that
 * matters. First, anything written to it is invisible: it is on no working list, so a
 * letter drafted on it is a letter nobody will ever see again. Second, a write that moves
 * it - a notice confirmed as sent - starts a clock against a real dentist on a case the
 * Council has already said should not exist.
 *
 * So the refusal says what happened and what to do about it, rather than "not found": the
 * case IS found, and the officer who reached it through an old link or a stale tab needs to
 * know that restoring it is the way forward if it should carry on after all.
 *
 * Deliberately NOT called by the corrections that record facts about things already on the
 * file - withdrawing a misfiled document, noting that physical originals went back,
 * entering the office's dispatch number for a letter that did go out. Those stay true
 * whether or not the case should ever have been opened, and the Council may still be
 * holding a complainant's papers for a case it cancelled.
 */

export class CaseCancelledError extends ConflictError {
  constructor(
    readonly caseNumber: string,
    readonly reason: string | null,
  ) {
    super(
      `${caseNumber} was cancelled as opened in error` +
        (reason ? ` (${reason})` : '') +
        ', so nothing more can be added to it. If it should carry on after all, restore it ' +
        'from its page first.',
    );
    this.name = 'CaseCancelledError';
  }
}

export interface LiveCase {
  id: string;
  caseNumber: string;
}

/**
 * Refuse unless the case exists in this council and has not been cancelled.
 *
 * Scoped to ctx.councilId explicitly as well as by row-level security, the same belt and
 * braces the lifecycle uses: a case id from another council is "not in the register", never
 * a cross-council write that RLS happens to stop one statement later.
 *
 * FOR UPDATE, because a check that does not hold is not a check. Read plainly, a cancel in
 * another tab that commits between this SELECT and the caller's write goes unseen: the
 * write lands on a case that has just been cancelled - after cancel() has already stopped
 * its follow-ups, so a notice confirmed as sent in that gap would open a fresh chase against
 * a real dentist on a case that is off every list, and the nightly tick would escalate it
 * all the way to an ex parte proposal. With the row locked, the two serialise: a cancel
 * that got there first is seen here and refused, and one that comes second waits for this
 * transaction to commit, then stops whatever it opened. The lock is held to the end of the
 * caller's transaction and costs nothing in practice - one officer, one case at a time.
 */
export async function assertCaseLive(
  tx: Tx,
  ctx: EngineContext,
  caseFileId: string,
): Promise<LiveCase> {
  const rows = await tx.execute<{
    id: string;
    case_number: string;
    deleted_at: Date | null;
    deletion_reason: string | null;
  }>(sql`
    SELECT id, case_number, deleted_at, deletion_reason
    FROM case_file
    WHERE council_id = ${ctx.councilId}::uuid AND id = ${caseFileId}::uuid
    FOR UPDATE
  `);
  const row = rows.rows[0];
  if (!row) throw new NotFoundError('That case is not in the register.');
  if (row.deleted_at) throw new CaseCancelledError(row.case_number, row.deletion_reason);
  return { id: row.id, caseNumber: row.case_number };
}
