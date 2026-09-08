// The shim directory's place on TEDI's terminal PATH.
//
// This used to READ `tedi-settings.json` off disk, because `ctx.settings`
// namespaces every key to `ext:<id>:<key>` and `terminalEnvPath` was not
// reachable through the sanctioned API in either direction. Writing it was
// deliberately not done at all: a raw `@tauri-apps/api` import bypasses the
// permission gate entirely, and silently editing a user's core preferences from
// an extension is exactly what that trust model warns about. The cost was one
// paste during setup, which is a step a user has to be told about and can get
// wrong.
//
// `ctx.terminal` (permission `terminal:path`) is the sanctioned way now. It is a
// gated, declared capability rather than a bypass: it can add THIS extension's
// folder, switch off entries that would shadow it, and undo exactly that - and
// the Settings row says which extension did it, with a switch the user can flip
// back.
//
// The file read stays as a FALLBACK, for a host that predates the API. It is
// still only ever a read: writing those preferences behind the gate's back is
// the thing `terminal:path` exists to make unnecessary.

import { ctx, isWindows, isMac } from "../runtime.js";
import { join, home, samePath } from "../core/paths.js";
import { readText } from "../core/fsx.js";

/** The tools the shim directory provides. Any other PATH entry that also
 *  provides one of these would shadow the managed runtimes - another stack's
 *  `bin\php` first on the PATH means `php` is never the version this extension
 *  was asked to select - so registering ours switches those off.
 *  @type {string[]} */
const SHIMMED_TOOLS = ["php", "node", "npm", "composer"];

/**
 * Does this host have the terminal-PATH API?
 *
 * Feature-detected rather than declared with `engines.tedi`, deliberately:
 * `HOST_FEATURES`' own comment says feature detection DEGRADES where an engine
 * bump EXCLUDES. Raising the engine would have locked this extension out of
 * every older TEDI to gain one button, and the fallback below - read the
 * setting, ask for a paste - is the behaviour those hosts already had.
 *
 * @returns {boolean}
 */
export function canRegisterPath() {
  return typeof ctx?.terminal?.registerPath === "function";
}

/**
 * Is the shim directory listed and enabled?
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function pathOnTerminal(dir) {
  const match = (/** @type {{path: string, enabled?: boolean}[]} */ entries) =>
    entries.some((e) => e.enabled !== false && samePath(e.path, dir));

  if (typeof ctx?.terminal?.listPaths === "function") {
    try {
      return match(ctx.terminal.listPaths());
    } catch {
      // The permission is declared, so this should not happen - but falling
      // through to the file leaves a recoverable setup step where a throw would
      // take the whole panel down.
    }
  }

  // Older host: read the settings file. Only ever READ - writing a user's core
  // preferences from an extension is what `terminal:path` exists to make
  // legitimate, and doing it behind the gate's back would be the thing that
  // permission was created to avoid.
  for (const candidate of settingsCandidates()) {
    const raw = await readText(candidate);
    if (raw === null) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entries = readEntries(parsed);
    if (entries !== null && match(entries)) return true;
  }
  return false;
}

/** TEDI's bundle identifiers: the release profile and the dev one, which use
 *  separate data directories and separate settings files. */
const BUNDLE_IDS = ["id.ilhamrisky.tedi", "id.ilhamrisky.tedi.dev"];

/**
 * Candidate settings files, in the order the platform would use. Mirrors what
 * the `dirs` crate resolves for `app_data_dir`, which is what TEDI itself uses.
 *
 * @returns {string[]}
 */
function settingsCandidates() {
  const h = home();
  if (!h) return [];
  /** @type {string[]} */
  const bases = [];
  if (isWindows()) bases.push(join(h, "AppData", "Roaming"));
  else if (isMac()) bases.push(join(h, "Library", "Application Support"));
  else bases.push(join(h, ".local", "share"), join(h, ".config"));

  /** @type {string[]} */
  const out = [];
  for (const base of bases) {
    for (const id of BUNDLE_IDS) out.push(join(base, id, "tedi-settings.json"));
  }
  return out;
}

/**
 * Pull `terminalEnvPath` out of the settings document. The host stores
 * `{ path, enabled }` objects but tolerates a bare string, so both are accepted
 * rather than assuming the normalised shape has already been written.
 *
 * @param {unknown} doc
 * @returns {{ path: string, enabled?: boolean }[] | null}
 */
function readEntries(doc) {
  if (!doc || typeof doc !== "object") return null;
  const value = /** @type {Record<string, unknown>} */ (doc).terminalEnvPath;
  if (!Array.isArray(value)) return null;
  /** @type {{ path: string, enabled?: boolean }[]} */
  const out = [];
  for (const item of value) {
    if (typeof item === "string") out.push({ path: item });
    else if (item && typeof item === "object") {
      const rec = /** @type {Record<string, unknown>} */ (item);
      if (typeof rec.path === "string")
        out.push({ path: rec.path, enabled: rec.enabled !== false });
    }
  }
  return out;
}

/**
 * Put the shim directory on the terminal PATH, switching off whatever would
 * shadow it.
 *
 * @param {string} dir
 * @returns {Promise<{ ok: boolean, disabled: string[], error?: string }>}
 */
export async function registerTerminalPath(dir) {
  try {
    const res = await ctx?.terminal?.registerPath(dir, { provides: SHIMMED_TOOLS });
    return { ok: Boolean(res?.added), disabled: res?.disabled ?? [] };
  } catch (err) {
    return { ok: false, disabled: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Move this extension's entry from one directory to another.
 *
 * Only used by the layout migration, and only when the OLD path was actually
 * registered: re-registering a PATH the user never asked for would be taking a
 * decision on their behalf under cover of a folder move.
 *
 * @param {string} from  The stale directory.
 * @param {string} to    Where the shims are now.
 * @returns {Promise<boolean>} whether the entry was moved
 */
export async function relocateTerminalPath(from, to) {
  if (!canRegisterPath()) return false;
  if (!(await pathOnTerminal(from))) return false;
  try {
    await ctx?.terminal?.unregisterPath(from);
    const res = await ctx?.terminal?.registerPath(to, { provides: SHIMMED_TOOLS });
    return Boolean(res?.added);
  } catch {
    // The row is still there pointing at a directory that has moved. The setup
    // checklist will show the step as outstanding, with the button that fixes
    // it, which is the same place a user would end up anyway.
    return false;
  }
}

/** Where the list lives, for a user who would rather look than press a button.
 *  @returns {string} */
export function pathInstruction() {
  return "Settings → Terminal → Additional PATH";
}
