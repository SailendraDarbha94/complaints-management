import { Module } from '@nestjs/common';
import { CasesController } from './modules/cases/cases.controller.js';
import { QueueController } from './modules/followups/queue.controller.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { CaseIntakeService } from './modules/cases/case-intake.service.js';
import { CaseLifecycleService } from './modules/cases/case-lifecycle.service.js';
import { FollowupService } from './modules/followups/followup.service.js';
import { QueueService } from './modules/followups/queue.service.js';
import { SchedulerService } from './modules/jobs/scheduler.service.js';

/**
 * One module in Phase 1. Splitting a five-file application into a module per folder
 * buys nothing and costs a wiring file each time something moves.
 */
@Module({
  controllers: [QueueController, CasesController, JobsController],
  providers: [
    FollowupService,
    QueueService,
    SchedulerService,
    { provide: CaseIntakeService, useFactory: (f: FollowupService) => new CaseIntakeService(f), inject: [FollowupService] },
    { provide: CaseLifecycleService, useFactory: (f: FollowupService) => new CaseLifecycleService(f), inject: [FollowupService] },
  ],
})
export class AppModule {}
