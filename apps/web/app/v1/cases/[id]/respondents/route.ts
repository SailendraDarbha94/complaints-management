import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who might this dentist be?
 *
 * Searches the people the Council has named as a respondent before AND its own register of
 * dentists, so picking a suggestion is what joins a dentist's cases into one history.
 */
export const GET = withAuth<{ id: string }>(async ({ req, tx, ctx, services }) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return { candidates: await services.respondents.search(tx, ctx, q) };
});

/**
 * Name a dentist on the case.
 *
 * Either `partyId` — the officer picked somebody the register already knows, joining the
 * history up — or the details of a new person. Never both, and never a silent merge on a
 * name: two dentists share a name, and one person's notice history in front of a committee
 * deciding about another is the mistake this refuses to make.
 */
const schema = z.union([
  z.object({
    partyId: z.string().uuid(),
    note: z.string().trim().nullish(),
  }),
  z.object({
    fullName: z.string().trim().min(1, 'The dentist’s name. It goes on the notice.'),
    registrationNo: z.string().trim().nullish(),
    clinicName: z.string().trim().nullish(),
    email: z.string().email('That is not an email address.').nullish().or(z.literal('')),
    mobile: z.string().trim().max(32).nullish(),
    isEstablishment: z.boolean().optional(),
    note: z.string().trim().nullish(),
  }),
]);

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = schema.parse(await jsonBody(req));
  return services.respondents.add(tx, ctx, {
    caseFileId: params.id,
    ...body,
    ...('email' in body ? { email: body.email || null } : {}),
  });
});
