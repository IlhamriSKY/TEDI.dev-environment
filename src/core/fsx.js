// Filesystem helpers over the gated `ctx.invoke` surface.
//
// Two host behaviours shape everything here and are easy to get wrong:
//
//   `fs_create_dir` uses `create_dir_all` internally, so it IS recursive, but
//   it REFUSES when the path already exists. So "make sure this exists" is
//   create-and-swallow, never a bare create.
//
//   `fs_rename` refuses to overwrite an existing target. So "replace this
//   directory" is delete-then-rename, and the delete has to tolerate absence.
//
// `fs_write_file` takes a String and writes atomically, which means we can
// write configuration but never binary. Anything binary is a `curl` download
// straight to its destination.

import { ctx } from "../runtime.js";

/**
 * Create a directory and every parent, tolerating one that already exists.
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function mkdirp(path) {
  if (!path || !ctx) return;
  try {
    await ctx.invoke("fs_create_dir", { path });
  } catch (err) {
    // "already exists" is the success case; anything else is real.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
  }
}

/**
 * Does this path exist? Answered by trying to read its directory listing and
 * then by reading it as a file, because the host exposes no `stat`.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  if (!path || !ctx) return false;
  try {
    await ctx.invoke("fs_canonicalize", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this an existing directory? `fs_read_dir` succeeds only on directories.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function isDir(path) {
  if (!path || !ctx) return false;
  try {
    await ctx.invoke("fs_read_dir", { path, includeHidden: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file as text. Returns null when absent, unreadable, or not text -
 * a caller asking for a config file does not want to distinguish those, and
 * every one of them means "there is nothing to parse".
 *
 * @param {string} path
 * @returns {Promise<string | null>}
 */
export async function readText(path) {
  if (!path || !ctx) return null;
  try {
    const res = await ctx.invoke("fs_read_file", { path });
    return res.kind === "text" ? res.content : null;
  } catch {
    return null;
  }
}

/**
 * Write text, creating the parent directory first. Atomic on the host side.
 * @param {string} path
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeText(path, content) {
  if (!ctx) throw new Error("extension is not active");
  const parent = path.replace(/[\\/][^\\/]*$/, "");
  if (parent && parent !== path) await mkdirp(parent);
  await ctx.invoke("fs_write_file", { path, content });
}

/**
 * Read and parse JSON, or `fallback` on any failure. Parse errors are
 * deliberately not thrown: a corrupt config must not stop the extension from
 * activating, or the user has no UI left to fix it with.
 *
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(path, fallback) {
  const text = await readText(path);
  if (text === null) return fallback;
  try {
    return /** @type {T} */ (JSON.parse(text));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON, pretty-printed so a human can read and hand-edit it.
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJson(path, value) {
  await writeText(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Immediate children of a directory. Empty when the directory does not exist,
 * which is the same thing as far as every caller is concerned.
 *
 * `kind` is `"file" | "dir" | "symlink"` - the host serialises `EntryKind`
 * lowercase.
 *
 * @param {string} path
 * @param {boolean} [includeHidden]
 * @returns {Promise<{ name: string, kind: "file" | "dir" | "symlink", size: number, mtime: number }[]>}
 */
export async function readDir(path, includeHidden = false) {
  if (!path || !ctx) return [];
  try {
    return await ctx.invoke("fs_read_dir", { path, includeHidden });
  } catch {
    return [];
  }
}

/** Names of the immediate SUBDIRECTORIES of `path`.
 *  @param {string} path @returns {Promise<string[]>} */
export async function subdirs(path) {
  const entries = await readDir(path, true);
  return entries.filter((e) => e.kind === "dir").map((e) => e.name);
}

/**
 * Delete a path, tolerating absence. Never throws for "not found", because
 * every caller is trying to reach a state, not perform an event.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function remove(path) {
  if (!path || !ctx) return;
  try {
    await ctx.invoke("fs_delete", { path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|no such file|cannot find/i.test(msg)) throw err;
  }
}

/**
 * Move `from` onto `to`, replacing whatever is there.
 *
 * The host refuses a rename onto an existing target, so the old target is
 * removed first. That leaves a window where neither exists; callers that
 * cannot afford it stage into a sibling directory and rename once, which is
 * what `manager/install.js` does.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function move(from, to) {
  if (!ctx) throw new Error("extension is not active");
  await remove(to);
  const parent = to.replace(/[\\/][^\\/]*$/, "");
  if (parent && parent !== to) await mkdirp(parent);
  await ctx.invoke("fs_rename", { from, to });
}

/**
 * The single child of `dir` when it has exactly one subdirectory and no files
 * worth keeping, else null.
 *
 * Almost every archive in this domain unpacks into one versioned folder
 * (`php-8.3.14-Win32-vs16-x64/`, `node-v22.11.0-win-x64/`), and callers want
 * the contents, not the wrapper. Detecting it beats hardcoding each project's
 * naming scheme, which changes between releases.
 *
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
export async function singleRoot(dir) {
  const entries = await readDir(dir, true);
  const dirs = entries.filter((e) => e.kind === "dir");
  const files = entries.filter((e) => e.kind !== "dir");
  if (dirs.length === 1 && files.length === 0) return dirs[0].name;
  return null;
}

/**
 * Ensure every directory in the list exists.
 * @param {string[]} dirs
 * @returns {Promise<void>}
 */
export async function ensureDirs(dirs) {
  for (const dir of dirs) await mkdirp(dir);
}
