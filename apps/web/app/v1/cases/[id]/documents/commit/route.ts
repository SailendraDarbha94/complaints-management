import { z } from 'zod';
import { DOCUMENT_CLASSES } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const commitSchema = z.object({
  storageKey: z.string().min(1),
  title: z.string().min(1),
  originalFilename: z.string().min(1),
  documentClass: z.enum(DOCUMENT_CLASSES).optional(),
  physicalOriginalHeld: z.boolean().optional(),
  documentId: z.string().uuid().optional(),
});

/** Step two: check what actually landed, then file it. */
export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const input = commitSchema.parse(await jsonBody(req));
  return services.documents.commit(tx, ctx, { caseFileId: params.id, ...input });
});
