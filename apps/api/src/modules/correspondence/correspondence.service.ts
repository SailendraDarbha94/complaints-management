import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { CaseEvent, CorrespondenceKind, ServiceMode } from '@ksdc/contracts';
import { fieldsFor, renderTemplate, subjectWithReference, validateTemplate } from '@ksdc/contracts';
import { KSDC_TEMPLATES } from '@ksdc/config';
import type { EngineContext } from '../followups/followup.service.js';
import { FollowupService } from '../followups/followup.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { buildMergeContext } from './merge-context.js';
import { ConflictError, DomainError } from '../../common/domain-error.js';

/**
 * Drafting and recording the council's letters.
 *
 * In Phase 1 the software does not send anything to a party. It produces a draft the
 * officer copies into council webmail, and records what went out when they confirm it
 * (requirement 4). That confirmation is not bookkeeping: it is the click that starts the
 * five-to-seven day clock, and for a respondent notice it is the only thing that moves
 * the notice counter.
 *
 * Sending directly is Phase 6, behind its own gate. The seam is `markSent`, which does
 * not care who put the letter in the post.
 */

export interface DraftResult {
  correspondenceId: string;
  kind: CorrespondenceKind;
  subject: string;
  body: string;
  to: { name: string | null; email: string | null };
  /** What the officer must attach by hand before sending. */
  attachments: Array<{ documentId: string; title: string; filename: string }>;
  requiresRegistrarSignature: boolean;
  templateVersionId: string;
}

/**
 * What confirming a despatch means for the case.
 *
 * A letter is not just a record; sending it is the act that moves the case on. Keeping
 * this mapping here, rather than asking the officer to remember to press a second button,
 * is the difference between a register that reflects reality and one that lags it.
 */
const EVENT_FOR_KIND: Partial<Record<CorrespondenceKind, CaseEvent>> = {
  request_docs: 'REQUEST_DOCUMENTS',
  respondent_explanation_sought: 'ISSUE_RESPONDENT_NOTICE',
  respondent_reminder: 'ISSUE_RESPONDENT_NOTICE',
  respondent_final_notice: 'ISSUE_RESPONDENT_NOTICE',
  ethics_explanation: 'ISSUE_RESPONDENT_NOTICE',
  expert_referral_letter: 'REFER_TO_EXPERT',
};

@Injectable()
export class CorrespondenceService {
  private readonly log = new Logger('correspondence');

  constructor(
    private readonly lifecycle: CaseLifecycleService,
    private readonly followups: FollowupService,
  ) {}

  /**
   * Install the shipped templates for a council that has none.
   *
   * Idempotent, and it never overwrites: once the officer has edited a letter, the
   * shipped wording is not the council's wording any more.
   */
  async seedTemplates(tx: Tx, ctx: EngineContext): Promise<number> {
    let installed = 0;
    for (const seed of KSDC_TEMPLATES) {
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id FROM template
        WHERE council_id = ${ctx.councilId}::uuid AND kind = ${seed.kind}::correspondence_kind
      `);
      if (existing.rows.length > 0) continue;

      const template = await tx.execute<{ id: string }>(sql`
        INSERT INTO template (council_id, kind, name, is_system, requires_registrar_signature)
        VALUES (${ctx.councilId}::uuid, ${seed.kind}::correspondence_kind, ${seed.name},
                ${seed.isSystem}, ${seed.requiresRegistrarSignature})
        RETURNING id
      `);
      const templateId = template.rows[0]!.id;

      const version = await tx.execute<{ id: string }>(sql`
        INSERT INTO template_version (council_id, template_id, version_no, subject_tpl, body,
                                      published_at, published_by)
        VALUES (${ctx.councilId}::uuid, ${templateId}::uuid, 1, ${seed.subject}, ${seed.body},
                now(), ${ctx.userId ?? null})
        RETURNING id
      `);
      await tx.execute(sql`
        UPDATE template SET current_version_id = ${version.rows[0]!.id}::uuid
        WHERE id = ${templateId}::uuid
      `);
      installed++;
    }
    return installed;
  }

  /**
   * Publish a new version of a template.
   *
   * Versions are never edited in place. In 2031 the council must be able to show which
   * wording produced a 2026 letter, and that is only possible if the wording still exists.
   */
  async publishTemplate(
    tx: Tx,
    ctx: EngineContext,
    args: { kind: CorrespondenceKind; subject: string; body: string },
  ): Promise<{ versionNo: number; warnings: string[] }> {
    const allowed = fieldsFor(args.kind);
    const body = validateTemplate(args.body, allowed);
    const subject = validateTemplate(args.subject, allowed);

    if (!body.ok || !subject.ok) {
      const unknown = [...new Set([...body.unknownFields, ...subject.unknownFields])];
      throw new DomainError(
        unknown.length
          ? `This letter cannot use ${unknown.join(', ')}. Available fields: ${allowed.join(', ')}`
          : 'A {{#if}} is not closed.',
      );
    }

    const row = await tx.execute<{ id: string; is_system: boolean }>(sql`
      SELECT id, is_system FROM template
      WHERE council_id = ${ctx.councilId}::uuid AND kind = ${args.kind}::correspondence_kind
    `);
    const template = row.rows[0];
    if (!template) throw new DomainError(`No template for ${args.kind}. Seed the catalogue first.`);

    const next = await tx.execute<{ n: number }>(sql`
      SELECT coalesce(max(version_no), 0) + 1 AS n FROM template_version
      WHERE template_id = ${template.id}::uuid
    `);
    const versionNo = Number(next.rows[0]!.n);

    const version = await tx.execute<{ id: string }>(sql`
      INSERT INTO template_version (council_id, template_id, version_no, subject_tpl, body,
                                    published_at, published_by)
      VALUES (${ctx.councilId}::uuid, ${template.id}::uuid, ${versionNo}, ${args.subject},
              ${args.body}, now(), ${ctx.userId ?? null})
      RETURNING id
    `);
    await tx.execute(sql`
      UPDATE template SET current_version_id = ${version.rows[0]!.id}::uuid
      WHERE id = ${template.id}::uuid
    `);

    const warnings: string[] = [];
    if (template.is_system) {
      warnings.push(
        'This is a system template. Its wording is load-bearing: the questions in the ' +
          'expert referral are the terms of reference the expert answers, and the report ' +
          'effectively decides the case.',
      );
    }
    return { versionNo, warnings };
  }

  /**
   * Compose a draft. Nothing is sent; the officer copies it into council webmail.
   *
   * The merge context is snapshotted onto the row along with the template version, so the
   * exact wording and the exact data that produced this letter are both recoverable.
   */
  async draft(
    tx: Tx,
    ctx: EngineContext,
    args: {
      caseFileId: string;
      kind: CorrespondenceKind;
      caseRespondentId?: string | null;
      officerName?: string | null;
      now?: Date;
    },
  ): Promise<DraftResult> {
    const template = await tx.execute<{
      template_id: string;
      version_id: string;
      subject_tpl: string;
      body: string;
      requires_registrar_signature: boolean;
    }>(sql`
      SELECT t.id AS template_id, v.id AS version_id, v.subject_tpl, v.body,
             t.requires_registrar_signature
      FROM template t
      JOIN template_version v ON v.id = t.current_version_id
      WHERE t.council_id = ${ctx.councilId}::uuid AND t.kind = ${args.kind}::correspondence_kind
    `);
    const chosen = template.rows[0];
    if (!chosen) throw new DomainError(`No published template for ${args.kind}.`);

    const merge = await buildMergeContext(tx, ctx, args);

    const renderedSubject = renderTemplate(chosen.subject_tpl, merge, 'text');
    const body = renderTemplate(chosen.body, merge, 'text');

    // The reference token is what a reply carries back. In Phase 1 the officer sends by
    // hand, so there is no outbound Message-ID to thread on and this is the only key.
    const caseNumber = (merge.case as { number: string }).number;
    const subject = subjectWithReference(renderedSubject, caseNumber);

    const recipient = this.recipientFor(args.kind, merge);

    // Drafting the same letter twice - because the officer added a missing detail and came
    // back, or simply clicked again - rewrites the draft rather than leaving a second one
    // behind. Nothing has been sent, so there is no record to preserve, and a letters table
    // that fills with abandoned drafts stops being readable within a week. A row that has
    // been despatched is never touched: sent_at IS NULL is what makes this safe.
    const inserted = await tx.execute<{ id: string }>(sql`
      WITH existing AS (
        SELECT id FROM correspondence
        WHERE council_id = ${ctx.councilId}::uuid
          AND case_file_id = ${args.caseFileId}::uuid
          AND kind = ${args.kind}::correspondence_kind
          AND direction = 'out'::contact_direction
          AND sent_at IS NULL
          AND to_name IS NOT DISTINCT FROM ${recipient.name}
        ORDER BY created_at
        LIMIT 1
      ),
      rewritten AS (
        UPDATE correspondence SET
          to_email = ${recipient.email},
          subject = ${subject},
          body = ${body},
          template_version_id = ${chosen.version_id}::uuid,
          merge_context = ${JSON.stringify(merge)}::jsonb,
          created_by = ${ctx.userId ?? null},
          created_at = now()
        WHERE id IN (SELECT id FROM existing)
        RETURNING id
      ),
      created AS (
        INSERT INTO correspondence (council_id, case_file_id, kind, direction, to_party_id,
                                    to_name, to_email, subject, body, template_version_id,
                                    merge_context, created_by)
        SELECT ${ctx.councilId}::uuid, ${args.caseFileId}::uuid,
               ${args.kind}::correspondence_kind, 'out'::contact_direction, NULL,
               ${recipient.name}, ${recipient.email}, ${subject}, ${body},
               ${chosen.version_id}::uuid, ${JSON.stringify(merge)}::jsonb,
               ${ctx.userId ?? null}
        WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      )
      SELECT id FROM rewritten
      UNION ALL
      SELECT id FROM created
    `);

    const attachments = await tx.execute<{ id: string; title: string; filename: string }>(sql`
      SELECT d.id, d.title, dv.original_filename AS filename
      FROM document d
      JOIN document_version dv ON dv.id = d.current_version_id
      WHERE d.case_file_id = ${args.caseFileId}::uuid AND d.status = 'stored'
      ORDER BY d.created_at
    `);

    return {
      correspondenceId: inserted.rows[0]!.id,
      kind: args.kind,
      subject,
      body,
      to: recipient,
      attachments: attachments.rows.map((a) => ({
        documentId: a.id,
        title: a.title,
        filename: a.filename,
      })),
      requiresRegistrarSignature: chosen.requires_registrar_signature,
      templateVersionId: chosen.version_id,
    };
  }

  private recipientFor(
    kind: CorrespondenceKind,
    merge: Record<string, unknown>,
  ): { name: string | null; email: string | null } {
    const complainant = merge.complainant as { name?: string; email?: string } | undefined;
    const respondent = merge.respondent as { name?: string } | undefined;
    const expert = merge.expert as { addresseeTitle?: string } | undefined;

    if (kind.startsWith('respondent_') || kind.startsWith('ethics_')) {
      return { name: respondent?.name ?? null, email: null };
    }
    if (kind === 'expert_referral_letter') {
      return { name: expert?.addresseeTitle ?? null, email: null };
    }
    return { name: complainant?.name ?? null, email: complainant?.email ?? null };
  }

  /**
   * "I have sent this."
   *
   * The click that starts the clock. It records the despatch, then applies whatever the
   * sending of that letter means for the case — the document-request deadline begins, or
   * the respondent's notice counter moves — in the same transaction, so the register can
   * never show a letter sent without the consequence, or the consequence without the letter.
   */
  async markSent(
    tx: Tx,
    ctx: EngineContext,
    args: {
      correspondenceId: string;
      sentAt: Date;
      serviceMode?: ServiceMode;
      caseRespondentId?: string | null;
    },
  ): Promise<{ transitioned: CaseEvent | null }> {
    const row = await tx.execute<{
      id: string;
      kind: CorrespondenceKind;
      case_file_id: string | null;
      sent_at: Date | null;
    }>(sql`
      SELECT id, kind, case_file_id, sent_at FROM correspondence
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.correspondenceId}::uuid
    `);
    const letter = row.rows[0];
    if (!letter) throw new DomainError('Draft not found.');
    if (letter.sent_at) {
      // Confirming twice would advance the notice ladder twice, and the count is the
      // basis of an ex parte finding against a named dentist.
      throw new ConflictError('This letter is already recorded as sent.');
    }

    await tx.execute(sql`
      UPDATE correspondence SET sent_at = ${args.sentAt} WHERE id = ${letter.id}::uuid
    `);

    const event = EVENT_FOR_KIND[letter.kind];
    if (!event || !letter.case_file_id) return { transitioned: null };

    await this.lifecycle.apply(tx, ctx, {
      caseFileId: letter.case_file_id,
      event,
      occurredAt: args.sentAt,
      caseRespondentId: args.caseRespondentId ?? null,
      ...(event === 'ISSUE_RESPONDENT_NOTICE'
        ? {
            notice: {
              serviceMode: args.serviceMode ?? 'email',
              sentAt: args.sentAt,
              correspondenceId: letter.id,
            },
          }
        : {}),
    });

    // Only the GDCRI letter is stamped by the office, so only it needs chasing for a
    // despatch number. Chasing the officer for a number that does not exist would teach
    // them to dismiss the queue.
    if (letter.kind === 'expert_referral_letter') {
      await this.followups.open(
        tx,
        ctx,
        {
          stage: 'await_despatch_entry',
          caseFileId: letter.case_file_id,
          waitingOnKind: 'council_officer',
          title: 'Enter the outward despatch number from the office register',
          detail: `For the letter "${letter.kind}" recorded as sent on ${args.sentAt.toISOString().slice(0, 10)}.`,
          dedupeSuffix: letter.id,
        },
        args.sentAt,
      );
    }

    return { transitioned: event };
  }

  /**
   * Record the outward despatch number after the office has stamped the letter.
   *
   * The software never generates this. It belongs to a book shared with certificates and
   * circulars issued by people who will never touch this system, and minting our own
   * would put our 298 against a clerk's handwritten 298.
   */
  async recordDespatch(
    tx: Tx,
    ctx: EngineContext,
    args: {
      correspondenceId: string;
      despatchNo: string;
      despatchDate: string;
      registerPage?: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE correspondence
      SET despatch_no = ${args.despatchNo},
          despatch_date = ${args.despatchDate}::date,
          despatch_register_page = ${args.registerPage ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.correspondenceId}::uuid
    `);

    const live = await tx.execute<{ id: string }>(sql`
      SELECT id FROM follow_up
      WHERE council_id = ${ctx.councilId}::uuid
        AND stage = 'await_despatch_entry'
        AND dedupe_key LIKE ${'%' + args.correspondenceId}
        AND status IN ('open','snoozed')
    `);
    for (const f of live.rows) {
      await this.followups.satisfy(tx, ctx, {
        followUpId: f.id,
        note: `Despatch no. ${args.despatchNo}`,
      });
    }
  }

  /** Log an inbound letter or email, so the register shows a two-way chronology. */
  async recordInbound(
    tx: Tx,
    ctx: EngineContext,
    args: {
      caseFileId: string;
      subject: string;
      body: string;
      fromEmail?: string | null;
      receivedAt: Date;
    },
  ): Promise<string> {
    const row = await tx.execute<{ id: string }>(sql`
      INSERT INTO correspondence (council_id, case_file_id, kind, direction, subject, body,
                                  from_email, received_at, created_by)
      VALUES (${ctx.councilId}::uuid, ${args.caseFileId}::uuid, 'inbound'::correspondence_kind,
              'in'::contact_direction, ${args.subject}, ${args.body},
              ${args.fromEmail ?? null}, ${args.receivedAt}, ${ctx.userId ?? null})
      RETURNING id
    `);
    return row.rows[0]!.id;
  }
}
