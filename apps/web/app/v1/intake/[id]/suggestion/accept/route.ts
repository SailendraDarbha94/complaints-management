import { z } from 'zod';
import { ForbiddenError } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Accept the mail assistant's suggestion for a message - as it stands, or with changes.
 *
 * This is where a suggestion becomes a change to the register, and it is a person pressing
 * a button. It is carried out by the same services as the ordinary buttons (open a case
 * and name the dentists, add to a case, set aside), inside this request's one transaction,
 * so it all happens or none of it does.
 *
 * Every override is optional; anything left out keeps the suggestion's value. Changing
 * anything at all records the outcome as 'edited' rather than 'accepted'.
 */
const respondent = z.object({
  name: z.string().trim().min(1, 'Each dentist needs a name. It goes on the notice.').max(200),
  registrationNo: z.string().trim().max(50).nullable(),
  clinicName: z.string().trim().max(200).nullable(),
  isEstablishment: z.boolean(),
  partyId: z.string().uuid().nullable(),
  registeredDentistId: z.string().uuid().nullable(),
});

const schema = z.object({
  overrides: z
    .object({
      summary: z.string().trim().min(1, 'A one-line summary is needed to open a case.').max(500).optional(),
      complainantName: z.string().trim().min(1).max(200).optional(),
      // Empty clears it, like null: a complainant who wrote from a borrowed address may
      // have none of their own, and the officer must be able to say so.
      complainantEmail: z
        .string()
        .trim()
        .max(320)
        .refine((s) => s === '' || z.string().email().safeParse(s).success, 'That is not an email address.')
        .nullable()
        .optional(),
      respondents: z.array(respondent).max(10).optional(),
      caseFileId: z.string().uuid().optional(),
      reason: z.string().trim().min(3, 'Say why this is not a complaint.').max(1000).optional(),
    })
    .optional(),
});

export const POST = withAuth<{ id: string }>(
  async ({ req, params, tx, ctx, identity, services }) => {
    // Officer only, here rather than left to the screens: accepting opens numbered cases
    // and names dentists, and a committee member is read-only everywhere.
    if (identity.role !== 'officer') {
      throw new ForbiddenError('Only the dental officer can act on a suggestion.');
    }
    const body = schema.parse(await jsonBody(req));
    return services.assistant.accept(tx, ctx, params.id, body.overrides ?? {});
  },
);
