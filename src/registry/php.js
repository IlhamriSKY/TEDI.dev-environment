// PHP. The most platform-divided component here, and the reason the provider
// interface allows `download()` to answer null.
//
// Windows has an official build service, so versions and their exact filenames
// come from `releases.json`. That file states the Visual Studio tag per branch
// (vc15 for 7.4, vs16 for 8.0-8.3, vs17 for 8.4+), which is precisely the part
// that would rot if it were written down here: the tag changes with the
// toolchain, not on a schedule anyone can predict.
//
// macOS and Linux have NO official binary distribution of PHP at all. The
// project ships source. So downloaded PHP there comes from static-php-cli,
// which publishes static `cli` and `fpm` builds for linux/macos on x86_64 and
// aarch64. Those are statically linked, which buys a working PHP with no
// toolchain and costs the ability to load a new extension .so at runtime - the
// tradeoff is stated in the UI rather than hidden, and a detected SYSTEM php is
// always offered alongside.
//
// NTS (non-thread-safe) is the Windows default here because both servers drive
// PHP over FastCGI, where NTS is the correct build. TS only matters for an
// in-process Apache module, which this extension does not use.

import { fetchJson, urlExists } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { compareVersions, majorMinor, gnuArch, osKey } from "./util.js";

const WIN_RELEASES = "https://windows.php.net/downloads/releases/releases.json";
const WIN_BASE = "https://windows.php.net/downloads/releases";
const PHP_NET_RELEASES = "https://www.php.net/releases/index.php?json=1&max=60&version=";
const STATIC_PHP = "https://dl.static-php.dev/static-php-cli/common";

/** Visual Studio tags to probe for an archived Windows build whose branch is no
 *  longer in releases.json. Ordered newest first; bounded so a miss costs four
 *  HEAD requests, not a crawl of the archive index. */
const VS_CANDIDATES = ["vs17", "vs16", "vc15", "vc14"];

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/**
 * The Windows release index, shaped `{ "8.3": { version, "nts-vs16-x64": { zip: { path } } } }`.
 * @typedef {Record<string, Record<string, any>>} WinReleases
 */

/** @returns {Promise<WinReleases>} */
async function winReleases() {
  return await fetchJson("php-win-releases", WIN_RELEASES, { ttlMs: 6 * 60 * 60_000 });
}

/**
 * Every PHP version this platform can install.
 *
 * Windows lists the current build per branch, which is what the official index
 * guarantees is downloadable, then adds older patch releases from php.net
 * marked `archived` - those resolve through the archives directory and are
 * probed at download time rather than listed optimistically.
 *
 * @returns {Promise<VersionInfo[]>}
 */
async function versions() {
  /** @type {Map<string, VersionInfo>} */
  const out = new Map();

  if (isWindows()) {
    try {
      const rel = await winReleases();
      for (const [branch, entry] of Object.entries(rel)) {
        const v = entry?.version;
        if (typeof v === "string") {
          out.set(v, { version: v, channel: "stable", released: branch });
        }
      }
    } catch {
      // Fall through to php.net; an offline machine still sees a list.
    }
  }

  for (const major of ["8", "7"]) {
    try {
      /** @type {Record<string, { date?: string, museum?: boolean }>} */
      const rel = await fetchJson(`php-net-${major}`, PHP_NET_RELEASES + major, {
        ttlMs: 24 * 60 * 60_000,
      });
      for (const [v, meta] of Object.entries(rel)) {
        if (out.has(v)) continue;
        out.set(v, { version: v, channel: "stable", released: meta?.date });
      }
    } catch {
      /* one major failing must not empty the list */
    }
  }

  const list = [...out.values()].sort((a, b) => compareVersions(a.version, b.version));
  if (list[0]) list[0].recommended = true;
  return list;
}

/**
 * Where a Windows build lives, using the exact filename the index states.
 * Falls back to probing the archives directory for a branch that has rolled
 * off the current index.
 *
 * @param {string} version
 * @returns {Promise<Download | null>}
 */
async function windowsDownload(version) {
  // php.net publishes no ARM64 Windows build, so x64 is the only option and an
  // ARM64 Windows machine runs it under emulation, which works.
  const arch = "x64";
  const branch = majorMinor(version);

  try {
    const rel = await winReleases();
    const entry = rel[branch];
    if (entry && entry.version === version) {
      // Prefer NTS: both servers speak FastCGI.
      const key = Object.keys(entry).find((k) => k.startsWith(`nts-`) && k.endsWith(`-${arch}`));
      const path = key ? entry[key]?.zip?.path : undefined;
      if (typeof path === "string") {
        return { url: `${WIN_BASE}/${path}`, file: path, note: "non-thread-safe" };
      }
    }
  } catch {
    /* fall through to the archive probe */
  }

  // Archived build: the VS tag is not stated anywhere machine-readable for an
  // old branch, so probe the small candidate set rather than hardcode a
  // branch-to-toolchain table that goes stale every release.
  for (const vs of VS_CANDIDATES) {
    const file = `php-${version}-nts-Win32-${vs}-${arch}.zip`;
    const url = `${WIN_BASE}/archives/${file}`;
    if (await urlExists(url)) return { url, file, note: "non-thread-safe, archived build" };
  }
  return null;
}

/**
 * static-php-cli publishes `linux` and `macos` for `x86_64` and `aarch64`.
 * Returns null for anything else, which is the honest answer.
 *
 * @param {string} version @param {"cli" | "fpm"} sapi
 * @returns {Promise<Download | null>}
 */
async function staticPhpDownload(version, sapi) {
  const os = osKey();
  if (os === "windows") return null;
  const file = `php-${version}-${sapi}-${os}-${gnuArch()}.tar.gz`;
  const url = `${STATIC_PHP}/${file}`;
  if (!(await urlExists(url))) return null;
  return {
    url,
    file,
    note: sapi === "cli" ? "static build, extensions are compiled in" : "FPM",
  };
}

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  if (isWindows()) return await windowsDownload(version);
  return await staticPhpDownload(version, "cli");
}

/**
 * The FPM binary, fetched alongside the CLI on platforms where they ship
 * separately. Windows has no FPM at all: the Windows zip carries `php-cgi.exe`,
 * which is what the vhost generator targets there.
 *
 * @param {string} version @returns {Promise<Download[]>}
 */
async function extras(version) {
  if (isWindows()) return [];
  const fpm = await staticPhpDownload(version, "fpm");
  return fpm ? [fpm] : [];
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  const dir = paths.runtime("php", version);
  // Windows ships a flat zip: php.exe sits at the root next to ext/.
  // static-php-cli ships a single binary, which the installer places in bin/.
  const binDir = isWindows() ? dir : join(dir, "bin");
  return { binDir, exe: join(binDir, `php${exeSuffix()}`) };
}

/** Directory holding loadable extension binaries for a Windows install.
 *  @param {string} version @returns {string} */
export function phpExtDir(version) {
  return join(paths.runtime("php", version), "ext");
}

/** The FastCGI executable the web server should talk to, per platform.
 *  Windows has php-cgi.exe; elsewhere it is php-fpm from the extras download.
 *  @param {string} version @returns {string} */
export function phpFastCgi(version) {
  const dir = paths.runtime("php", version);
  return isWindows() ? join(dir, "php-cgi.exe") : join(dir, "bin", "php-fpm");
}

/** Can extensions be added to this install after the fact? Only Windows builds
 *  (and a detected system PHP) load .dll/.so at runtime; a static build cannot.
 *  @returns {boolean} */
export function supportsRuntimeExtensions() {
  return isWindows();
}

/** @type {import("./index.js").Provider & { extras: (v: string) => Promise<Download[]> }} */
export const php = {
  id: "php",
  label: "PHP",
  kind: "runtime",
  multiVersion: true,
  blurb: "Interpreter, FastCGI worker and extension host for every PHP project.",
  versions,
  download,
  extras,
  layout,
  systemBin: ["php"],
  packageHint: isWindows() ? "" : "brew install php  |  apt install php-cli php-fpm",
};
