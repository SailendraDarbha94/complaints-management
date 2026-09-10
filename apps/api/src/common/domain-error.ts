import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

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
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number = HttpStatus.BAD_REQUEST,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** The officer tried to do something the case's current state does not allow. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
    this.name = 'ConflictError';
  }
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof DomainError) {
      reply.status(exception.status).send({
        statusCode: exception.status,
        message: exception.message,
      });
      return;
    }

    // A malformed request body. Zod's messages name the field, which is what the caller
    // needs, so they are passed through.
    if (exception instanceof ZodError) {
      reply.status(HttpStatus.BAD_REQUEST).send({
        statusCode: HttpStatus.BAD_REQUEST,
        message: exception.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      reply.status(status).send(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    // Anything else is ours, not theirs. Logged in full, reported vaguely.
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong at our end. The failure has been logged.',
    });
  }
}
