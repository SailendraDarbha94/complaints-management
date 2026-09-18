/**
 * A Postgres `text[]` literal, as ONE bound parameter.
 *
 * Not `${array}::text[]`. Drizzle's sql tag expands a JavaScript array into a
 * comma-separated list of placeholders — which is exactly what `IN (...)` wants, and
 * exactly wrong for an array cast. One element becomes a bare scalar and Postgres answers
 * `malformed array literal`; several become a row constructor and it answers `cannot cast
 * type record to text[]`. Neither failure is subtle, but both happen at runtime rather
 * than at compile time, so they are found by whoever runs the query first.
 *
 * Building the literal here keeps it a single parameter, so the values are still bound
 * rather than interpolated into SQL — the quoting below protects the array syntax, not the
 * query.
 */
export function pgTextArray(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${quoted.join(',')}}`;
}
