import { NextResponse, type NextRequest } from 'next/server';
import type { Role } from '@ksdc/contracts';
import {
  DomainError,
  ForbiddenError,
  getServices,
  inCouncilScope,
  toErrorResponse,
  UnauthorizedError,
  type EngineContext,
  type RequestIdentity,
  type Services,
} from '@ksdc/core';
import type { Tx } from '@ksdc/db';
import { identityFromRequest } from './auth-adapter';

/**
 * Every route handler is built here, and nowhere else.
 *
 * NestJS registered one global guard, so an endpoint was authenticated unless it said
 * otherwise. The App Router has no such hook: a route.ts is reachable the moment the file
 * exists. That inverts the default from closed to open, which on a legal register is the
 * difference between a bug report and a disclosure.
 *
 * So the default is bought back two ways. First, a handler only becomes a route by passing
 * through withAuth() or withPublic() - there is no third way to write one. Second, a test
 * walks app/v1 and fails if any route.ts exports a handler that did not come from one of
 * them, and a second test calls all of them unauthenticated and demands a 401. Forgetting
 * is therefore a red build rather than an open endpoint.
 *
 * withPublic() is deliberately noisy to type and requires a stated reason, because every
 * use of it is a decision someone should be able to audit in one grep.
 *
 * Signed in is not enough, either. The website is the dental officer's: committee members
 * and auditors read cases in the phone app, which reads Supabase directly under the grants
 * in migration 0010 - and those grants leave out the officer's chase list, the letters and
 * drafts, the notes and the complainant's phone number. Every route here answers with
 * that, and writes with it, as a database role that may write anything. So withAuth()
 * refuses every role but 'officer' before the handler runs, and a route that a member
 * genuinely needs (seeing who they are signed in as) says so with `roles`. routes.test.ts
 * lists each of those with its reason, so a new route is officer-only unless someone
 * decides otherwise in a reviewed diff.
 */

/** What a handler is given. The transaction and council scope are already open. */
export interface RouteContext<P = Record<string, string>> {
  req: NextRequest;
  params: P;
  tx: Tx;
  ctx: EngineContext;
  identity: RequestIdentity;
  services: Services;
}

export interface PublicRouteContext<P = Record<string, string>> {
  req: NextRequest;
  params: P;
  services: Services;
}

type Returned = Response | NextResponse | unknown;
type NextRouteHandler<P> = (
  req: NextRequest,
  segment: { params: Promise<P> },
) => Promise<Response>;

/** Marks a function as having been through a wrapper. The default-closed test reads it. */
const GUARDED = Symbol.for('ksdc.route.guarded');

export type GuardedHandler<P> = NextRouteHandler<P> & {
  [GUARDED]: 'auth' | 'public';
  publicReason?: string;
  /** Who may call an authenticated endpoint. Absent on a public one. */
  roles?: readonly Role[];
};

export function isGuarded(fn: unknown): fn is GuardedHandler<unknown> {
  return typeof fn === 'function' && GUARDED in (fn as object);
}

export function guardKind(fn: unknown): 'auth' | 'public' | null {
  return isGuarded(fn) ? (fn as GuardedHandler<unknown>)[GUARDED] : null;
}

/** The roles an authenticated endpoint lets through; null for a public or unguarded one. */
export function allowedRoles(fn: unknown): readonly Role[] | null {
  return guardKind(fn) === 'auth' ? ((fn as GuardedHandler<unknown>).roles ?? null) : null;
}

/** What a committee member or an auditor is told when they reach the officer's website. */
export const OFFICER_ONLY_MESSAGE =
  "Only the Council's dental officer can use this. Committee members read cases in the KSDC phone app.";

export interface AuthOptions {
  /**
   * Who may call this. Leave it out and it is the officer alone, which is right for every
   * route that reads or changes the register. Name other roles only for what a member
   * needs on the website at all - seeing who they are signed in as - and add the route,
   * with the reason, to the allow-list in routes.test.ts, or the build fails.
   */
  roles?: readonly Role[];
}

const OFFICER_ONLY: readonly Role[] = ['officer'];

/**
 * Refuse a role this endpoint does not admit, before anything is opened.
 *
 * Checked on the token's role before the council scope, so a refused caller costs no
 * transaction and reaches no service. A denial within the council is a 403; a case in
 * another council still answers 404 from row-level security, as it always has, because
 * that check is the handler's and a refused caller never gets that far.
 */
function assertRole(identity: RequestIdentity, roles: readonly Role[]): void {
  if (!roles.includes(identity.role)) throw new ForbiddenError(OFFICER_ONLY_MESSAGE);
}

/**
 * An authenticated endpoint.
 *
 * Resolves the caller, opens ONE transaction with app.council_id set for its whole span,
 * and hands the handler the transaction and the council context. Nothing reaches the
 * database outside that scope, which is what makes row-level security the enforcement
 * point rather than a convention.
 *
 * The transaction spans the handler, so a handler that does three writes either does all
 * three or none. Returning a Response from inside it is fine - the body is serialised
 * after the transaction commits.
 *
 * Officer only unless `options.roles` says otherwise (see AuthOptions).
 */
export function withAuth<P = Record<string, string>>(
  handler: (c: RouteContext<P>) => Promise<Returned>,
  options: AuthOptions = {},
): GuardedHandler<P> {
  const roles = options.roles ?? OFFICER_ONLY;
  const wrapped = async (req: NextRequest, segment: { params: Promise<P> }) => {
    try {
      const services = await getServices();
      const identity = await identityFromRequest(req, services);
      assertRole(identity, roles);
      const params = (await segment?.params) ?? ({} as P);

      const result = await inCouncilScope(identity, requestId(req), async (tx, ctx) =>
        handler({ req, params, tx, ctx, identity, services }),
      );
      return respond(result);
    } catch (err) {
      return fail(err);
    }
  };
  return Object.assign(wrapped, { [GUARDED]: 'auth' as const, roles });
}

/** What a handler outside a transaction is given: the caller and council, but no `tx`. */
export interface UnscopedRouteContext<P = Record<string, string>> {
  req: NextRequest;
  params: P;
  ctx: EngineContext;
  identity: RequestIdentity;
  services: Services;
}

/**
 * An authenticated endpoint that waits on something slow OUTSIDE the database.
 *
 * withAuth() holds one transaction open for the whole handler, which is right for nearly
 * everything and wrong for exactly one shape of request: one that spends most of its time
 * waiting on another service. Asking the mail assistant again is a model call of many
 * seconds, and inside withAuth it would pin a pooled connection idle-in-transaction for
 * all of them - with a pool of ten, a handful of impatient clicks would starve every
 * other request in the app.
 *
 * So this authenticates exactly as withAuth() does - the same identity, the same
 * membership check, the same council configuration, in a scope that closes BEFORE the
 * handler runs - and then hands over the context with no transaction. Whatever the
 * handler does to the database it must do in scopes of its own (withCouncil), and short
 * ones. Use withAuth() unless that is the whole point. Officer only, on the same terms.
 */
export function withAuthNoTransaction<P = Record<string, string>>(
  handler: (c: UnscopedRouteContext<P>) => Promise<Returned>,
  options: AuthOptions = {},
): GuardedHandler<P> {
  const roles = options.roles ?? OFFICER_ONLY;
  const wrapped = async (req: NextRequest, segment: { params: Promise<P> }) => {
    try {
      const services = await getServices();
      const identity = await identityFromRequest(req, services);
      assertRole(identity, roles);
      const params = (await segment?.params) ?? ({} as P);

      // Membership checked and configuration loaded, then the scope is closed.
      const ctx = await inCouncilScope(identity, requestId(req), async (_tx, ctx) => ctx);
      return respond(await handler({ req, params, ctx, identity, services }));
    } catch (err) {
      return fail(err);
    }
  };
  return Object.assign(wrapped, { [GUARDED]: 'auth' as const, roles });
}

/**
 * An endpoint that is reachable without a session.
 *
 * `reason` is mandatory and is not decoration: it is what someone reviewing the six public
 * endpoints reads to decide whether each is still justified. A signed URL carrying its own
 * authority, or a sign-in endpoint that by definition has no session yet, are the only
 * shapes that belong here.
 *
 * No transaction and no council scope are opened: a public handler has no council, so any
 * database work it does must open its own scope explicitly and say which council it is
 * acting for.
 */
export function withPublic<P = Record<string, string>>(
  reason: string,
  handler: (c: PublicRouteContext<P>) => Promise<Returned>,
): GuardedHandler<P> {
  if (!reason || reason.length < 20) {
    throw new Error('withPublic() needs a real reason - it is read during review.');
  }
  const wrapped = async (req: NextRequest, segment: { params: Promise<P> }) => {
    try {
      const services = await getServices();
      const params = (await segment?.params) ?? ({} as P);
      return respond(await handler({ req, params, services }));
    } catch (err) {
      return fail(err);
    }
  };
  return Object.assign(wrapped, { [GUARDED]: 'public' as const, publicReason: reason });
}

// ─── Helpers handlers use ────────────────────────────────────────────────────

/**
 * Parse a JSON body, tolerating an empty one (several endpoints take no fields).
 *
 * A body that is not JSON is the caller's mistake, so it must answer 400. Left alone,
 * JSON.parse throws a SyntaxError, which is not a DomainError and therefore becomes a 500
 * with "something went wrong at our end" - blaming the server for a malformed request and
 * burying a real fault in the same noise. Fastify's parser used to answer 400 here; this
 * restores that.
 */
export async function jsonBody(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('That request body is not valid JSON.');
  }
}

/**
 * The caller's address, for the sign-in rate limit.
 *
 * Behind Cloud Run the immediate peer is the load balancer, so the client is the first
 * entry of X-Forwarded-For. That header is caller-settable when nothing strips it, so it
 * is only ever used for rate limiting and logging, never for authorisation.
 */
export function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip');
}

function requestId(req: NextRequest): string {
  // The audit trigger casts app.request_id to uuid, so this must be one or the insert
  // fails. Cloud Run's trace header is not a UUID, hence a fresh one per request.
  return req.headers.get('x-request-id')?.match(/^[0-9a-f-]{36}$/i)
    ? req.headers.get('x-request-id')!
    : crypto.randomUUID();
}

function respond(result: Returned): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new NextResponse(null, { status: 204 });
  return NextResponse.json(result);
}

function fail(err: unknown): Response {
  const { status, body } = toErrorResponse(err);
  return NextResponse.json(body, { status });
}

export { UnauthorizedError };
