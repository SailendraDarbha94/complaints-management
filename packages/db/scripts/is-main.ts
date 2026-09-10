import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` is the script node was invoked with.
 *
 * Comparing `import.meta.url` against a hand-built `file://` string does not work:
 * `import.meta.url` uses three slashes and encodes the drive letter, so on Windows the
 * comparison is always false and the CLI entry point silently does nothing.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}
