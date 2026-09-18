import { logger } from '@librechat/data-schemas';

/**
 * Characters codeapi keeps verbatim in a sandbox path; everything else becomes `_` when the file
 * is written. Mirrors `isSafeCodeEnvFilepath` in `files/code/form.ts` — the two must agree, or a
 * name we consider distinct will collide once written.
 */
const SAFE_DESTINATION_CHAR = /[a-zA-Z0-9._\-/]/;

/**
 * The path a file ends up at inside the sandbox. A space in "Office Order.pdf" becomes `_`, so
 * the raw name and the name codeapi echoes back after the first call are two spellings of one
 * destination.
 */
export function sandboxDestination(name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    return '';
  }
  return Array.from(name, (char) => (SAFE_DESTINATION_CHAR.test(char) ? char : '_')).join('');
}

interface InjectedFileRef {
  id?: unknown;
  name?: unknown;
  storage_session_id?: unknown;
}

/**
 * One file per destination, because codeapi rejects the entire execution when two inputs resolve
 * to the same path ("Conflicting input destinations") — nothing runs, whatever the code was.
 *
 * Two spellings of one destination reach this point routinely. The seeded entry carries the
 * user's filename; after the first tool call the sandbox echoes its own sanitized name back into
 * the session, and both survive the SDK's merge because it compares names literally. A file whose
 * name is already path-safe never produced two spellings, which is why this only ever broke
 * uploads with spaces or other unsafe characters in the name.
 *
 * First seen wins: the session's own ordering puts the established entry first, and the duplicate
 * carries no information the first does not — same object, same bytes.
 */
export function dedupeInjectedFiles<T extends InjectedFileRef>(files: T[]): T[] {
  if (files.length < 2) {
    return files;
  }

  const claimed = new Map<string, T>();
  const kept: T[] = [];
  for (const file of files) {
    const destination = sandboxDestination(file.name);
    if (destination === '') {
      kept.push(file);
      continue;
    }
    const owner = claimed.get(destination);
    if (owner) {
      logger.debug(
        `[injectedFiles] "${String(file.name)}" and "${String(owner.name)}" both write to ` +
          `"${destination}"; sending the first only`,
      );
      continue;
    }
    claimed.set(destination, file);
    kept.push(file);
  }
  return kept;
}
