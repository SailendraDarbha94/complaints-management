import type { CaseEvent } from '@ksdc/contracts';
import type { Services } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ApplyEventInput is not on the package's public index, so the body's shape is read off
 * the service rather than restated here - a second copy would drift from the engine.
 */
type ApplyEventBody = Omit<Parameters<Services['lifecycle']['apply']>[2], 'caseFileId' | 'event'>;

export const POST = withAuth<{ id: string; event: string }>(
  async ({ req, params, tx, ctx, services }) => {
    const body = (await jsonBody(req)) as ApplyEventBody;
    return services.lifecycle.apply(tx, ctx, {
      ...body,
      caseFileId: params.id,
      event: params.event as CaseEvent,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
      notice: body.notice ? { ...body.notice, sentAt: new Date(body.notice.sentAt) } : undefined,
    });
  },
);
