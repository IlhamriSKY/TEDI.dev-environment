// php.ini: the settings a local developer actually changes, and the plumbing
// that makes an edit take effect.
//
// The file is EDITED, not regenerated. A generated php.ini would silently throw
// away anything the user added by hand, and people do add things by hand to
// php.ini. So a change rewrites only the directive it names: if the line exists
// (even commented out) it is replaced in place, and only a directive that
// appears nowhere is appended. That keeps comments, ordering, and every
// unrelated setting exactly as they were.
//
// A change takes effect on the next process. The CLI picks it up immediately
// because every `php` is a new process; FastCGI does not, because the pool is
// long-lived, so `applySettings` restarts the pool for that version. That is
// the whole of "hot reload" for PHP configuration.

import { paths, join } from "../core/paths.js";
import { readText, writeText, exists } from "../core/fsx.js";
import { resolveVersion } from "./versions.js";
import { reloadPhpPool } from "./services.js";

/** The settings the dashboard exposes, with what they mean and sane bounds.
 *  Anything not listed is still editable through the raw editor. */
export const COMMON_SETTINGS = /** @type {const} */ ([
  { key: "memory_limit", label: "Memory limit", hint: "e.g. 512M or -1 for no limit" },
  { key: "upload_max_filesize", label: "Max upload size", hint: "e.g. 128M" },
  { key: "post_max_size", label: "Max POST size", hint: "Should be >= max upload size" },
  { key: "max_execution_time", label: "Max execution time", hint: "Seconds; 0 means unlimited" },
  { key: "max_input_vars", label: "Max input vars", hint: "e.g. 5000" },
  { key: "display_errors", label: "Display errors", hint: "On or Off" },
  { key: "error_reporting", label: "Error reporting", hint: "e.g. E_ALL" },
  { key: "date.timezone", label: "Timezone", hint: "e.g. Asia/Jakarta" },
]);

/**
 * The php.ini path for a version, and whether it exists yet.
 *
 * @param {string} version
 * @returns {Promise<{ path: string, exists: boolean } | null>}
 */
export async function iniPathFor(version) {
  const row = resolveVersion("php", version);
  if (!row) return null;
  const path = paths.phpIni(row.binDir);
  return { path, exists: await exists(path) };
}

/**
 * Create php.ini from the distribution's development template on first use.
 *
 * A Windows PHP zip ships `php.ini-development` and `php.ini-production` and no
 * `php.ini` at all, which is why a fresh install has no timezone, no extension
 * directory, and every extension off. Seeding from the development template is
 * what makes the runtime usable, and it is the same thing every PHP setup guide
 * tells a person to do by hand.
 *
 * @param {string} version
 * @returns {Promise<boolean>} true when a file exists afterwards
 */
export async function ensureIni(version) {
  const info = await iniPathFor(version);
  if (!info) return false;
  if (info.exists) return true;

  const row = resolveVersion("php", version);
  if (!row) return false;

  for (const template of ["php.ini-development", "php.ini-production"]) {
    const source = await readText(join(row.dir, template));
    if (source === null) continue;
    await writeText(info.path, withDefaults(source, row.dir));
    return true;
  }

  // A static build ships no template. A minimal file is still better than none:
  // without it there is nowhere to put a setting.
  await writeText(info.path, withDefaults("", row.dir));
  return true;
}

/**
 * Our starting overrides on top of whatever template was found.
 *
 * `extension_dir` is the one that must be right or nothing else matters: PHP
 * resolves it relative to the current working directory when it is left as the
 * default `ext`, so a `php` run from a project folder looks for extensions
 * inside that project and finds none.
 *
 * @param {string} source @param {string} installDir
 * @returns {string}
 */
function withDefaults(source, installDir) {
  let out = source;
  const extDir = join(installDir, "ext");
  for (const [key, value] of /** @type {[string, string][]} */ ([
    ["extension_dir", extDir],
    ["memory_limit", "512M"],
    ["upload_max_filesize", "128M"],
    ["post_max_size", "128M"],
    ["max_execution_time", "300"],
    ["display_errors", "On"],
    ["date.timezone", "UTC"],
    // OPcache is turned on as a default extension (wave three). The stock
    // revalidation is every 2 seconds, which on a development machine is the
    // "I saved it and refreshed and nothing changed" bug; 0 checks the file's
    // timestamp on every request, which is what makes the speed safe to take.
    ["opcache.revalidate_freq", "0"],
  ])) {
    out = setDirective(out, key, value);
  }
  return out;
}

/**
 * Set one directive, replacing an existing line wherever it is.
 *
 * Matches a commented-out line too (`;memory_limit = 128M`), because that is
 * how every shipped php.ini expresses a default and a user looking for the
 * setting afterwards expects to find one line, not their new value plus the
 * commented original.
 *
 * Pure and exported: this is the function whose failure mode is a corrupted
 * php.ini, so it must be checkable on its own.
 *
 * @param {string} content @param {string} key @param {string} value
 * @returns {string}
 */
export function setDirective(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = `${key} = ${value}`;
  const re = new RegExp(`^[ \\t]*;?[ \\t]*${escaped}[ \\t]*=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  const body = content.replace(/\s*$/, "");
  return `${body}\n\n; Added by the TEDI Dev Environment extension.\n${line}\n`;
}

/**
 * Read one directive's effective value, or null.
 *
 * A commented line reads as null: it is not in effect, and reporting the
 * commented default as the current value is how a user ends up believing they
 * already changed something.
 *
 * @param {string} content @param {string} key
 * @returns {string | null}
 */
export function getDirective(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(.*)$`, "m");
  const m = content.match(re);
  if (!m) return null;
  return m[1].replace(/\s*;.*$/, "").trim();
}

/**
 * Current values of the common settings for a version.
 *
 * @param {string} version
 * @returns {Promise<Record<string, string | null>>}
 */
export async function readSettings(version) {
  const info = await iniPathFor(version);
  /** @type {Record<string, string | null>} */
  const out = {};
  if (!info) return out;
  const content = (await readText(info.path)) ?? "";
  for (const s of COMMON_SETTINGS) out[s.key] = getDirective(content, s.key);
  return out;
}

/**
 * Apply a batch of settings and make them live.
 *
 * "Live" is the whole point, and it takes two different things: the CLI needs
 * nothing (every `php` is a fresh process that re-reads the file) while the
 * FastCGI pool is long-lived and would keep serving the old configuration. So
 * the pool for this version is recycled, and only if one was already running.
 *
 * @param {string} version
 * @param {Record<string, string>} settings
 * @returns {Promise<void>}
 */
export async function applySettings(version, settings) {
  await ensureIni(version);
  const info = await iniPathFor(version);
  if (!info) throw new Error(`PHP ${version} is not installed.`);

  let content = (await readText(info.path)) ?? "";
  for (const [key, value] of Object.entries(settings)) {
    content = setDirective(content, key, value);
  }
  await writeText(info.path, content);
  await reloadPhpPool(version);
}

/** The raw file, for the "edit php.ini directly" view.
 *  @param {string} version @returns {Promise<string | null>} */
export async function readRaw(version) {
  const info = await iniPathFor(version);
  if (!info) return null;
  return await readText(info.path);
}

/** @param {string} version @param {string} content @returns {Promise<void>} */
export async function writeRaw(version, content) {
  const info = await iniPathFor(version);
  if (!info) throw new Error(`PHP ${version} is not installed.`);
  await writeText(info.path, content);
  await reloadPhpPool(version);
}
