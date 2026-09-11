/**
 * A logger, in twenty lines.
 *
 * This replaces Nest's, and keeps its shape - `new Logger('name')` with .log/.warn/.error -
 * so that every call site in the core package is unchanged. Cloud Run reads stdout and
 * stderr; anything written here lands in Cloud Logging without a shipper.
 *
 * Errors go to stderr so that a log-based alert can key on the stream rather than on a
 * string match. Everything is one line, prefixed with the context, because a multi-line
 * entry becomes several unrelated entries by the time it reaches a log viewer.
 */
export class Logger {
  constructor(private readonly context: string) {}

  log(message: string): void {
    process.stdout.write(this.format('LOG', message));
  }

  warn(message: string): void {
    process.stdout.write(this.format('WARN', message));
  }

  error(message: string): void {
    process.stderr.write(this.format('ERROR', message));
  }

  private format(level: string, message: string): string {
    return `${level.padEnd(5)} [${this.context}] ${message.replace(/\n/g, '\\n')}\n`;
  }
}
