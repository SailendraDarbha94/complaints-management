import type { Config } from 'drizzle-kit';

export default {
  // drizzle-kit resolves via CJS and cannot follow NodeNext '.js' specifiers in TS source,
  // so it reads the compiled schema instead. `pnpm generate` builds first.
  schema: './dist/src/schema/index.js',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://ksdc:ksdc@localhost:5432/ksdc_dev',
  },
  // Migrations are checked-in SQL. Row-level security, the audit chain and the grants are
  // hand-written files that drizzle-kit does not generate — see migrations/README.md.
  verbose: true,
  strict: true,
} satisfies Config;
