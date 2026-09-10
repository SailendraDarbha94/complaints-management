import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CORRESPONDENCE_KINDS, SERVICE_MODES, fieldsFor } from '@ksdc/contracts';
import type { CorrespondenceKind } from '@ksdc/contracts';
import { inCouncilScope } from '../../context/council-context.js';
import { requireIdentity } from '../auth/auth.guard.js';
import { CorrespondenceService } from './correspondence.service.js';

const draftSchema = z.object({
  kind: z.enum(CORRESPONDENCE_KINDS),
  caseRespondentId: z.string().uuid().nullish(),
});

const sentSchema = z.object({
  sentAt: z.string().min(4),
  serviceMode: z.enum(SERVICE_MODES).optional(),
  caseRespondentId: z.string().uuid().nullish(),
});

const despatchSchema = z.object({
  despatchNo: z.string().min(1),
  despatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  registerPage: z.string().nullish(),
});

const publishSchema = z.object({
  kind: z.enum(CORRESPONDENCE_KINDS),
  subject: z.string().min(1),
  body: z.string().min(1),
});

@Controller()
export class CorrespondenceController {
  constructor(private readonly correspondence: CorrespondenceService) {}

  @Post('cases/:id/letters')
  async draft(@Req() req: FastifyRequest, @Param('id') caseFileId: string, @Body() body: unknown) {
    const identity = requireIdentity(req);
    const input = draftSchema.parse(body);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.correspondence.draft(tx, ctx, {
        caseFileId,
        kind: input.kind,
        caseRespondentId: input.caseRespondentId ?? null,
        officerName: identity.name,
      }),
    );
  }

  /** The click that starts the clock. */
  @Post('letters/:id/sent')
  async markSent(
    @Req() req: FastifyRequest,
    @Param('id') correspondenceId: string,
    @Body() body: unknown,
  ) {
    const identity = requireIdentity(req);
    const input = sentSchema.parse(body);
    // A bare date means "that day", read in the council's own calendar rather than the
    // browser's: an officer in Bengaluru confirming at 11pm meant today, not tomorrow.
    const sentAt = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(input.sentAt) ? `${input.sentAt}T06:00:00Z` : input.sentAt,
    );
    if (Number.isNaN(sentAt.getTime())) {
      throw new Error(`"${input.sentAt}" is not a date.`);
    }
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.correspondence.markSent(tx, ctx, {
        correspondenceId,
        sentAt,
        serviceMode: input.serviceMode,
        caseRespondentId: input.caseRespondentId ?? null,
      }),
    );
  }

  @Post('letters/:id/despatch')
  async recordDespatch(
    @Req() req: FastifyRequest,
    @Param('id') correspondenceId: string,
    @Body() body: unknown,
  ) {
    const identity = requireIdentity(req);
    const input = despatchSchema.parse(body);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      await this.correspondence.recordDespatch(tx, ctx, {
        correspondenceId,
        despatchNo: input.despatchNo,
        despatchDate: input.despatchDate,
        registerPage: input.registerPage ?? null,
      });
      return { recorded: true };
    });
  }

  @Get('templates')
  async listTemplates(@Req() req: FastifyRequest) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx) => {
      const rows = await tx.execute<{
        kind: CorrespondenceKind;
        name: string;
        is_system: boolean;
        requires_registrar_signature: boolean;
        version_no: number;
        subject_tpl: string;
        body: string;
        published_at: Date;
      }>(sql`
        SELECT t.kind, t.name, t.is_system, t.requires_registrar_signature,
               v.version_no, v.subject_tpl, v.body, v.published_at
        FROM template t
        JOIN template_version v ON v.id = t.current_version_id
        ORDER BY t.kind
      `);
      return {
        templates: rows.rows.map((r) => ({ ...r, availableFields: fieldsFor(r.kind) })),
      };
    });
  }

  @Post('templates')
  async publish(@Req() req: FastifyRequest, @Body() body: unknown) {
    const identity = requireIdentity(req);
    const input = publishSchema.parse(body);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.correspondence.publishTemplate(tx, ctx, input),
    );
  }
}
