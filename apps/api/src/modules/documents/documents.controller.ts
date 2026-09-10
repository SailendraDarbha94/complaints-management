import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_CLASSES } from '@ksdc/contracts';
import { inCouncilScope } from '../../context/council-context.js';
import { requireIdentity } from '../auth/auth.guard.js';
import { DocumentsService } from './documents.service.js';

const commitSchema = z.object({
  storageKey: z.string().min(1),
  title: z.string().min(1),
  originalFilename: z.string().min(1),
  documentClass: z.enum(DOCUMENT_CLASSES).optional(),
  physicalOriginalHeld: z.boolean().optional(),
  documentId: z.string().uuid().optional(),
});

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Step one. The browser then PUTs the bytes straight to storage, not through here. */
  @Post('cases/:id/documents/upload-url')
  async uploadUrl(@Req() req: FastifyRequest, @Query('contentType') contentType?: string) {
    requireIdentity(req);
    return this.documents.requestUpload(contentType ?? 'application/octet-stream');
  }

  /** Step two: check what actually landed, then file it. */
  @Post('cases/:id/documents/commit')
  async commit(@Req() req: FastifyRequest, @Param('id') caseFileId: string, @Body() body: unknown) {
    const identity = requireIdentity(req);
    const input = commitSchema.parse(body);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.documents.commit(tx, ctx, { caseFileId, ...input }),
    );
  }

  @Get('cases/:id/documents')
  async list(@Req() req: FastifyRequest, @Param('id') caseFileId: string) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => ({
      documents: await this.documents.listForCase(tx, ctx, caseFileId),
    }));
  }

  @Get('documents/:id/download')
  async download(@Req() req: FastifyRequest, @Param('id') documentId: string) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.documents.downloadUrl(tx, ctx, {
        documentId,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      }),
    );
  }

  @Post('documents/:id/misfile')
  async misfile(
    @Req() req: FastifyRequest,
    @Param('id') documentId: string,
    @Body() body: { reason: string },
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      await this.documents.markMisfiled(tx, ctx, { documentId, reason: body.reason });
      return { withdrawn: true };
    });
  }
}
