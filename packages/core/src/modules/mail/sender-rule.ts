import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { pgTextArray } from '../../common/pg-array.js';
import type { EngineContext } from '../followups/followup.service.js';
import { UNREADABLE_SNIPPET } from './mail-intake.service.js';
import { notFromListedReason } from './sender-check.js';

/**
 * The sender rule, applied once to the mail already waiting in the tray.
 *
 * Switching on intakeSenders (council-config.ts) changes what happens to mail that arrives
 * AFTER it; the tray still holds everything that came before - for KSDC, a fortnight of
 * software marketing and the mail provider's notices. This sets those aside in one go, as
 * ingest would have on arrival, so the officer is not left to do it card by card.
 *
 * What it touches, and what it never does:
 *   - only messages still waiting in the tray (unfiled). Never one on a case, and never one
 *     already set aside - that one has its own reason, the officer's or the register's;
 *   - only messages whose envelope sender - who sent it to the intake mailbox, not the
 *     complainant inside a forward - is not on the list. A listed sender's mail stays,
 *     confirmed or not: whether old mail was signed is not worth guessing at now;
 *   - only messages the rule has never been applied to (sender_check NULL). One that has -
 *     set aside on arrival, or by an earlier run of this - and is waiting in the tray all
 *     the same is there because the officer put it back. "Put back" leaves no other trace
 *     (restore() clears the reason), so without this a second run, or a run after the rule
 *     had been on a while, would set aside again a complaint the officer had rescued;
 *   - never a "could not be read automatically" card (recordUnreadable): it is the only
 *     trace of a message that failed to arrive properly, which may have been a complaint,
 *     and its sender was never checked. Those are counted separately, and left;
 *   - each is set aside WITH a reason, the one ingest gives plus "(set aside when the rule
 *     was switched on)", so the "Set aside" list says why, and "Put back" works as on any
 *     other.
 *
 * What it sets aside it marks sender_check 'not_allowed', as ingest marks mail it turns
 * away: the column says the rule has been applied to this message, on arrival or here.
 * restore() leaves it alone, which is what makes this safe to run again.
 *
 * Plain SQL rather than dismiss(), deliberately: dismiss() tells the mail assistant that the
 * officer set the message aside, and its agreement figures would then count a sweep of
 * marketing mail as the officer's own decisions.
 *
 * Dry run unless `confirm`: the same query, the same counts, nothing written.
 */

/** Added to the reason, so the "Set aside" list tells these from mail set aside on arrival. */
export const SWITCHED_ON_SUFFIX = '(set aside when the rule was switched on)';

export interface SenderRuleOutcome {
  /** The council's list, as configured. Empty: there is no rule, and nothing was looked at. */
  listed: string[];
  /** Waiting messages from other addresses, by address, most first. Addresses only. */
  bySender: Array<{ sender: string; messages: number }>;
  total: number;
  /** "Could not be read" cards from other addresses, left in the tray on purpose. */
  unreadable: number;
  /** True when they were set aside; false on a dry run, or when there was nothing to do. */
  applied: boolean;
}

export async function applySenderRule(
  tx: Tx,
  ctx: EngineContext,
  opts: { confirm: boolean },
): Promise<SenderRuleOutcome> {
  const listed = (ctx.config.intakeSenders ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (listed.length === 0) return { listed, bySender: [], total: 0, unreadable: 0, applied: false };

  // Waiting, from an unlisted sender, and never looked at by the rule. Shared by the counts
  // and the update, so the dry run says exactly what --confirm would do.
  const candidates = sql`
    council_id = ${ctx.councilId}::uuid AND status = 'unfiled' AND sender_check IS NULL
      AND NOT (lower(envelope_from) = ANY(${pgTextArray(listed)}::text[]))
  `;
  const notUnreadable = sql`snippet IS DISTINCT FROM ${UNREADABLE_SNIPPET}`;

  const waiting = await tx.execute<{ sender: string; messages: number }>(sql`
    SELECT lower(envelope_from) AS sender, count(*)::int AS messages
    FROM mail_message
    WHERE ${candidates} AND ${notUnreadable}
    GROUP BY lower(envelope_from)
    ORDER BY count(*) DESC, lower(envelope_from)
  `);
  const unreadableRows = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM mail_message
    WHERE ${candidates} AND snippet = ${UNREADABLE_SNIPPET}
  `);
  const unreadable = unreadableRows.rows[0]?.n ?? 0;
  const bySender = waiting.rows;
  const total = bySender.reduce((n, r) => n + r.messages, 0);
  if (!opts.confirm || total === 0) return { listed, bySender, total, unreadable, applied: false };

  await tx.execute(sql`
    UPDATE mail_message
    SET status = 'dismissed', dismissed_at = now(), dismissed_by = ${ctx.userId ?? null},
        dismissed_reason = ${`${notFromListedReason(listed)} ${SWITCHED_ON_SUFFIX}`},
        sender_check = 'not_allowed'
    WHERE ${candidates} AND ${notUnreadable}
  `);
  return { listed, bySender, total, unreadable, applied: true };
}
