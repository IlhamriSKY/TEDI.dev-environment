// Moving an existing environment onto the current layout.
//
// The root used to hold fifteen entries, nine of them machinery nobody opens.
// They live under `internal/` now, and an environment created before that
// change still has them at the top - so they are moved once, on activation,
// rather than left as a second layout the rest of the code would have to keep
// understanding forever.
//
// Two rules make this safe to run unattended:
//
//   1. It only ever moves a directory we generated and can regenerate. The
//      runtimes, the servers, the databases and `www/` are never touched, so the
//      worst case is a regenerated config and a re-issued certificate.
//   2. A destination that already exists is left ALONE rather than replaced.
//      That makes the whole thing idempotent, and it means a half-finished
//      previous run resumes instead of clobbering what it managed to move.
//
// The shim directory is the one with a consequence outside this folder: its old
// path is registered on TEDI's terminal PATH, and moving it would leave that
// entry pointing at nothing. So the caller is told whether the shims moved and
// re-registers.

import { paths, join } from "../core/paths.js";
import { exists, mkdirp, move } from "../core/fsx.js";
import { warn } from "../runtime.js";

/**
 * What moved into `internal/`, by its old name at the root.
 *
 * `global.env` is in the list and is a FILE, which works because `move` does not
 * care. It has to travel with the shims: both shim scripts read it as
 * `<self>/../global.env`, so it is the shim directory's parent that decides
 * where it lives, not us.
 */
const MOVED = [
  "cache",
  "downloads",
  "run",
  "temp",
  "tools",
  "shims",
  "certs",
  "conf",
  "global.env",
];

/**
 * Move anything still at the old location.
 *
 * @returns {Promise<{ moved: string[], shims: boolean }>}
 */
export async function migrateLayout() {
  const from = paths.root();
  const to = paths.internal();

  // Nothing to do for a root that does not exist yet, which is every fresh
  // install: `layoutDirs()` is about to create the current shape directly.
  if (!(await exists(from))) return { moved: [], shims: false };

  /** @type {string[]} */
  const moved = [];
  for (const name of MOVED) {
    const old = join(from, name);
    const next = join(to, name);
    try {
      if (!(await exists(old))) continue;
      // Already migrated. Leaving the stray copy rather than merging it is the
      // conservative half of the trade: a merge would have to decide which of
      // two files wins, and every one of these is regenerated anyway.
      if (await exists(next)) continue;
      await mkdirp(to);
      await move(old, next);
      moved.push(name);
    } catch (err) {
      // One directory that will not move must not stop the others, and must
      // not stop activation: everything here is regenerable, so the failure
      // costs a stale folder at the root rather than a broken environment.
      warn(`could not move ${name} into internal/`, err);
    }
  }

  return { moved, shims: moved.includes("shims") };
}

/** Where the shim directory used to be, for un-registering the stale terminal
 *  PATH entry that points at it.
 *  @returns {string} */
export function legacyShimDir() {
  return join(paths.root(), "shims");
}
