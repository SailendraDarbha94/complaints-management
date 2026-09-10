/**
 * Seeds a council and its configuration.
 *
 * Real KSDC values, but the council row is marked `is_synthetic` until the four
 * authorisation artefacts exist in docs/authorisation/. Until then the API refuses to
 * create a production case and the dashboard shows DEMO DATA — the legal register of a
 * statutory body must never end up in a personal cloud account by drift.
 *
 *   pnpm --filter @ksdc/db seed              # council + config only
 *   pnpm --filter @ksdc/db seed --demo       # plus a handful of example cases
 */
import { sql } from 'drizzle-orm';
import { createDb, withCouncil } from '../src/index.js';
import { KSDC_CONFIG, KSDC_COUNCIL, KSDC_TEMPLATES } from '@ksdc/config';
import { isMainModule } from './is-main.js';

const COUNCIL_ID = '0197f9c2-0000-4000-8000-000000000001';
const OFFICER_ID = '0197f9c2-0000-4000-8000-000000000002';
const OFFICER_EMAIL = process.env.SEED_OFFICER_EMAIL ?? 'officer@ksdc.in';

export async function seed(connectionString: string, withDemo = false): Promise<void> {
  const { db, close } = createDb({ connectionString });

  try {
    // The council row itself is written outside a council scope, because the scope does
    // not exist until the row does. Everything after this goes through withCouncil().
    await db.execute(sql`
      INSERT INTO council (id, code, name, address_lines, phone, website, official_email,
                           registrar_name, registrar_title, president_title, timezone, is_synthetic)
      VALUES (${COUNCIL_ID}::uuid, ${KSDC_COUNCIL.code}, ${KSDC_COUNCIL.name},
              ${JSON.stringify(KSDC_COUNCIL.addressLines)}::jsonb, ${KSDC_COUNCIL.phone},
              ${KSDC_COUNCIL.website}, ${KSDC_COUNCIL.officialEmail}, ${KSDC_COUNCIL.registrarName},
              ${KSDC_COUNCIL.registrarTitle}, ${KSDC_COUNCIL.presidentTitle},
              ${KSDC_COUNCIL.timezone}, true)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    `);

    await db.execute(sql`
      INSERT INTO council_config (council_id, config)
      VALUES (${COUNCIL_ID}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
      ON CONFLICT (council_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
    `);

    await db.execute(sql`
      INSERT INTO app_user (id, email, full_name)
      VALUES (${OFFICER_ID}::uuid, ${OFFICER_EMAIL}, 'Dental Officer')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO council_membership (council_id, app_user_id, role, starts_on)
      VALUES (${COUNCIL_ID}::uuid, ${OFFICER_ID}::uuid, 'officer'::council_role, '2026-04-01')
      ON CONFLICT DO NOTHING
    `);

    // The Registrar and the President never log in. They exist so letters carry the right
    // name and decisions are attributable.
    for (const [office, name] of [
      ['registrar', KSDC_COUNCIL.registrarName],
      ['president', 'The President'],
    ] as const) {
      // `db` is passed explicitly: withCouncil otherwise falls back to the process-wide
      // singleton, which needs DATABASE_URL - and the seeder is given its connection.
      await withCouncil(
        { councilId: COUNCIL_ID },
        (tx) =>
          tx.execute(sql`
            INSERT INTO council_office_holder (council_id, office, full_name, starts_on)
            VALUES (${COUNCIL_ID}::uuid, ${office}, ${name}, '2026-04-01')
            ON CONFLICT DO NOTHING
          `),
        db,
      );
    }

    // The letter catalogue. Never overwritten: once the officer has edited a letter, the
    // shipped wording is not the council's wording any more.
    let templates = 0;
    for (const t of KSDC_TEMPLATES) {
      const inserted = await withCouncil(
        { councilId: COUNCIL_ID },
        async (tx) => {
          const existing = await tx.execute(sql`
            SELECT id FROM template
            WHERE council_id = ${COUNCIL_ID}::uuid AND kind = ${t.kind}::correspondence_kind
          `);
          if (existing.rows.length > 0) return 0;

          const template = await tx.execute<{ id: string }>(sql`
            INSERT INTO template (council_id, kind, name, is_system, requires_registrar_signature)
            VALUES (${COUNCIL_ID}::uuid, ${t.kind}::correspondence_kind, ${t.name},
                    ${t.isSystem}, ${t.requiresRegistrarSignature})
            RETURNING id
          `);
          const version = await tx.execute<{ id: string }>(sql`
            INSERT INTO template_version (council_id, template_id, version_no, subject_tpl,
                                          body, published_at)
            VALUES (${COUNCIL_ID}::uuid, ${template.rows[0]!.id}::uuid, 1, ${t.subject},
                    ${t.body}, now())
            RETURNING id
          `);
          await tx.execute(sql`
            UPDATE template SET current_version_id = ${version.rows[0]!.id}::uuid
            WHERE id = ${template.rows[0]!.id}::uuid
          `);
          return 1;
        },
        db,
      );
      templates += inserted;
    }
    if (templates > 0) console.log(`  ${templates} letter template(s) installed`);

    console.log(`  council ${KSDC_COUNCIL.code} seeded (synthetic — not authorised for real data)`);
    console.log(`  officer ${OFFICER_EMAIL}`);
    console.log('');
    console.log('  Sign in at the web app with that address. There is no password: the API');
    console.log('  emails a six-digit code, and in development that means it is printed in');
    console.log('  the API log and appended to apps/api/var/mail/outbox.log.');

    if (withDemo) {
      // Demo cases are created by apps/api's demo script, through the real services, so
      // the example data has the same follow-ups and history that real data would.
      console.log('\n  For example cases: pnpm --filter @ksdc/api demo');
    }
  } finally {
    await close();
  }
}

if (isMainModule(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seed(url, process.argv.includes('--demo'))
    .then(() => console.log('\n✓ seed complete'))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

export { COUNCIL_ID, OFFICER_ID };
