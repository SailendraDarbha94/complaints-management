import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';

/**
 * Allocating a serial from one of the numbering series the software owns.
 *
 * `UPDATE ... RETURNING` inside the caller's transaction, so two concurrent intakes cannot
 * take the same number: the second waits on the row lock and gets the next one.
 *
 * This lives on its own because there are now two registers that draw on it - the
 * complaints register and the RTI register - and the numbering of a legal book is the last
 * thing that should exist in two slightly different copies. The office-wide OUTWARD
 * DESPATCH number is still not among them: that book is shared with certificates and
 * circulars issued by people who will never touch this software, so it is typed in after
 * the office stamps a letter rather than minted here.
 */
export async function allocateSerial(
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
