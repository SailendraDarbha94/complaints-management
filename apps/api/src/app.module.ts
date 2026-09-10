import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthService } from './modules/auth/auth.service.js';
import { TokenService } from './modules/auth/token.service.js';
import { CasesController } from './modules/cases/cases.controller.js';
import { QueueController } from './modules/followups/queue.controller.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { DocumentsController } from './modules/documents/documents.controller.js';
import { StorageController } from './modules/documents/storage.controller.js';
import { CorrespondenceController } from './modules/correspondence/correspondence.controller.js';
import { RegisterController } from './modules/register/register.controller.js';
import { CaseIntakeService } from './modules/cases/case-intake.service.js';
import { CaseLifecycleService } from './modules/cases/case-lifecycle.service.js';
import { CorrespondenceService } from './modules/correspondence/correspondence.service.js';
import { DocumentsService } from './modules/documents/documents.service.js';
import { RegisterService } from './modules/register/register.service.js';
import { FollowupService } from './modules/followups/followup.service.js';
import { QueueService } from './modules/followups/queue.service.js';
import { DigestService } from './modules/notifications/digest.service.js';
import { mailerProvider } from './modules/notifications/mailer.js';
import { storageProvider } from './modules/documents/storage.js';
import { SchedulerService } from './modules/jobs/scheduler.service.js';

/**
 * One module. Splitting a small application into a module per folder buys nothing and
 * costs a wiring file every time something moves.
 */
@Module({
  controllers: [
    AuthController,
    QueueController,
    CasesController,
    CorrespondenceController,
    DocumentsController,
    RegisterController,
    // Only reachable with local storage; against a real bucket the browser talks to
    // Google directly and never comes here.
    StorageController,
    JobsController,
  ],
  providers: [
    // Every route is authenticated unless it declares @Public(). Defaulting to closed
    // means an endpoint added and forgotten in six months is unreachable, not open.
    { provide: APP_GUARD, useClass: AuthGuard },
    TokenService,
    AuthService,
    mailerProvider(),
    storageProvider(),
    FollowupService,
    QueueService,
    DigestService,
    RegisterService,
    SchedulerService,
    DocumentsService,
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
    {
      provide: CorrespondenceService,
      useFactory: (l: CaseLifecycleService, f: FollowupService) =>
        new CorrespondenceService(l, f),
      inject: [CaseLifecycleService, FollowupService],
    },
  ],
})
export class AppModule {}
