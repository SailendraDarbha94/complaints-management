import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/**
 * The two offices the Act names.
 *
 * The First Appellate Authority's particulars are one of the three things s.7(8) requires
 * on a refusal, so until somebody records who holds the office every refusal this council
 * issues is defective on its face. The Act also requires the appellate authority to be an
 * officer senior in rank to the Public Information Officer (s.19(1)), so the two cannot be
 * the same person - which is why this is a decision to be taken with the Registrar rather
 * than a default chosen here.
 */
export const GET = withAuth(async ({ tx, ctx, services }) => {
  const today = new Date().toISOString().slice(0, 10);
  return services.rti.officeHolders(tx, ctx, today);
});

const officerSchema = z.object({
  office: z.enum(['pio', 'firstAppellateAuthority']),
  fullName: z.string().trim().min(1, 'A name.'),
  designation: z.string().trim().nullish(),
  startsOn: ISO_DATE,
});

export const POST = withAuth(async ({ req, tx, ctx, services }) => {
  const body = officerSchema.parse(await jsonBody(req));
  await services.rti.recordOfficeHolder(tx, ctx, body);
  return { recorded: true };
});
