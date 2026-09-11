import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  isDomainError,
  toErrorResponse,
} from './domain-error.js';

/**
 * These exist because of a real regression, caught end to end and not by a type.
 *
 * When the HTTP layer moved to Next.js route handlers, every officer-readable refusal
 * started coming back as "Something went wrong at our end" with a 500. The cause was that
 * webpack loaded this module twice - once for the service that throws, once for the mapper
 * that catches - so `err instanceof DomainError` was false between two identical classes.
 *
 * The mapper is structural now. The first test below is the one that would have caught it:
 * it fakes the duplicate-module case by throwing an object that is shaped like a
 * DomainError but shares no prototype with the real one.
 */
describe('mapping errors onto responses', () => {
  it('recognises a DomainError from a DIFFERENT copy of this module', () => {
    // What a second webpack copy of the class produces: same shape, foreign prototype.
    const fromAnotherBundle = Object.assign(new Error('This letter has already gone.'), {
      name: 'ConflictError',
      isDomainError: true,
      status: 409,
    });

    expect(fromAnotherBundle instanceof DomainError).toBe(false);
    expect(isDomainError(fromAnotherBundle)).toBe(true);

    const { status, body } = toErrorResponse(fromAnotherBundle);
    expect(status).toBe(409);
    expect(body.message).toBe('This letter has already gone.');
  });

  it.each([
    [new DomainError('That file is not a PDF.'), 400],
    [new ConflictError('This letter is already recorded as sent.'), 409],
    [new UnauthorizedError(), 401],
    [new ForbiddenError(), 403],
    [new NotFoundError(), 404],
  ])('carries %s through with its own status', (err, expected) => {
    const { status, body } = toErrorResponse(err);
    expect(status).toBe(expected);
    expect(body.statusCode).toBe(expected);
    expect(body.message).toBe((err as Error).message);
  });

  it('names the offending field when a body fails validation', () => {
    const schema = z.object({ code: z.string().regex(/^\d{6}$/, 'A code is six digits.') });
    const result = schema.safeParse({ code: 'abc' });

    const { status, body } = toErrorResponse(result.error);
    expect(status).toBe(400);
    expect(body.message).toContain('code');
    expect(body.message).toContain('A code is six digits.');
  });

  it('recognises a ZodError from a different copy of zod', () => {
    // apps/web and @ksdc/core can each resolve their own zod; the check must not care.
    const foreign = Object.assign(new Error('bad'), {
      name: 'ZodError',
      issues: [{ path: ['email'], message: 'Invalid email' }],
    });
    const { status, body } = toErrorResponse(foreign);
    expect(status).toBe(400);
    expect(body.message).toBe('email: Invalid email');
  });

  it('says nothing revealing about an error we did not write', () => {
    const { status, body } = toErrorResponse(new Error('relation "case_file" does not exist'));
    expect(status).toBe(500);
    expect(body.message).not.toContain('case_file');
  });

  it('does not mistake an arbitrary object for a domain error', () => {
    expect(isDomainError({ status: 418 })).toBe(false);
    expect(isDomainError({ isDomainError: true })).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError('nope')).toBe(false);
  });
});
