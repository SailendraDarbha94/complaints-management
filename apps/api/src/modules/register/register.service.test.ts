import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { RegisterService, csvCell } from './register.service.js';
import { makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The register and its export.
 *
 * The export is what an RTI reply is assembled from, what a court is shown, and the
 * artefact that means the book survives this project ending. The tests that matter are
 * the ones about what it must never hide.
 */

let db: Db;
const councilA = '90909090-9090-4909-8909-909090909090';
const councilB = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
const officerId = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const register = new RegisterService();
const ctx: EngineContext = { councilId: councilA, userId: officerId, config: KSDC_CONFIG };

const RECEIVED = new Date('2026-09-01T05:30:00Z');

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId: councilA }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId: councilA, officerId, code: 'REGA' }),
  );
  await withCouncil({ councilId: councilB }, (tx) =>
    seedCouncilAndOfficer(tx, {
      councilId: councilB,
      officerId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
      code: 'REGB',
    }),
  );
});

afterAll(async () => {
  await closeDb();
});

let serial = 0;
async function newCase(tx: Tx, summary = 'Crown came off within a week') {
  serial++;
  return intake.create(tx, ctx, {
    summary,
    receivedAt: RECEIVED,
    complainant: {
      fullName: 'Smt. Kavitha Devi',
      mobile: '9845012345',
      email: 'kdevi@example.in',
    },
    patient: { fullName: 'Smt. Kavitha Devi', ageYears: 54, sex: 'F' },
  });
}

describe('the register view', () => {
  it('gives one row per case with the columns the officer was promised', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const rows = await register.rows(tx, ctx);
      const row = rows.find((r) => r['Case No.'] === c.caseNumber)!;

      expect(row).toBeDefined();
      expect(row['Sl. No.']).toBe(c.registerSlNo);
      expect(row['Date received']).toBe('2026-09-01');
      expect(row['Category']).toBe('Patient Complaint');
      expect(row['Complainant']).toBe('Smt. Kavitha Devi');
      expect(row['Patient age/sex']).toBe('54 / F');
      expect(row['Nature of grievance']).toBe('Crown came off within a week');
      expect(row['Officer']).toBe('Test Officer');
      // The column the paper book could never have.
      expect(row['Waiting on']).toBe('council_officer');
      expect(Number(row['Days waiting'])).toBeGreaterThanOrEqual(0);
    });
  });

  it('lists every respondent, with their state', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const c = await newCase(tx, 'Chain clinic, two dentists');
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'MARK_COMPLETE_ON_ARRIVAL',
        occurredAt: RECEIVED,
      });
      const a = await makeRespondent(tx, {
        councilId: councilA,
        caseFileId: c.caseFileId,
        name: 'Dr A. Rao',
      });
      const b = await makeRespondent(tx, {
        councilId: councilA,
        caseFileId: c.caseFileId,
        name: 'Dr S. Kamath',
      });
      for (const r of [a, b]) {
        await lifecycle.apply(tx, ctx, {
          caseFileId: c.caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: r.caseRespondentId,
          occurredAt: RECEIVED,
          notice: { serviceMode: 'speed_post', sentAt: RECEIVED },
        });
      }
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'DECLARE_RESPONDENT_EX_PARTE',
        caseRespondentId: b.caseRespondentId,
        reason: 'Three notices served, no reply',
      });

      const rows = await register.rows(tx, ctx);
      const row = rows.find((r) => r['Case No.'] === c.caseNumber)!;
      expect(row['Respondent(s)']).toContain('Dr A. Rao');
      expect(row['Respondent(s)']).toContain('Dr S. Kamath [ex parte]');
      expect(row['Notice 1']).toContain('2026-09-01');
    });
  });

  it('records how long a case has been waiting, and stops counting once it closes', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'CLOSE',
        closureReason: 'withdrawn',
        reason: 'Complainant withdrew by phone',
      });

      const rows = await register.rows(tx, ctx);
      const row = rows.find((r) => r['Case No.'] === c.caseNumber)!;
      expect(row['Closure reason']).toBe('withdrawn');
      expect(row['Closed on']).toBeTruthy();
      // A closed case is not "waiting 400 days"; it is finished.
      expect(row['Days waiting']).toBeNull();
    });
  });

  it('names which dates were reconstructed rather than recorded', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const backfilled = await intake.create(tx, ctx, {
        summary: 'Backlog case from the book',
        receivedAt: new Date('2026-05-02T00:00:00Z'),
        dateSource: 'from_physical_register',
        isBackfilled: true,
        legacyRegisterRef: 'Book 4, page 22',
        complainant: { fullName: 'Sri R. Kumar' },
      });

      const rows = await register.rows(tx, ctx);
      const row = rows.find((r) => r['Case No.'] === backfilled.caseNumber)!;
      // A reconstructed date must never be indistinguishable from a recorded fact in an
      // RTI reply or a writ.
      expect(row['Entered from the book']).toBe(true);
      expect(row['Book reference']).toBe('Book 4, page 22');
      expect(row['Dates reconstructed']).toContain('received');
    });
  });
});

describe('row-level security through the view', () => {
  it('does not show one council another council’s register', async () => {
    // A view runs as its OWNER unless it declares security_invoker. This view joins
    // case_file, party, case_respondent and correspondence; without that declaration the
    // whole register would be readable across councils through a view whose name sounds
    // like a convenience.
    await withCouncil({ councilId: councilA, userId: officerId }, (tx) => newCase(tx));

    const fromA = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM v_case_register`),
    );
    const fromB = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM v_case_register`),
    );

    expect(fromA.rows[0]!.n).toBeGreaterThan(0);
    expect(fromB.rows[0]!.n).toBe(0);
  });

  it('shows nothing at all with no council scope', async () => {
    const unscoped = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM v_case_register`,
    );
    expect(unscoped.rows[0]!.n).toBe(0);
  });
});

describe('the CSV export', () => {
  it('quotes properly, so a comma in a name cannot shift every later column', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('Rao, A.')).toBe('"Rao, A."');
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
  });

  it('starts with a byte-order mark and uses CRLF, because Excel on Windows', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      await newCase(tx);
      const out = await register.csv(tx, ctx);
      // Without the BOM, Excel reads UTF-8 as the system codepage and a Kannada name
      // arrives as mojibake in a document that may be filed with a court.
      expect(out.content.charCodeAt(0)).toBe(0xfeff);
      expect(out.content).toContain('\r\n');
      expect(out.filename).toMatch(/^rega-register-\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });

  it('survives a name with a comma and a quotation mark', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Bridge failed, twice',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Rao, A. "Tony"' },
      });
      const out = await register.csv(tx, ctx);
      expect(out.content).toContain('"Rao, A. ""Tony"""');

      // Every data line must have the same number of fields as the header.
      const body = out.content.replace(/^﻿/, '').split('\r\n');
      const header = body[0]!;
      const expected = countFields(header);
      const dataLine = body.find((l) => l.includes(c.caseNumber))!;
      expect(countFields(dataLine)).toBe(expected);
    });
  });

  it('carries the provenance footnotes', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const out = await register.csv(tx, ctx);
      expect(out.content).toMatch(/reconstructed from the physical register/i);
      // Until the gated retirement in Phase 5, the book is still the record and the
      // export has to say so on its face.
      expect(out.content).toMatch(/physical register remains the legal record/i);
    });
  });

  it('leaves out the internal identifiers', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const out = await register.csv(tx, ctx);
      const header = out.content.replace(/^﻿/, '').split('\r\n')[0]!;
      expect(header).not.toContain('case_file_id');
      expect(header).not.toContain('council_id');
      expect(header).toContain('Sl. No.');
      expect(header).toContain('Waiting on');
    });
  });

  it('can be limited to one financial year', async () => {
    await withCouncil({ councilId: councilA, userId: officerId }, async (tx) => {
      const all = await register.csv(tx, ctx);
      const other = await register.csv(tx, ctx, { fiscalYear: '2019-20' });
      expect(all.rowCount).toBeGreaterThan(0);
      expect(other.rowCount).toBe(0);
      expect(other.filename).toContain('2019-20');
    });
  });
});

/** Counts RFC 4180 fields, respecting quoted commas. */
function countFields(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields++;
    }
  }
  return fields;
}
