import { Logger } from './common/logger.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SupabaseAuthService } from './modules/auth/supabase-auth.service.js';
import { TokenService } from './modules/auth/token.service.js';
import { CaseIntakeService } from './modules/cases/case-intake.service.js';
import { CaseLifecycleService } from './modules/cases/case-lifecycle.service.js';
import { CorrespondenceService } from './modules/correspondence/correspondence.service.js';
import { DocumentsService } from './modules/documents/documents.service.js';
import { FollowupService } from './modules/followups/followup.service.js';
import { QueueService } from './modules/followups/queue.service.js';
import { DigestService } from './modules/notifications/digest.service.js';
import { SchedulerService } from './modules/jobs/scheduler.service.js';
import { RegisterService } from './modules/register/register.service.js';
import { RtiService } from './modules/rti/rti.service.js';
import { ConsoleMailer, MailerPort, SmtpMailer } from './modules/notifications/mailer.js';
import { GcsStorage, LocalStorage, StoragePort } from './modules/documents/storage.js';
import { SupabaseStorage } from './modules/documents/supabase-storage.js';

/**
 * Where the services are assembled.
 *
 * This replaces Nest's dependency-injection container, and it is deliberately a plain
 * object built once per process rather than a framework. Every service here takes its
 * collaborators as constructor arguments and every method takes (tx, ctx, args) - so the
 * tests go on constructing exactly what they need by hand, which is why none of them had
 * to change when NestJS came out.
 *
 * There is no interface to register against and no decorator to forget. The cost of the
 * container was a wiring file that had to be edited every time a constructor changed; the
 * cost of this is the same file, twenty lines shorter, that TypeScript checks.
 */

export interface Services {
  tokens: TokenService;
  auth: AuthService;
  /** Only used when AUTH_DRIVER=supabase. Cheap to construct either way. */
  supabaseAuth: SupabaseAuthService;
  followups: FollowupService;
  queue: QueueService;
  digest: DigestService;
  scheduler: SchedulerService;
  intake: CaseIntakeService;
  lifecycle: CaseLifecycleService;
  correspondence: CorrespondenceService;
  documents: DocumentsService;
  register: RegisterService;
  rti: RtiService;
  mailer: MailerPort;
  storage: StoragePort;
}

/**
 * Which mailer. In development this writes to the log and to var/mail/outbox.log, so a
 * sign-in code needs no mail server; main.ts refuses to start in production unless this
 * is 'smtp', because otherwise the codes go to a file and nobody can get in.
 */
export function createMailer(): MailerPort {
  return process.env.MAIL_TRANSPORT === 'smtp' ? new SmtpMailer() : new ConsoleMailer();
}

/**
 * Which storage. 'local' writes under var/documents and signs its own URLs so the whole
 * upload flow works on a laptop with no cloud account at all.
 *
 * All three adapters implement the same five-method port, so nothing above this line
 * knows or cares which one is running.
 */
export function createStorage(): StoragePort {
  switch (process.env.STORAGE_DRIVER) {
    case 'supabase':
      return new SupabaseStorage();
    case 'gcs':
      return new GcsStorage();
    default:
      return new LocalStorage();
  }
}

/**
 * Built once per process and reused.
 *
 * Next.js re-evaluates server modules on every change in development, so this is cached on
 * globalThis rather than in a module-scoped variable: a module-scoped singleton is rebuilt
 * on each hot reload, and the token service would then sign with a key the previous
 * instance's tokens cannot be verified against.
 */
const CACHE_KEY = Symbol.for('ksdc.services');

interface Global {
  [CACHE_KEY]?: Services;
}

export async function getServices(): Promise<Services> {
  const g = globalThis as unknown as Global;
  if (g[CACHE_KEY]) return g[CACHE_KEY];

  const mailer = createMailer();
  const storage = createStorage();

  const tokens = new TokenService();
  const followups = new FollowupService();
  const queue = new QueueService();
  const lifecycle = new CaseLifecycleService(followups);
  const digest = new DigestService(queue, mailer);

  const services: Services = {
    tokens,
    auth: new AuthService(tokens, mailer),
    supabaseAuth: new SupabaseAuthService(),
    followups,
    queue,
    digest,
    scheduler: new SchedulerService(followups, digest),
    intake: new CaseIntakeService(followups),
    lifecycle,
    correspondence: new CorrespondenceService(lifecycle, followups),
    documents: new DocumentsService(storage),
    register: new RegisterService(),
    rti: new RtiService(),
    mailer,
    storage,
  };

  g[CACHE_KEY] = services;
  return services;
}

/**
 * Refuse to start misconfigured.
 *
 * This used to live in main.ts, which no longer exists. Route handlers have no startup
 * hook, so it is called once from the services factory's first use and from the scripts.
 */
export function assertProductionConfig(): void {
  const log = new Logger('config');

  if (process.env.NODE_ENV !== 'production') {
    log.warn(
      'Development mode: sign-in codes are written to the log and var/mail/outbox.log ' +
        'instead of being emailed.',
    );
    return;
  }

  for (const required of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'DATABASE_URL']) {
    if (!process.env[required]) throw new Error(`${required} must be set in production`);
  }
  // Otherwise sign-in codes go to a log file and nobody can get in.
  if (process.env.MAIL_TRANSPORT !== 'smtp') {
    throw new Error('MAIL_TRANSPORT must be "smtp" in production');
  }
}
