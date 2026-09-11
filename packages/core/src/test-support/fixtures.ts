import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';

/**
 * Fixtures for the API integration tests.
 *
 * These insert REAL rows rather than random UUIDs. Foreign keys, check constraints and
 * row-level security are the parts of this system most worth exercising, and a test that
 * hands the database a UUID pointing at nothing exercises none of them.
 */

export async function seedCouncilAndOfficer(
  tx: Tx,
  args: { councilId: string; officerId: string; code: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO council (id, code, name, address_lines, official_email, registrar_name, is_synthetic)
    VALUES (${args.councilId}::uuid, ${args.code}, ${`${args.code} test council`}, '[]'::jsonb,
            ${`registrar@${args.code.toLowerCase()}.test`}, 'Test Registrar', true)
    ON CONFLICT (id) DO NOTHING
  `);

  // app_user is deliberately global (no council_id), so it carries no RLS policy.
  await tx.execute(sql`
    INSERT INTO app_user (id, email, full_name)
    VALUES (${args.officerId}::uuid, ${`officer@${args.code.toLowerCase()}.test`}, 'Test Officer')
    ON CONFLICT (id) DO NOTHING
  `);

  await tx.execute(sql`
    INSERT INTO council_membership (council_id, app_user_id, role, starts_on)
    VALUES (${args.councilId}::uuid, ${args.officerId}::uuid, 'officer'::council_role, '2026-04-01')
    ON CONFLICT DO NOTHING
  `);
}

export async function makeCaseFile(
  tx: Tx,
  args: {
    councilId: string;
    serial: number;
    state?: string;
    councilCode?: string;
    waitingSince?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const code = args.councilCode ?? 'TEST';
  const state = args.state ?? 'under_scrutiny';
  await tx.execute(sql`
    INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no,
                           state, summary, waiting_since)
    VALUES (${id}::uuid, ${args.councilId}::uuid,
            ${`${code}/COMP/2026-27/${String(args.serial).padStart(4, '0')}`}, '2026-27',
            ${args.serial}, ${state}::case_state, 'test case',
            ${args.waitingSince ?? '2026-08-01T00:00:00Z'}::timestamptz)
  `);
  return id;
}

/** A respondent dentist attached to a case: party -> case_party -> case_respondent. */
export async function makeRespondent(
  tx: Tx,
  args: { councilId: string; caseFileId: string; name?: string },
): Promise<{ partyId: string; casePartyId: string; caseRespondentId: string }> {
  const partyId = crypto.randomUUID();
  const casePartyId = crypto.randomUUID();
  const caseRespondentId = crypto.randomUUID();

  await tx.execute(sql`
    INSERT INTO party (id, council_id, kind, full_name)
    VALUES (${partyId}::uuid, ${args.councilId}::uuid, 'person'::party_kind,
            ${args.name ?? 'Dr Test Respondent'})
  `);
  await tx.execute(sql`
    INSERT INTO case_party (id, council_id, case_file_id, party_id, role)
    VALUES (${casePartyId}::uuid, ${args.councilId}::uuid, ${args.caseFileId}::uuid,
            ${partyId}::uuid, 'respondent_dentist'::party_role)
  `);
  await tx.execute(sql`
    INSERT INTO case_respondent (id, council_id, case_file_id, case_party_id)
    VALUES (${caseRespondentId}::uuid, ${args.councilId}::uuid, ${args.caseFileId}::uuid,
            ${casePartyId}::uuid)
  `);

  return { partyId, casePartyId, caseRespondentId };
}
