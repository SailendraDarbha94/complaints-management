import { z } from 'zod';
import { DATE_SOURCES, RTI_CHANNELS } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The RTI register.
 *
 * Every application, newest first, each with its clock worked out. Separate from /v1/cases
 * because an RTI application is not a case: different statute, different deadline,
 * different appeal route, and a penalty that lands on a named officer rather than on the
 * council.
 */
export const GET = withAuth(async ({ tx, ctx, services }) => {
  const rows = await services.rti.list(tx, ctx);
  return { requests: rows };
});

/**
 * Logging an application. This endpoint starts a statutory clock, so every field the
 * service accepts is declared here: a malformed body must be refused with a message that
 * names the field, never with a 500 and a date nobody can explain afterwards.
 */
const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

const receiveSchema = z.object({
  receivedOn: ISO_DATE,
  receivedVia: z.enum(RTI_CHANNELS),
  applicantName: z.string().trim().min(1, 'The applicant’s name.'),
  applicantAddressLines: z.array(z.string()).optional(),
  applicantEmail: z.string().email().nullish(),
  applicantPhone: z.string().trim().max(32).nullish(),
  // No `reason` field, and there never may be one: s.6(2) forbids asking an applicant why
  // they want the information.
  requestText: z.string().trim().min(1, 'What was asked for, in the applicant’s own words.'),
  externalRefNo: z.string().trim().nullish(),
  applicationFeeReceived: z.boolean().optional(),
  isBpl: z.boolean().optional(),
  lifeOrLiberty: z.boolean().optional(),
  lifeOrLibertyReason: z.string().trim().nullish(),
  dateSource: z.enum(DATE_SOURCES).optional(),
  caseFileIds: z.array(z.string().uuid()).optional(),
});

export const POST = withAuth(async ({ req, tx, ctx, services }) => {
  const input = receiveSchema.parse(await jsonBody(req));
  return services.rti.receive(tx, ctx, input);
});
