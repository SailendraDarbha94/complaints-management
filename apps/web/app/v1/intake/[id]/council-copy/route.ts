import { z } from 'zod';
import { ForbiddenError, todayIn } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';
import { councilCopyBody, OUTGOING_KINDS, sentAtFrom } from '@/lib/council-copy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A copy of a letter the Council itself sent, which reached the intake mailbox.
 *
 * GET  ?caseId=  what filing it on that case would mean: whether the case already records
 *                the letter, whether the person it went to is on that case, and which of
 *                the three ways of filing it are open (see MailIntakeService.councilCopyPlan).
 * POST           file it, one of those ways (MailIntakeService.fileCouncilCopy).
 *
 * Officer only, both, said here rather than left to the screens, as the cancel route does:
 * recording a letter as sent starts a reminder or moves a dentist's notice count, and a
 * committee member is read-only everywhere.
 */

const query = z.object({
  caseId: z.string().uuid('Choose a case.'),
  // Which of the Council's letters it is, when its subject is two of them (the hearing
  // notices) and the officer has said which.
  kind: z.enum(OUTGOING_KINDS).optional(),
});

export const GET = withAuth<{ id: string }>(async ({ req, params, tx, ctx, identity, services }) => {
  if (identity.role !== 'officer') {
    throw new ForbiddenError('Only the dental officer can file mail on a case.');
  }
  const search = new URL(req.url).searchParams;
  const { caseId, kind } = query.parse({
    caseId: search.get('caseId') ?? '',
    kind: search.get('kind') || undefined,
  });
  return services.mail.councilCopyPlan(tx, ctx, { mailMessageId: params.id, caseFileId: caseId, kind });
});

export const POST = withAuth<{ id: string }>(
  async ({ req, params, tx, ctx, identity, services }) => {
    if (identity.role !== 'officer') {
      throw new ForbiddenError('Only the dental officer can file mail on a case.');
    }
    const now = new Date();
    const today = todayIn(ctx.config.calendar.timezone, now);
    const body = councilCopyBody(today, now).parse(await jsonBody(req));
    return services.mail.fileCouncilCopy(tx, ctx, {
      mailMessageId: params.id,
      caseFileId: body.caseFileId,
      mode: body.mode,
      sentAt: body.sentAt ? sentAtFrom(body.sentAt, today, now) : undefined,
      kind: body.kind,
      caseRespondentId: body.caseRespondentId ?? null,
      asCouncilCopy: body.asCouncilCopy,
    });
  },
);
