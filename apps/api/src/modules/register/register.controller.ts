import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { inCouncilScope } from '../../context/council-context.js';
import { requireIdentity } from '../auth/auth.guard.js';
import { RegisterService } from './register.service.js';

@Controller('register')
export class RegisterController {
  constructor(private readonly register: RegisterService) {}

  @Get()
  async rows(
    @Req() req: FastifyRequest,
    @Query('fiscalYear') fiscalYear?: string,
    @Query('includeClosed') includeClosed?: string,
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => ({
      rows: await this.register.rows(tx, ctx, {
        fiscalYear,
        includeClosed: includeClosed !== 'false',
      }),
    }));
  }

  /**
   * The register as a file.
   *
   * This is what an RTI reply is assembled from, what a court is shown, and the artefact
   * that means the book survives this project ending. `no-store` because it is the whole
   * register of a quasi-judicial body and has no business sitting in a proxy cache.
   */
  @Get('export.csv')
  async csv(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('fiscalYear') fiscalYear?: string,
  ) {
    const identity = requireIdentity(req);
    const out = await inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.register.csv(tx, ctx, { fiscalYear }),
    );
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('cache-control', 'private, no-store')
      .send(out.content);
  }
}
