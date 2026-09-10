import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { inCouncilScope } from '../../context/council-context.js';
import { requireIdentity } from '../auth/auth.guard.js';
import { FollowupService } from './followup.service.js';
import { QueueService } from './queue.service.js';

/** The Today screen's API. One endpoint the officer's morning depends on. */
@Controller()
export class QueueController {
  constructor(
    private readonly queue: QueueService,
    private readonly followups: FollowupService,
  ) {}

  @Get('queue')
  async today(@Req() req: FastifyRequest) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      const today = this.followups.today(ctx.config);
      const [queue, ticker] = await Promise.all([
        this.queue.today(tx, ctx, today),
        this.queue.tickerHealth(tx),
      ]);
      // The banner ships with the queue, not on a separate call: a dead ticker is the
      // one thing the officer must never have to go looking for.
      return { ...queue, ticker };
    });
  }

  @Post('followups/:id/snooze')
  async snooze(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { until: string },
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      await this.followups.snooze(tx, ctx, { followUpId: id, until: body.until });
      return { ok: true };
    });
  }

  @Post('followups/:id/done')
  async done(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { note?: string; contactEventId?: string },
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      await this.followups.satisfy(tx, ctx, {
        followUpId: id,
        contactEventId: body.contactEventId ?? null,
        note: body.note ?? null,
      });
      return { ok: true };
    });
  }

  @Post('followups/:id/dismiss')
  async dismiss(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      // The reason is mandatory in the service; the API does not offer a way round it.
      await this.followups.dismiss(tx, ctx, { followUpId: id, reason: body.reason });
      return { ok: true };
    });
  }
}
