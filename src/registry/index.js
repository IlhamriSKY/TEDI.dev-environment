// The provider registry: what can be managed, and where each thing comes from.
//
// Every version, URL and filename in this layer is resolved at runtime from an
// upstream index. Nothing downstream of here knows that PHP comes from
// windows.php.net on one platform and dl.static-php.dev on another, or that
// Apache on Windows carries a build date in its filename. A provider answers
// three questions and the rest of the extension only ever asks those.
//
// `download()` returning `null` is a first-class answer meaning "this project
// publishes no build for this platform". It is not an error and must not be
// treated as one: on macOS and Linux it is the NORMAL answer for several of
// these, and the UI then offers the detected system install or names the
// package-manager command instead of downloading something that cannot work.

/**
 * @typedef {object} VersionInfo
 * @property {string} version
 * @property {string} [channel]      "stable" | "lts" | "preview" | "eol"
 * @property {string} [released]     Human date, as upstream states it.
 * @property {boolean} [recommended] Pre-selected in the picker.
 */

/**
 * @typedef {object} Download
 * @property {string} url
 * @property {string} file           Filename to save as; drives the unpacker.
 * @property {string} [note]         Shown in the UI, e.g. "non-thread-safe".
 */

/**
 * @typedef {object} Layout
 * @property {string} binDir         Directory holding the executables.
 * @property {string} exe            Primary executable, absolute.
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {"runtime" | "server" | "service" | "tool"} kind
 * @property {boolean} multiVersion  Can several versions coexist and be switched?
 * @property {string} [blurb]        One line for the dashboard card.
 * @property {() => Promise<VersionInfo[]>} versions
 * @property {(version: string) => Promise<Download | null>} download
 * @property {(version: string) => Promise<Download[]>} [extras]  Further archives
 *   unpacked into the same install directory, for projects that split one
 *   release across several files (PHP ships cli and fpm separately off Windows).
 * @property {(version: string) => Promise<Layout>} layout
 * @property {string[]} [systemBin]  Executable names to look for on PATH.
 * @property {string} [packageHint]  What to tell the user when nothing is available.
 * @property {number} [defaultPort]
 */

import { php } from "./php.js";
import { node } from "./node.js";
import { composer } from "./composer.js";
import { mysql, postgres } from "./db.js";
import { redis } from "./redis.js";
import { nginx, apache } from "./servers.js";
import { mkcert } from "./mkcert.js";

/** Dashboard order: what you set up first comes first.
 *  @type {Provider[]} */
const ALL = [php, node, composer, nginx, apache, mysql, postgres, redis, mkcert];

/** @type {Map<string, Provider>} */
const BY_ID = new Map(ALL.map((p) => [p.id, p]));

/** Every provider, in dashboard order. @returns {Provider[]} */
export function providers() {
  return ALL;
}

/** @param {string} id @returns {Provider | undefined} */
export function provider(id) {
  return BY_ID.get(id);
}

/**
 * Shared helpers live in `./util.js`, not here.
 *
 * This module imports every provider, and each provider needs a version
 * comparator and a platform key. Defining those here meant nine import cycles;
 * they worked only because esbuild hoists function declarations and nothing was
 * called at module scope, which is a fact about today's code rather than about
 * the design. Re-export them from the leaf if a caller wants one name to import.
 */
export { osKey, gnuArch, shortArch, compareVersions, isSafeVersion, majorMinor } from "./util.js";
