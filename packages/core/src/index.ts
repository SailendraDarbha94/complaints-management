/**
 * @ksdc/core — the complaints register, without a web framework.
 *
 * Everything here takes a transaction and a council context and returns data. It does not
 * know what an HTTP request is. That is deliberate: the same services are called from the
 * Next.js route handlers in apps/web, from the scheduled job, and directly from 269 tests
 * that construct them by hand.
 *
 * This package was apps/api until the NestJS layer came out. The services did not change,
 * because they never depended on it.
 */

// The container.
export {
  getServices,
  createMailer,
  createStorage,
  assertProductionConfig,
  type Services,
} from './services.js';

// Council scoping. Every database path goes through inCouncilScope.
export {
  inCouncilScope,
  isProduction,
  loadConfig,
  clearConfigCache,
  type RequestIdentity,
} from './context/council-context.js';

// Errors, and the one place that maps them onto a response.
export {
  DomainError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  isDomainError,
  toErrorResponse,
  type ErrorResponse,
} from './common/domain-error.js';

export { Logger } from './common/logger.js';
export {
  isWorkingDay,
  addWorkingDays,
  addCalendarDays,
  addDaysByBasis,
  daysBetween,
  daysOverdue,
  isBefore,
  todayIn,
  assertIsoDate,
  type Calendar,
  type IsoDate,
} from './common/working-days.js';

// Sessions.
export {
  identityFromToken,
  tokenFrom,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from './modules/auth/session.js';
export { AuthService } from './modules/auth/auth.service.js';
export {
  identityFromSupabaseToken,
  resetSupabaseKeyCache,
} from './modules/auth/supabase-jwt.js';
export {
  SupabaseAuthService,
  type SupabaseSession,
} from './modules/auth/supabase-auth.service.js';
export { TokenService, generateSigningKeys, type AccessClaims } from './modules/auth/token.service.js';

// The domain.
export { CaseIntakeService, type IntakeInput } from './modules/cases/case-intake.service.js';
export { CaseLifecycleService } from './modules/cases/case-lifecycle.service.js';
export { FollowupService, type EngineContext } from './modules/followups/followup.service.js';
export { QueueService } from './modules/followups/queue.service.js';
export { CorrespondenceService } from './modules/correspondence/correspondence.service.js';
export { DocumentsService } from './modules/documents/documents.service.js';
export { RegisterService } from './modules/register/register.service.js';

// RTI: its own register, its own clock, its own composer. See modules/rti.
export {
  RtiService,
  type ReceiveRtiInput,
  type RtiRequestRow,
  type RtiExemptionRow,
  type RtiFile,
} from './modules/rti/rti.service.js';
export {
  rtiClock,
  predictDueOn,
  statutoryPeriodDays,
  type RtiClock,
} from './modules/rti/rti-clock.js';
export {
  composeRtiReply,
  type RtiReplyDraft,
  type RtiOfficeHolder,
} from './modules/rti/rti-reply.js';
export { DigestService } from './modules/notifications/digest.service.js';
export { SchedulerService } from './modules/jobs/scheduler.service.js';
export { MailerPort, ConsoleMailer, SmtpMailer } from './modules/notifications/mailer.js';

// Storage: the port, its adapters, and the rules about what may be stored.
export {
  StoragePort,
  LocalStorage,
  GcsStorage,
  UnsupportedFileError,
  sniff,
  MAX_UPLOAD_BYTES,
  STAGING_PREFIX,
  DOCUMENTS_PREFIX,
  QUARANTINE_PREFIX,
  type SignedUpload,
  type SignedDownload,
  type SniffResult,
} from './modules/documents/storage.js';
