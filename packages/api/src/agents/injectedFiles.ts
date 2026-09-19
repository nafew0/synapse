import { logger } from '@librechat/data-schemas';

/**
 * The path a file ends up at inside the sandbox.
 *
 * codeapi mounts a file at its name verbatim: it checks length, nesting depth, absoluteness and
 * traversal, and rewrites nothing (`api/src/validation.ts`). The upload path replaces only control
 * characters (`getSafeCodeEnvFilename` in `files/code/form.ts`), so that is the whole of the
 * normalisation, and this must not invent more.
 *
 * Treating a wider set as unsafe is not a harmless over-approximation: "Office Order.pdf" and
 * "Office_Order.pdf" are two distinct files in the sandbox, and folding them together drops one
 * that the model then cannot open — "No such file or directory" for a file it was just handed.
 */
export function sandboxDestination(name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    return '';
  }
  return Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? '_' : char;
  }).join('');
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
 * The same object routinely arrives twice — seeded from the conversation and returned again by
 * the sandbox after a write — and both survive the SDK's merge because it compares names
 * literally.
 *
 * codeapi refuses a path that is equal to, inside, or the parent of one another input already
 * claims, so all three are treated as collisions here. That is not hypothetical: skill files mount
 * under `skills/<name>/…`, so an upload named `skills` would take the directory the skills need.
 *
 * First seen wins: the session's own ordering puts the established entry first, and the duplicate
 * carries no information the first does not — same object, same bytes. For a prefix collision that
 * ordering matters — skill files are seeded before a run's own attachments, so the skill tree keeps
 * its directory and the single upload that collided with it is what gets dropped.
 *
 * Two entries for one stored object collide even when their names differ. codeapi downloads a ref
 * by id and mounts it at the name its own egress returns, not at the name asked for, so the
 * sandbox's echo of an input comes back renamed — `527. Dr. …pdf` is re-offered as
 * `527._Dr._…pdf`. Both then resolve to that one destination and codeapi refuses the execution
 * against itself: "Conflicting input destinations: 527._Dr._…pdf and 527._Dr._…pdf". Names cannot
 * see that, so identity is checked first, by stored object rather than by path.
 */
export function dedupeInjectedFiles<T extends InjectedFileRef>(files: T[]): T[] {
  if (files.length < 2) {
    return files;
  }

  /**
   * `claimed` holds the destinations already taken; `ancestors` holds every directory those
   * destinations sit under. Together they answer codeapi's question — is this path equal to,
   * inside, or the parent of one already claimed — in a couple of lookups rather than a scan of
   * everything claimed so far, which matters because a run primes every file of every skill.
   */
  const claimed = new Map<string, T>();
  const ancestors = new Map<string, T>();
  /** The stored objects already sent, keyed by what codeapi resolves a ref with. */
  const mounted = new Map<string, T>();
  const kept: T[] = [];

  const reference = (file: T): string => {
    if (typeof file.id !== 'string' || file.id === '') {
      return '';
    }
    const session = typeof file.storage_session_id === 'string' ? file.storage_session_id : '';
    return `${session}\u0000${file.id}`;
  };

  const collision = (destination: string): T | undefined => {
    const exact = claimed.get(destination);
    if (exact) {
      return exact;
    }
    /** A file already claimed lives under this path, so mounting a file here would bury it. */
    const parentOfClaimed = ancestors.get(destination);
    if (parentOfClaimed) {
      return parentOfClaimed;
    }
    /** Or this path lives under a file already claimed. */
    let prefix = destination;
    for (let cut = prefix.lastIndexOf('/'); cut > 0; cut = prefix.lastIndexOf('/')) {
      prefix = prefix.slice(0, cut);
      const owner = claimed.get(prefix);
      if (owner) {
        return owner;
      }
    }
    return undefined;
  };

  for (const file of files) {
    const ref = reference(file);
    const alreadyMounted = ref === '' ? undefined : mounted.get(ref);
    if (alreadyMounted) {
      logger.debug(
        `[injectedFiles] "${String(file.name)}" is the same stored object as ` +
          `"${String(alreadyMounted.name)}"; sending the first only`,
      );
      continue;
    }
    const destination = sandboxDestination(file.name);
    if (destination === '') {
      if (ref !== '') {
        mounted.set(ref, file);
      }
      kept.push(file);
      continue;
    }
    const owner = collision(destination);
    if (owner) {
      logger.debug(
        `[injectedFiles] "${String(file.name)}" collides with "${String(owner.name)}" at ` +
          `"${destination}"; sending the first only`,
      );
      continue;
    }
    claimed.set(destination, file);
    if (ref !== '') {
      mounted.set(ref, file);
    }
    let prefix = destination;
    for (let cut = prefix.lastIndexOf('/'); cut > 0; cut = prefix.lastIndexOf('/')) {
      prefix = prefix.slice(0, cut);
      if (!ancestors.has(prefix)) {
        ancestors.set(prefix, file);
      }
    }
    kept.push(file);
  }
  return kept;
}
