/**
 * Whether a generated file is working material rather than a deliverable.
 *
 * A deliverable is written to the top of `/mnt/data`; working material lives in a
 * subdirectory. That is how these tools already behave — a deck is saved as
 * `/mnt/data/deck.pptx`, while renders, unpacked OOXML trees, intermediate PDFs
 * and contact sheets all go in a directory of their own — so the depth of the
 * path is the signal, and nothing has to be agreed between the skills and here.
 *
 * Naming a scratch directory instead was tried and does not hold. Each version
 * of the rule named the activity it had seen — put renders in `.render`, use the
 * bundled grid, keep it under `qa/` — and the next run found an activity the
 * rule did not name: an invented `renderqa/`, a hand-rolled montage, a relative
 * prefix, a deliberate `cp` back out, and finally unzipping a deck into `work/`
 * and `work2/`, which shipped twenty-seven slide XML parts to the user. A rule
 * that enumerates cannot keep up with a model that improvises; one that asks a
 * structural question does not have to.
 *
 * These files are still persisted and re-injected, so the model can write a
 * render on one call and read it back on the next. Only the attachment is
 * withheld. The two are separable here and nowhere else: codeapi has to collect
 * a file for it to survive the call, because the persistent session workspace is
 * a Lambda MicroVM feature and this runner is the stateless HTTP one.
 *
 * The cost is a deliverable the user asked to be filed in a folder, which is not
 * something this pipeline produces — generated files are delivered individually,
 * with no notion of a folder to download.
 */
export function isSandboxWorkingFile(name: unknown): boolean {
  return typeof name === 'string' && name.includes('/');
}

/**
 * Where the skills put working material. No longer load-bearing — anything in a
 * subdirectory is treated the same — but kept so the skills name one directory
 * rather than inventing a fresh one per run, which keeps the sandbox tidy and
 * makes an accumulating scratch tree easy to clear.
 */
export const SANDBOX_WORKING_DIR = 'qa';

/**
 * codeapi's empty-directory sentinel.
 *
 * Unzipping a document creates empty directories (`ppt/media/`, `ppt/embeddings/`),
 * and codeapi preserves them by emitting a zero-byte `.dirkeep` marker in each —
 * infrastructure of its own, not something the run produced. Persisting them as
 * artifacts re-injects them by id on the next call, and the sandbox's download of
 * a marker under the user's session key answers 403, which fails the whole
 * execution: seven straight `sandbox_execution_failed` on an edit turn, from a
 * file nobody asked for.
 *
 * Matched on the raw name codeapi reports, before LibreChat's own sanitisation
 * turns the leading dot into `_.dirkeep-<hash>`.
 */
const DIRKEEP_BASENAME = '.dirkeep';

export function isSandboxDirkeep(name: unknown): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  const slash = name.lastIndexOf('/');
  return (slash < 0 ? name : name.slice(slash + 1)) === DIRKEEP_BASENAME;
}
