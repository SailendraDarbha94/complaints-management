import { NextResponse, type NextRequest } from 'next/server';
import {
  DomainError,
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
};

export function isGuarded(fn: unknown): fn is GuardedHandler<unknown> {
  return typeof fn === 'function' && GUARDED in (fn as object);
}

export function guardKind(fn: unknown): 'auth' | 'public' | null {
  return isGuarded(fn) ? (fn as GuardedHandler<unknown>)[GUARDED] : null;
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
 */
export function withAuth<P = Record<string, string>>(
  handler: (c: RouteContext<P>) => Promise<Returned>,
): GuardedHandler<P> {
  const wrapped = async (req: NextRequest, segment: { params: Promise<P> }) => {
    try {
      const services = await getServices();
      const identity = await identityFromRequest(req, services);
      const params = (await segment?.params) ?? ({} as P);

      const result = await inCouncilScope(identity, requestId(req), async (tx, ctx) =>
        handler({ req, params, tx, ctx, identity, services }),
      );
      return respond(result);
    } catch (err) {
      return fail(err);
    }
  };
  return Object.assign(wrapped, { [GUARDED]: 'auth' as const });
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
