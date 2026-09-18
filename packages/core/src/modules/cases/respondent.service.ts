import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { PartyRole } from '@ksdc/contracts';
import { ConflictError, DomainError } from '../../common/domain-error.js';
import { Logger } from '../../common/logger.js';
import type { EngineContext } from '../followups/followup.service.js';

/**
 * Naming the dentist a complaint is about.
 *
 * Until this existed, nothing in the running system could put a respondent on a case —
 * only the tests and the demo script could — so the notice ladder, ex parte eligibility,
 * every respondent letter and every per-respondent follow-up were unreachable in practice.
 * This is the missing step, and it is three rows rather than one:
 *
 *   party            the person. Reused across cases, so a dentist accrues a history.
 *   case_party       their role ON THIS CASE: respondent_dentist, or the establishment.
 *   case_respondent  their own notice ladder, independent of the case's state.
 *
 * THE DECISION THIS SERVICE IS BUILT AROUND: it never silently merges two people.
 *
 * A respondent's history is the point of reusing a party row — "this is the third
 * complaint against Dr Bhat this year" is a fact the committee should have, and it exists
 * only if the three complaints point at one party. But two dentists genuinely share a
 * name, and quietly merging them would attach one person's notice history to another and
 * put it in front of a committee deciding whether to suspend somebody. So matching is
 * offered as a SUGGESTION with the evidence attached, and the officer says which.
 *
 * The one exception is a registration number, which is unique in the register by
 * definition: same number, same dentist.
 */

export interface RespondentCandidate {
  partyId: string;
  fullName: string;
  registrationNo: string | null;
  clinicName: string | null;
  email: string | null;
  mobile: string | null;
  /** How many other cases already name this person as a respondent. */
  priorCases: number;
  /**
   * WHICH cases, most recent first.
   *
   * Without this the suggestions are unusable in the one situation they exist for. Two
   * dentists sharing a name produce two candidates reading "Dr N. Bhat - named on one
   * other case" and nothing else, and the officer cannot tell which is which, so the
   * safeguard against merging them turns into a coin toss.
   */
  priorCaseNumbers: string[];
  /** Set when the person is in the Council's own register of dentists. */
  registeredDentistId: string | null;
  /** Why they are being offered, in words. */
  because: string;
}

export interface AddRespondentInput {
  caseFileId: string;
  /** Use an existing person. The officer picked them from the suggestions. */
  partyId?: string;
  /** Or name a new one. */
  fullName?: string;
  registrationNo?: string | null;
  clinicName?: string | null;
  email?: string | null;
  mobile?: string | null;
  addressLines?: string[];
  /** An establishment rather than a person: a clinic or a chain. */
  isEstablishment?: boolean;
  note?: string | null;
}

export class RespondentService {
  private readonly log = new Logger('respondents');

  /**
   * Who might this be?
   *
   * Searches three places at once and says which. A dentist the Council has dealt with
   * before is the most useful answer, because picking them is what gives the committee the
   * history; the register of dentists is the most authoritative; and neither may have
   * heard of the person, which is an ordinary outcome rather than an error.
   */
  async search(
    tx: Tx,
    ctx: EngineContext,
    query: string,
  ): Promise<RespondentCandidate[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const digits = q.replace(/\D/g, '');

    const rows = await tx.execute<{
      party_id: string | null;
      registered_dentist_id: string | null;
      full_name: string;
      registration_no: string | null;
      clinic_name: string | null;
      email: string | null;
      mobile: string | null;
      prior_cases: number;
      prior_case_numbers: string[];
      source: string;
    }>(sql`
      -- People this Council has already named as a respondent. Picking one of these is
      -- what makes "the third complaint against this dentist" visible to a committee.
      SELECT p.id AS party_id, p.registered_dentist_id, p.full_name,
             coalesce(rd.registration_no, NULL) AS registration_no,
             coalesce(rd.clinic_name, NULL) AS clinic_name,
             p.email, p.mobile,
             (SELECT count(DISTINCT cp2.case_file_id)::int
                FROM case_party cp2
               WHERE cp2.party_id = p.id
                 AND cp2.role IN ('respondent_dentist','respondent_establishment')) AS prior_cases,
             (SELECT coalesce(array_agg(x.case_number ORDER BY x.register_sl_no DESC), '{}')
                FROM (SELECT DISTINCT c2.case_number, c2.register_sl_no
                        FROM case_party cp3 JOIN case_file c2 ON c2.id = cp3.case_file_id
                       WHERE cp3.party_id = p.id
                         AND cp3.role IN ('respondent_dentist','respondent_establishment')
                       ORDER BY c2.register_sl_no DESC LIMIT 4) x) AS prior_case_numbers,
             'seen_before'::text AS source
      FROM party p
      LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
      WHERE p.council_id = ${ctx.councilId}::uuid
        AND EXISTS (
          SELECT 1 FROM case_party cp
           WHERE cp.party_id = p.id
             AND cp.role IN ('respondent_dentist','respondent_establishment'))
        AND (p.full_name ILIKE ${like}
          OR (${digits} <> '' AND p.mobile_normalised LIKE ${`%${digits}`})
          OR (rd.registration_no IS NOT NULL AND rd.registration_no ILIKE ${like}))

      UNION ALL

      -- The Council's own register of dentists. Empty until the registry import lands;
      -- this half of the query starts working the day it does, with no change here.
      SELECT NULL, rd.id, rd.full_name, rd.registration_no, rd.clinic_name,
             rd.email, rd.mobile, 0, '{}'::text[], 'register'::text
      FROM registered_dentist rd
      WHERE rd.council_id = ${ctx.councilId}::uuid
        AND NOT EXISTS (SELECT 1 FROM party p2 WHERE p2.registered_dentist_id = rd.id)
        AND (rd.full_name ILIKE ${like} OR rd.registration_no ILIKE ${like})

      ORDER BY prior_cases DESC, full_name
      LIMIT 10
    `);

    return rows.rows.map((r) => ({
      partyId: r.party_id ?? '',
      fullName: r.full_name,
      registrationNo: r.registration_no,
      clinicName: r.clinic_name,
      email: r.email,
      mobile: r.mobile,
      priorCases: r.prior_cases,
      priorCaseNumbers: r.prior_case_numbers ?? [],
      registeredDentistId: r.registered_dentist_id,
      // Name the cases. Two dentists with one name are otherwise indistinguishable, and
      // the whole point of offering a suggestion is that it can be told apart from the
      // alternative.
      because:
        r.source === 'register'
          ? 'in the register of dentists'
          : `named on ${(r.prior_case_numbers ?? []).join(', ') || `${r.prior_cases} other case(s)`}`,
    }));
  }

  /**
   * Put a respondent on a case.
   *
   * Either `partyId` — the officer picked somebody the register already knows — or the
   * details of a new person. Nothing is merged on a name match; if the officer wants the
   * history joined up they pick from the suggestions, which is a decision they can see
   * themselves making.
   */
  async add(
    tx: Tx,
    ctx: EngineContext,
    input: AddRespondentInput,
  ): Promise<{ caseRespondentId: string; partyId: string; fullName: string }> {
    const caseRow = await tx.execute<{ id: string; state: string; closed_at: Date | null }>(
      sql`SELECT id, state::text, closed_at FROM case_file
          WHERE council_id = ${ctx.councilId}::uuid AND id = ${input.caseFileId}::uuid
            AND deleted_at IS NULL`,
    );
    if (!caseRow.rows[0]) throw new DomainError('That case is not in the register.');
    if (caseRow.rows[0].closed_at) {
      throw new ConflictError(
        'That case is closed. Reopen it before naming another dentist on it — a notice ' +
          'cannot be issued on a closed case, so adding a respondent to one would create a ' +
          'respondent nothing can ever be done about.',
      );
    }

    const role: PartyRole = input.isEstablishment
      ? 'respondent_establishment'
      : 'respondent_dentist';

    const partyId = input.partyId
      ? await this.useExisting(tx, ctx, input.partyId)
      : await this.createParty(tx, ctx, input);

    // Already on this case in this role. The unique index would catch it, but a constraint
    // violation is not an answer the officer can act on.
    const already = await tx.execute<{ id: string; dropped_at: Date | null }>(sql`
      SELECT cr.id, cr.dropped_at
      FROM case_respondent cr JOIN case_party cp ON cp.id = cr.case_party_id
      WHERE cr.case_file_id = ${input.caseFileId}::uuid AND cp.party_id = ${partyId}::uuid
    `);
    if (already.rows[0]) {
      throw new ConflictError(
        already.rows[0].dropped_at
          ? 'That dentist was named on this case and then dropped. The record of that stays; ' +
            'if they should be back on it, that is a decision to record rather than to repeat.'
          : 'That dentist is already named on this case.',
      );
    }

    const casePartyId = randomUUID();
    await tx.execute(sql`
      INSERT INTO case_party (id, council_id, case_file_id, party_id, role, note)
      VALUES (${casePartyId}::uuid, ${ctx.councilId}::uuid, ${input.caseFileId}::uuid,
              ${partyId}::uuid, ${role}::party_role, ${input.note ?? null})
    `);

    const caseRespondentId = randomUUID();
    await tx.execute(sql`
      INSERT INTO case_respondent (id, council_id, case_file_id, case_party_id)
      VALUES (${caseRespondentId}::uuid, ${ctx.councilId}::uuid, ${input.caseFileId}::uuid,
              ${casePartyId}::uuid)
    `);

    const name = await tx.execute<{ full_name: string }>(
      sql`SELECT full_name FROM party WHERE id = ${partyId}::uuid`,
    );

    // Deliberately no follow-up and no state change. Naming a dentist is not serving them:
    // the case moves to awaiting_respondent_reply when a notice is DESPATCHED and the
    // officer confirms it, and the ladder starts from that confirmation. Opening a chase
    // here would start a clock against a dentist who has not been written to.
    this.log.log(`respondent ${name.rows[0]?.full_name} added to ${input.caseFileId}`);

    return {
      caseRespondentId,
      partyId,
      fullName: name.rows[0]?.full_name ?? '',
    };
  }

  /** Reuse a person the register already holds, after checking they are ours. */
  private async useExisting(tx: Tx, ctx: EngineContext, partyId: string): Promise<string> {
    const found = await tx.execute<{ id: string }>(
      sql`SELECT id FROM party WHERE council_id = ${ctx.councilId}::uuid AND id = ${partyId}::uuid`,
    );
    if (!found.rows[0]) throw new DomainError('That person is not in the register.');
    return partyId;
  }

  /**
   * A person the register has not met.
   *
   * The registration number is the one field worth chasing: it is unique in the Council's
   * own register, so recording it now is what lets this party be joined to the register of
   * dentists when that import lands, without anybody re-typing anything.
   *
   * The email address matters more than it looks. Intake only ever captures one for the
   * complainant, which is why a dentist's reply arriving in the inward tray can never be
   * matched to their case by sender — recording it here is what fixes that.
   */
  private async createParty(
    tx: Tx,
    ctx: EngineContext,
    input: AddRespondentInput,
  ): Promise<string> {
    const fullName = input.fullName?.trim();
    if (!fullName) {
      throw new DomainError('The dentist’s name is needed. It goes on the notice.');
    }

    // A registration number IS unique in the register, so the same number is the same
    // dentist - the one case where joining two records is a fact rather than a guess.
    const registrationNo = input.registrationNo?.trim() || null;
    let registeredDentistId: string | null = null;
    if (registrationNo) {
      const rd = await tx.execute<{ id: string }>(sql`
        SELECT id FROM registered_dentist
        WHERE council_id = ${ctx.councilId}::uuid AND registration_no = ${registrationNo}
      `);
      registeredDentistId = rd.rows[0]?.id ?? null;

      const clash = await tx.execute<{ id: string; full_name: string }>(sql`
        SELECT p.id, p.full_name FROM party p
        JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
        WHERE p.council_id = ${ctx.councilId}::uuid AND rd.registration_no = ${registrationNo}
        LIMIT 1
      `);
      if (clash.rows[0]) {
        throw new ConflictError(
          `Registration number ${registrationNo} is already held by ${clash.rows[0].full_name} ` +
            'in this register. Pick them from the suggestions rather than creating a second ' +
            'record for the same dentist.',
        );
      }
    }

    const partyId = randomUUID();
    await tx.execute(sql`
      INSERT INTO party (id, council_id, kind, full_name, mobile, mobile_normalised, email,
                         address_lines, registered_dentist_id)
      VALUES (${partyId}::uuid, ${ctx.councilId}::uuid,
              ${input.isEstablishment ? 'organisation' : 'person'}::party_kind,
              ${fullName}, ${input.mobile?.trim() || null},
              -- Digits only, the same normalisation intake uses, so a caller can be matched
              -- against this party however the number was typed.
              ${input.mobile ? input.mobile.replace(/\D/g, '') : null},
              ${input.email?.trim().toLowerCase() || null},
              ${JSON.stringify(input.addressLines ?? [])}::jsonb,
              ${registeredDentistId}::uuid)
    `);

    // The clinic is a property of the dentist in the register rather than of the party, so
    // there is nowhere to put it on a party row. Recorded on the case_party note until the
    // registry import gives it a home; losing it entirely would be worse.
    if (input.clinicName?.trim() && !registeredDentistId) {
      input.note = [input.note, `Clinic: ${input.clinicName.trim()}`]
        .filter(Boolean)
        .join(' — ');
    }

    return partyId;
  }
}
