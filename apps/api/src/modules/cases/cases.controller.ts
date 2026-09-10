import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { CaseEvent, CaseState } from '@ksdc/contracts';
import { inCouncilScope } from '../../context/council-context.js';
import { requireIdentity } from '../auth/auth.guard.js';
import { CaseIntakeService, type IntakeInput } from './case-intake.service.js';
import { CaseLifecycleService, type ApplyEventInput } from './case-lifecycle.service.js';
import { FollowupService } from '../followups/followup.service.js';

@Controller('cases')
export class CasesController {
  constructor(
    private readonly intake: CaseIntakeService,
    private readonly lifecycle: CaseLifecycleService,
    private readonly followups: FollowupService,
  ) {}

  /** The register view: one row per case, the columns proposed in the build plan. */
  @Get()
  async list(@Req() req: FastifyRequest) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT c.register_sl_no, c.case_number, c.case_kind, c.state, c.waiting_on,
               c.on_hold, c.summary, c.intake_source,
               (now()::date - c.waiting_since::date) AS days_waiting,
               c.closed_at, c.closure_reason, c.is_backfilled, c.id,
               (SELECT p.full_name FROM case_party cp
                  JOIN party p ON p.id = cp.party_id
                 WHERE cp.case_file_id = c.id AND cp.role = 'complainant'
                 LIMIT 1) AS complainant_name
        FROM case_file c
        WHERE c.deleted_at IS NULL
        ORDER BY c.register_sl_no DESC
      `);
      return { cases: rows.rows };
    });
  }

  @Get(':id')
  async detail(@Req() req: FastifyRequest, @Param('id') id: string) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, async (tx, ctx) => {
      const caseRows = await tx.execute<{ state: CaseState }>(
        sql`SELECT * FROM case_file WHERE id = ${id}::uuid`,
      );
      const row = caseRows.rows[0];
      if (!row) return { case: null };

      const [parties, milestones, history, followups] = await Promise.all([
        tx.execute(sql`
          SELECT cp.role, p.full_name, p.mobile, p.email
          FROM case_party cp JOIN party p ON p.id = cp.party_id
          WHERE cp.case_file_id = ${id}::uuid ORDER BY cp.role`),
        tx.execute(sql`
          SELECT milestone, occurred_at, date_source, note
          FROM case_milestone WHERE case_file_id = ${id}::uuid ORDER BY occurred_at`),
        tx.execute(sql`
          SELECT event, from_state, to_state, reason, occurred_at, is_system
          FROM case_state_history WHERE case_file_id = ${id}::uuid ORDER BY occurred_at`),
        this.followups.liveForCase(tx, ctx, id),
      ]);

      return {
        case: row,
        parties: parties.rows,
        milestones: milestones.rows,
        history: history.rows,
        followups,
        // Drives every button on every client, so no UI re-implements a guard.
        availableEvents: this.lifecycle.availableFor(row.state, ctx),
      };
    });
  }

  @Post()
  async create(@Req() req: FastifyRequest, @Body() body: IntakeInput) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.intake.create(tx, ctx, { ...body, receivedAt: new Date(body.receivedAt) }),
    );
  }

  @Post(':id/events/:event')
  async applyEvent(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('event') event: CaseEvent,
    @Body() body: Omit<ApplyEventInput, 'caseFileId' | 'event'>,
  ) {
    const identity = requireIdentity(req);
    return inCouncilScope(identity, req.id as string, (tx, ctx) =>
      this.lifecycle.apply(tx, ctx, {
        ...body,
        caseFileId: id,
        event,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
        notice: body.notice ? { ...body.notice, sentAt: new Date(body.notice.sentAt) } : undefined,
      }),
    );
  }
}
