import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One message: what arrived, what was unwrapped from it, and which cases it might belong to.
 *
 * Also the mail assistant's latest suggestion for it, and whether the assistant is on at
 * all - for THIS council, whose own AI switch counts as much as the environment's - with
 * the reason when it is not, so the page can say "switched off: ..." rather than offering
 * a button that will only refuse.
 */
export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  const assistant = services.assistant.status(ctx);
  const found = await services.mail.get(tx, ctx, params.id);
  if (!found) return { message: null, suggestion: null, assistant };
  const suggestions = await services.assistant.latestFor(tx, ctx, [params.id]);
  return { ...found, suggestion: suggestions.get(params.id) ?? null, assistant };
});
