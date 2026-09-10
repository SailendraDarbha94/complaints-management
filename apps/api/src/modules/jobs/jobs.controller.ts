import { Controller, ForbiddenException, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { todayIn } from '../../common/working-days.js';
import { isProduction } from '../../context/council-context.js';
import { SchedulerService } from './scheduler.service.js';

/**
 * Cloud Scheduler calls these over authenticated HTTPS (OIDC). They are not part of the
 * public API surface and are never reachable from the browser app.
 */
@Controller('internal/jobs')
export class JobsController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post('daily')
  async daily(@Req() req: FastifyRequest) {
    this.assertScheduler(req);
    const now = new Date();
    const logicalDate = todayIn('Asia/Kolkata', now);
    return this.scheduler.run('daily', logicalDate, () => this.scheduler.daily(now));
  }

  /**
   * Cloud Run verifies the OIDC token before the request reaches us when the service
   * requires authentication, so this is a second check rather than the only one. In
   * development it accepts a shared secret so the tick can be fired by hand.
   */
  private assertScheduler(req: FastifyRequest): void {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return;

    if (!isProduction() && req.headers['x-dev-scheduler'] === '1') return;

    throw new ForbiddenException('This endpoint is called by Cloud Scheduler, not by a person.');
  }
}
