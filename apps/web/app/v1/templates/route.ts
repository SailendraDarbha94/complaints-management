import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CORRESPONDENCE_KINDS, fieldsFor } from '@ksdc/contracts';
import type { CorrespondenceKind } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const publishSchema = z.object({
  kind: z.enum(CORRESPONDENCE_KINDS),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const GET = withAuth(async ({ tx }) => {
  const rows = await tx.execute<{
    kind: CorrespondenceKind;
    name: string;
    is_system: boolean;
    requires_registrar_signature: boolean;
    version_no: number;
    subject_tpl: string;
    body: string;
    published_at: Date;
  }>(sql`
    SELECT t.kind, t.name, t.is_system, t.requires_registrar_signature,
           v.version_no, v.subject_tpl, v.body, v.published_at
    FROM template t
    JOIN template_version v ON v.id = t.current_version_id
    ORDER BY t.kind
  `);
  return {
    templates: rows.rows.map((r) => ({ ...r, availableFields: fieldsFor(r.kind) })),
  };
});

export const POST = withAuth(async ({ req, tx, ctx, services }) => {
  const input = publishSchema.parse(await jsonBody(req));
  return services.correspondence.publishTemplate(tx, ctx, input);
});
