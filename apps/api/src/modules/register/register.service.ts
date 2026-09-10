import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';
import { todayIn } from '../../common/working-days.js';

/**
 * The register, and getting it out of the building.
 *
 * The export matters more than it looks. It is what an RTI reply is assembled from, what
 * a court is shown, and — per the build plan's §12 — the artefact that means the register
 * survives this project ending: any competent person with a laptop can rebuild the book
 * from a CSV and a manifest.
 *
 * So it is deliberately plain. No formulas, no merged cells, no formatting that depends
 * on the software that wrote it.
 */

export interface RegisterRow {
  [column: string]: string | number | null;
}

@Injectable()
export class RegisterService {
  async rows(
    tx: Tx,
    _ctx: EngineContext,
    opts: { fiscalYear?: string; includeClosed?: boolean } = {},
  ): Promise<RegisterRow[]> {
    const result = await tx.execute<RegisterRow>(sql`
      SELECT r.* FROM v_case_register r
      JOIN case_file c ON c.id = r.case_file_id
      WHERE (${opts.fiscalYear ?? null}::text IS NULL OR c.fiscal_year = ${opts.fiscalYear ?? null})
        AND (${opts.includeClosed ?? true}::boolean OR c.state <> 'closed')
      ORDER BY r."Sl. No."
    `);
    return result.rows;
  }

  /**
   * The register as CSV.
   *
   * RFC 4180 quoting, a UTF-8 BOM, and CRLF line endings — all three because the officer
   * will open this in Excel on Windows. Without the BOM, Excel reads UTF-8 as the system
   * codepage and a Kannada name arrives as mojibake in a document that may be filed with
   * a court.
   */
  async csv(
    tx: Tx,
    ctx: EngineContext,
    opts: { fiscalYear?: string; includeClosed?: boolean } = {},
  ): Promise<{ filename: string; content: string; rowCount: number }> {
    const rows = await this.rows(tx, ctx, opts);
    const today = todayIn(ctx.config.calendar.timezone);

    const council = await tx.execute<{ code: string; name: string; retired: Date | null }>(sql`
      SELECT code, name, physical_register_retired_at AS retired
      FROM council WHERE id = ${ctx.councilId}::uuid
    `);
    const { code, name, retired } = council.rows[0] ?? {
      code: 'KSDC',
      name: 'the council',
      retired: null,
    };

    // Internal identifiers are not part of the register; the officer never needs them and
    // they make the sheet harder to read.
    const columns = rows.length
      ? Object.keys(rows[0]!).filter((k) => k !== 'case_file_id' && k !== 'council_id')
      : [];

    const lines: string[] = [];
    lines.push(columns.map(csvCell).join(','));
    for (const row of rows) {
      lines.push(columns.map((c) => csvCell(row[c])).join(','));
    }

    // The footnotes. A reconstructed date must never read as a recorded fact, and a
    // reader three years from now will not know to ask.
    const reconstructed = rows.filter((r) => r['Dates reconstructed']).length;
    lines.push('');
    lines.push(csvCell(`${name} - complaints register`));
    lines.push(csvCell(`Exported ${today}. ${rows.length} case(s).`));
    if (reconstructed > 0) {
      lines.push(
        csvCell(
          `${reconstructed} case(s) carry dates that were reconstructed from the physical ` +
            'register or estimated, rather than recorded as they happened. The "Dates ' +
            'reconstructed" column names which.',
        ),
      );
    }
    lines.push(
      csvCell(
        retired
          ? `The physical register was retired on ${new Date(retired).toISOString().slice(0, 10)}. ` +
              'This export is the record.'
          : 'The physical register remains the legal record. This export is a copy of it.',
      ),
    );

    const suffix = opts.fiscalYear ? `-${opts.fiscalYear}` : '';
    return {
      filename: `${code.toLowerCase()}-register${suffix}-${today}.csv`,
      // U+FEFF, then CRLF throughout: Excel on Windows.
      content: '﻿' + lines.join('\r\n') + '\r\n',
      rowCount: rows.length,
    };
  }
}

/** RFC 4180: quote when the value contains a comma, a quote or a line break. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
