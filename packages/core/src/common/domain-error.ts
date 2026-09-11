import { Logger } from './logger.js';

/**
 * An error the officer caused and can fix.
 *
 * "This letter is already recorded as sent" and "that file is not a PDF" are answers, not
 * faults. Returning them as 500 Internal Server Error tells the officer nothing, invites
 * them to try again identically, and buries a real fault in the same noise.
 *
 * Everything that is NOT a DomainError stays a 500 with a generic message, because a
 * message we did not write for a person to read may say more about the system than it
 * should.
 *
 * These carry a plain HTTP status integer and nothing else. A status code is not a reason
 * to depend on a web framework, and the core package is now framework-free precisely so
 * that the same services can be called from a route handler, a scheduled job or a test.
 */
export class DomainError extends Error {
  /**
   * A brand, checked instead of `instanceof`.
   *
   * This is not defensive programming for its own sake. The route handlers are bundled by
   * webpack, which loads this module once per bundler layer - so the DomainError the
   * service throws and the DomainError the error mapper imported can be two different
   * classes, and `instanceof` between them is false. The symptom is every officer-readable
   * refusal ("that code is not valid", "this letter is already recorded as sent") arriving
   * as a 500 with a generic message, which is exactly the failure this class exists to
   * prevent. A property survives bundling; a class identity does not.
   */
  readonly isDomainError = true as const;

  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Structural, for the reason given above. Never use `instanceof` on these. */
export function isDomainError(err: unknown): err is DomainError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isDomainError?: unknown }).isDomainError === true &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

interface ZodLike {
  name: string;
  issues: Array<{ path: Array<string | number>; message: string }>;
}

/** Same problem, same fix: apps/web and @ksdc/core can each carry their own copy of zod. */
function isZodError(err: unknown): err is ZodLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as ZodLike).name === 'ZodError' &&
    Array.isArray((err as ZodLike).issues)
  );
}

/** The officer tried to do something the case's current state does not allow. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

/**
 * Not signed in, or signed in with something we will not accept.
 *
 * Never distinguish expired from forged from malformed: the caller's answer is the same in
 * all three cases - refresh, then sign in - and the difference is only useful to someone
 * probing.
 */
export class UnauthorizedError extends DomainError {
  constructor(message = 'Not signed in.') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

/** Signed in, but not allowed to do this. */
export class ForbiddenError extends DomainError {
  constructor(message = 'Not allowed.') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

/** Asked for something that is not there, or not there for this council. */
export class NotFoundError extends DomainError {
  constructor(message = 'Not found.') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

const log = new Logger('errors');

export interface ErrorResponse {
  status: number;
  body: { statusCode: number; message: string };
}

/**
 * Turn any thrown thing into the response the caller should see.
 *
 * This is what the Nest exception filter used to do, as a pure function. Route handlers
 * call it from one place (see the web app's withAuth wrapper), which means the mapping
 * cannot drift endpoint by endpoint and can be unit-tested without a server.
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (isDomainError(err)) {
    return { status: err.status, body: { statusCode: err.status, message: err.message } };
  }

  // A malformed request body. Zod's messages name the field, which is what the caller
  // needs, so they are passed through.
  if (isZodError(err)) {
    const message = err.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return { status: 400, body: { statusCode: 400, message } };
  }

  // Anything else is ours, not theirs. Logged in full, reported vaguely.
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return {
    status: 500,
    body: {
      statusCode: 500,
      message: 'Something went wrong at our end. The failure has been logged.',
    },
  };
}
