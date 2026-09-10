import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthService } from './modules/auth/auth.service.js';
import { TokenService } from './modules/auth/token.service.js';
import { CasesController } from './modules/cases/cases.controller.js';
import { QueueController } from './modules/followups/queue.controller.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { CaseIntakeService } from './modules/cases/case-intake.service.js';
import { CaseLifecycleService } from './modules/cases/case-lifecycle.service.js';
import { FollowupService } from './modules/followups/followup.service.js';
import { QueueService } from './modules/followups/queue.service.js';
import { DigestService } from './modules/notifications/digest.service.js';
import { mailerProvider } from './modules/notifications/mailer.js';
import { SchedulerService } from './modules/jobs/scheduler.service.js';

/**
 * One module. Splitting a small application into a module per folder buys nothing and
 * costs a wiring file every time something moves.
 */
@Module({
  controllers: [AuthController, QueueController, CasesController, JobsController],
  providers: [
    // Every route is authenticated unless it declares @Public(). Defaulting to closed
    // means an endpoint added and forgotten in six months is unreachable, not open.
    { provide: APP_GUARD, useClass: AuthGuard },
    TokenService,
    AuthService,
    mailerProvider(),
    FollowupService,
    QueueService,
    DigestService,
    SchedulerService,
    {
      provide: CaseIntakeService,
      useFactory: (f: FollowupService) => new CaseIntakeService(f),
      inject: [FollowupService],
    },
    {
      provide: CaseLifecycleService,
      useFactory: (f: FollowupService) => new CaseLifecycleService(f),
      inject: [FollowupService],
    },
  ],
})
export class AppModule {}
