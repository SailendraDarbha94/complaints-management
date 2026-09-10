import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import {
  caseFile,
  caseMilestone,
  caseStateHistory,
  casePartyTable,
  council,
  numberAllocation,
  party,
} from '@ksdc/db';
import type { CaseKind, DateSource, IntakeSource, PartyRole } from '@ksdc/contracts';
import { formatCaseNumber, fiscalYearOf, type CaseSeries } from '@ksdc/contracts';
import type { EngineContext, FollowupService } from '../followups/followup.service.js';

/**
 * Case intake: the only place a case is created, and the only place a serial is issued.
 *
 * Two series are allocated, and only two. The office-wide OUTWARD DESPATCH number is not
 * one of them — that book is shared with certificates and circulars issued by people who
 * will never touch this software, so it is typed in after the office stamps a letter.
 * Minting it here would put our 298 against a clerk's handwritten 298 and corrupt the one
 * document the council already produces in court.
 */

export interface IntakeInput {
  caseKind?: CaseKind;
  intakeSource?: IntakeSource;
  summary: string;
  /** When it actually arrived: the email timestamp or the physical stamp. */
  receivedAt: Date;
  /** `from_physical_register` for the backlog. Footnoted in every export. */
  dateSource?: DateSource;
  externalRefNo?: string | null;
  externalAuthorityName?: string | null;
  externalDueAt?: string | null;
  legacyRegisterRef?: string | null;
  isBackfilled?: boolean;
  complainant?: { fullName: string; mobile?: string | null; email?: string | null };
  /** Defaults to the complainant — they are the same person in most cases, but not all. */
  patient?: { fullName: string; ageYears?: number | null; sex?: string | null };
}

export interface IntakeResult {
  caseFileId: string;
  caseNumber: string;
  registerSlNo: number;
}

const SERIES_FOR_KIND: Record<CaseKind, CaseSeries> = {
  patient_complaint: 'COMP',
  ethics_notice: 'ETH',
};

/** The register is one book, so its serial is shared across complaint kinds. */
const REGISTER_SERIES = 'REGISTER';

export class CaseIntakeService {
  constructor(private readonly followups: FollowupService) {}

  async create(tx: Tx, ctx: EngineContext, input: IntakeInput): Promise<IntakeResult> {
    const [councilRow] = await tx
      .select()
      .from(council)
      .where(eq(council.id, ctx.councilId))
      .limit(1);
    if (!councilRow) throw new Error(`Council ${ctx.councilId} not found`);

    // The authorisation gate. Until the four artefacts exist in docs/authorisation/ the
    // system holds demo data only. The legal register of a statutory body must never end
    // up inside one individual's personal cloud account by drift.
    if (!councilRow.productionAuthorisedAt && !councilRow.isSynthetic) {
      throw new Error(
        'This council is not authorised for production data yet. Four artefacts must be ' +
          'filed in docs/authorisation/ first: the signed letterhead authorisation, the ' +
          "Registrar's email to the project account, proof the domain is registered to " +
          'the council, and proof the cloud billing account is the council’s.',
      );
    }

    const caseKind = input.caseKind ?? 'patient_complaint';
    const fiscalYear = fiscalYearOf(input.receivedAt);
    const series = SERIES_FOR_KIND[caseKind];

    const serial = await this.allocate(tx, ctx.councilId, series, fiscalYear);
    const registerSlNo = await this.allocate(tx, ctx.councilId, REGISTER_SERIES, fiscalYear);
    const caseNumber = formatCaseNumber(councilRow.code, series, fiscalYear, serial);

    const caseFileId = crypto.randomUUID();
    await tx.insert(caseFile).values({
      id: caseFileId,
      councilId: ctx.councilId,
      caseKind,
      caseNumber,
      fiscalYear,
      registerSlNo,
      state: 'intake_received',
      // `received_at` is the arrival, never when it was typed in — the mailbox, not the
      // software, is the primary evidence of receipt.
      waitingSince: input.receivedAt,
      intakeSource: input.intakeSource ?? 'direct_email',
      externalRefNo: input.externalRefNo ?? null,
      externalAuthorityName: input.externalAuthorityName ?? null,
      externalDueAt: input.externalDueAt ?? null,
      summary: input.summary,
      isBackfilled: input.isBackfilled ?? false,
      legacyRegisterRef: input.legacyRegisterRef ?? null,
      ownerUserId: ctx.userId ?? null,
      createdBy: ctx.userId ?? null,
    });

    await tx.insert(numberAllocation).values({
      councilId: ctx.councilId,
      series,
      fiscalYear,
      value: serial,
      formatted: caseNumber,
      caseFileId,
      allocatedBy: ctx.userId ?? null,
    });

    if (input.complainant) {
      await this.addParty(tx, ctx, caseFileId, 'complainant', input.complainant, true);
      // Complainant and patient are stored separately but default to the same person:
      // in a legal-heir case they differ, and the GDCRI letter names the PATIENT.
      const patient = input.patient ?? { fullName: input.complainant.fullName };
      await this.addParty(tx, ctx, caseFileId, 'patient', patient, true);
    }

    await tx.insert(caseMilestone).values({
      councilId: ctx.councilId,
      caseFileId,
      milestone: 'received',
      occurredAt: input.receivedAt,
      dateSource: input.dateSource ?? 'recorded',
      recordedBy: ctx.userId ?? null,
    });

    await tx.insert(caseStateHistory).values({
      councilId: ctx.councilId,
      caseFileId,
      fromState: null,
      toState: 'intake_received',
      event: 'LOG_INTAKE',
      actorUserId: ctx.userId ?? null,
      occurredAt: input.receivedAt,
    });

    // A new case must never land with nothing scheduled against it. The clock runs from
    // arrival, so a backlog case entered today shows the delay it actually has.
    await this.followups.open(
      tx,
      ctx,
      {
        stage: 'ad_hoc',
        caseFileId,
        waitingOnKind: 'council_officer',
        title: 'Acknowledge and request documents',
        detail: `New ${caseKind === 'ethics_notice' ? 'ethics notice' : 'complaint'}: ${input.summary}`,
      },
      input.receivedAt,
    );

    return { caseFileId, caseNumber, registerSlNo };
  }

  /**
   * Allocate the next serial. `UPDATE ... RETURNING` inside the caller's transaction, so
   * two concurrent intakes cannot take the same number: the second waits on the row lock.
   */
  private async allocate(
    tx: Tx,
    councilId: string,
    series: string,
    fiscalYear: string,
  ): Promise<number> {
    const res = await tx.execute<{ next_value: number }>(sql`
      INSERT INTO number_sequence (council_id, series, fiscal_year, next_value)
      VALUES (${councilId}::uuid, ${series}, ${fiscalYear}, 2)
      ON CONFLICT (council_id, series, fiscal_year)
      DO UPDATE SET next_value = number_sequence.next_value + 1
      RETURNING next_value - 1 AS next_value
    `);
    const value = res.rows[0]?.next_value;
    if (value == null) throw new Error(`Could not allocate a ${series} serial for ${fiscalYear}`);
    return Number(value);
  }

  /**
   * Seed a series so new cases continue after the physical book rather than restarting.
   * Renumbering a legal register is worse than a gap.
   */
  async seedRegisterSerial(
    tx: Tx,
    councilId: string,
    fiscalYear: string,
    highestInBook: number,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO number_sequence (council_id, series, fiscal_year, next_value)
      VALUES (${councilId}::uuid, ${REGISTER_SERIES}, ${fiscalYear}, ${highestInBook + 1})
      ON CONFLICT (council_id, series, fiscal_year)
      DO UPDATE SET next_value = GREATEST(number_sequence.next_value, ${highestInBook + 1})
    `);
  }

  private async addParty(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
    role: PartyRole,
    person: { fullName: string; mobile?: string | null; email?: string | null; ageYears?: number | null; sex?: string | null },
    isPrimary: boolean,
  ): Promise<string> {
    const partyId = crypto.randomUUID();
    await tx.insert(party).values({
      id: partyId,
      councilId: ctx.councilId,
      kind: 'person',
      fullName: person.fullName,
      mobile: person.mobile ?? null,
      // Digits only, so a caller can be matched against an existing party however the
      // number was typed.
      mobileNormalised: person.mobile ? person.mobile.replace(/\D/g, '') : null,
      email: person.email ?? null,
      ageYears: person.ageYears ?? null,
      sex: person.sex ?? null,
    });
    await tx.insert(casePartyTable).values({
      councilId: ctx.councilId,
      caseFileId,
      partyId,
      role,
      isPrimary,
    });
    return partyId;
  }

  async findByNumber(tx: Tx, ctx: EngineContext, caseNumber: string) {
    const [row] = await tx
      .select()
      .from(caseFile)
      .where(and(eq(caseFile.councilId, ctx.councilId), eq(caseFile.caseNumber, caseNumber)))
      .limit(1);
    return row ?? null;
  }
}
