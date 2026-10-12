import { z } from 'zod';
import { ForbiddenError } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * File a message onto a case that already exists. Attachments go on with it.
 *
 * `asReceived`: the officer's word that a message the register took for a copy of the
 * Council's own letter is not one, so it is filed as a letter received (see
 * MailIntakeService.fileOnCase).
 *
 * Officer only, as the council-copy route is: filing mail on a case closes the reminders a
 * reply answers, files a copy of the Council's letter (which can close off a draft as
 * sent), and with asReceived overrides the register's own reading - and a committee member
 * is read-only everywhere.
 */
const schema = z.object({ caseFileId: z.string().uuid(), asReceived: z.boolean().optional() });

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, identity, services }) => {
  if (identity.role !== 'officer') {
    throw new ForbiddenError('Only the dental officer can file mail on a case.');
  }
  const { caseFileId, asReceived } = schema.parse(await jsonBody(req));
  return services.mail.fileOnCase(tx, ctx, { mailMessageId: params.id, caseFileId, asReceived });
});
