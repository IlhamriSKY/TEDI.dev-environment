// What is installed, and what the machine already had.
//
// Two sources, deliberately kept distinct rather than merged into one list.
// A DOWNLOADED version lives in our tree and we know its exact layout. A SYSTEM
// version is whatever the user's package manager put on PATH; we know only that
// it answers `--version`, and we must never assume its directory structure,
// because a Homebrew PHP, a Debian PHP and a compiled-from-source PHP put their
// extension directory and their php.ini in three different places.
//
// The distinction is what lets the extension be honest on macOS and Linux: a
// component with no prebuilt download is not "unavailable", it is "yours, and I
// will use it", with the features that need a known layout switched off.

import { paths } from "../core/paths.js";
import { subdirs, exists } from "../core/fsx.js";
import { which, probe } from "../core/proc.js";
import { providers } from "../registry/index.js";
import { compareVersions } from "../registry/util.js";
import { installRoot } from "./install.js";
import { state } from "../runtime.js";

/** @typedef {import("../registry/index.js").Provider} Provider */
/** @typedef {import("../runtime.js").InstalledVersion} InstalledVersion */

/**
 * Scan the install tree for every version of every component.
 *
 * The tree IS the source of truth: a version is installed when its directory
 * exists and its executable is there, not when a manifest says so. A JSON index
 * would drift the moment a user deleted a folder by hand, and the folder is the
 * thing they can see.
 *
 * @returns {Promise<Map<string, InstalledVersion[]>>}
 */
export async function scanInstalled() {
  // The nine providers are scanned CONCURRENTLY, and it is worth the one line
  // of `Promise.all`: this runs inside `activate()`, so its cost is charged to
  // every launch of TEDI whether or not anyone opens the pane, and `bootAll`
  // waits for the slowest extension. Sequentially it was around a dozen IPC
  // round trips and a `where`/`command -v` SUBPROCESS per provider, one after
  // another; in parallel the whole scan is as slow as its slowest single probe.
  //
  // Nothing here shares state between providers, so there is no ordering to
  // preserve inside the scan - and the map is rebuilt from the ordered provider
  // list afterwards, so the dashboard's row order is unchanged.
  const scans = await Promise.all(providers().map((p) => scanProvider(p)));

  /** @type {Map<string, InstalledVersion[]>} */
  const found = new Map();
  providers().forEach((p, i) => found.set(p.id, scans[i]));

  state.installed = found;
  return found;
}

/**
 * Every version of one component: what we installed, then what the machine had.
 *
 * @param {Provider} p
 * @returns {Promise<InstalledVersion[]>}
 */
async function scanProvider(p) {
  /** @type {InstalledVersion[]} */
  const rows = [];

  if (p.kind === "tool" && !p.multiVersion) {
    // Non-versioned tool: one executable in tools/, present or not.
    const layout = await p.layout("");
    if (await exists(layout.exe)) {
      const line = await probe(layout.exe, p.versionArgs ?? ["--version"]);
      rows.push({
        component: p.id,
        version: extractVersion(line) ?? "installed",
        dir: paths.tools(),
        binDir: layout.binDir,
        origin: "download",
      });
    }
  } else {
    const base = baseDirFor(p);
    // Skip the staging leftovers an interrupted install can leave behind.
    const versions = (await subdirs(base)).filter(
      (v) => !v.includes(".staging-") && !v.includes("-lift-"),
    );
    const checked = await Promise.all(
      versions.map(async (version) => {
        const layout = await p.layout(version);
        if (!(await exists(layout.exe))) return null;
        return /** @type {InstalledVersion} */ ({
          component: p.id,
          version,
          dir: installRoot(p, version),
          binDir: layout.binDir,
          origin: "download",
        });
      }),
    );
    for (const row of checked) if (row) rows.push(row);
    rows.sort((a, b) => compareVersions(a.version, b.version));
  }

  const sys = await detectSystem(p);
  if (sys) rows.push(sys);
  return rows;
}

/** The directory holding this provider's versioned installs.
 *  @param {Provider} p @returns {string} */
function baseDirFor(p) {
  if (p.kind === "server") return paths.serverBase(p.id);
  if (p.kind === "service") return paths.serviceBase(p.id);
  return paths.runtimeBase(p.id);
}

/**
 * A system install of this component, if one is on PATH.
 *
 * Reported with `origin: "system"` and the directory the binary sits in, which
 * is all we can honestly claim to know about it.
 *
 * @param {Provider} p
 * @returns {Promise<InstalledVersion | null>}
 */
async function detectSystem(p) {
  for (const name of p.systemBin ?? []) {
    const hit = await which(name);
    if (!hit) continue;
    // The provider's own flag, not `--version`. `nginx --version` and
    // `httpd --version` are usage errors, so a detected system web server
    // reported itself as bare "system" with no number - on macOS and Linux,
    // where a system install is the ONLY way to have one.
    const line = await probe(hit, p.versionArgs ?? ["--version"]);
    const version = extractVersion(line);
    return {
      component: p.id,
      version: version ? `${version} (system)` : "system",
      dir: hit.replace(/[\\/][^\\/]*$/, ""),
      binDir: hit.replace(/[\\/][^\\/]*$/, ""),
      origin: "system",
    };
  }
  return null;
}

/**
 * The first dotted version number in a `--version` line.
 *
 * Every one of these tools prints something different ("PHP 8.3.14 (cli)",
 * "v22.11.0", "nginx version: nginx/1.27.3"), and all of them contain exactly
 * one leading dotted number, so one regex beats nine parsers.
 *
 * @param {string | null} line @returns {string | null}
 */
function extractVersion(line) {
  if (!line) return null;
  const m = line.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/**
 * Installed versions of one component, downloads first.
 * @param {string} componentId @returns {InstalledVersion[]}
 */
export function installedOf(componentId) {
  return state.installed.get(componentId) ?? [];
}

/**
 * Resolve a component version to its bin directory.
 *
 * Falls back through: the exact version asked for, then the globally active
 * one, then the newest downloaded, then a system install. That chain is what
 * makes a project pin degrade gracefully instead of failing hard when the
 * pinned version was uninstalled.
 *
 * @param {string} componentId
 * @param {string | null} [wanted]
 * @returns {InstalledVersion | null}
 */
export function resolveVersion(componentId, wanted) {
  const rows = installedOf(componentId);
  if (rows.length === 0) return null;
  if (wanted) {
    const exact = rows.find((r) => r.version === wanted);
    if (exact) return exact;
    // A pin of "8.3" should match 8.3.14, which is what a user means by it.
    const prefixed = rows.find((r) => r.version.startsWith(`${wanted}.`));
    if (prefixed) return prefixed;
  }
  return rows.find((r) => r.origin === "download") ?? rows[0];
}

/**
 * The bin directories that make up the global environment: one per component
 * that has an active version. This is what the shims fall back to.
 *
 * @param {Record<string, string>} defaults
 * @returns {{ id: string, binDir: string, version: string }[]}
 */
export function globalBinDirs(defaults) {
  /** @type {{ id: string, binDir: string, version: string }[]} */
  const out = [];
  for (const p of providers()) {
    const wanted = defaults[p.id] ?? null;
    const row = resolveVersion(p.id, wanted);
    if (row) out.push({ id: p.id, binDir: row.binDir, version: row.version });
  }
  return out;
}
