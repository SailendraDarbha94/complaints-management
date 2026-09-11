import { z } from 'zod';
import { CORRESPONDENCE_KINDS } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const draftSchema = z.object({
  kind: z.enum(CORRESPONDENCE_KINDS),
  caseRespondentId: z.string().uuid().nullish(),
});

export const POST = withAuth<{ id: string }>(
  async ({ req, params, tx, ctx, identity, services }) => {
    const input = draftSchema.parse(await jsonBody(req));
    return services.correspondence.draft(tx, ctx, {
      caseFileId: params.id,
      kind: input.kind,
      caseRespondentId: input.caseRespondentId ?? null,
      officerName: identity.name,
    });
  },
);
