// phpMyAdmin, installed as a project rather than as a managed binary.
//
// It is a PHP application, so the thing that serves it is the web server this
// extension already runs, and the thing that gives it a domain and a
// certificate is the project machinery that already exists. Installing it into
// `www/` and registering it means it gets a vhost, HTTPS, a hosts entry, a row
// you can disable and a Remove that works - none of which had to be written.
//
// It is deliberately NOT a provider. The registry drives version dropdowns,
// "Install everything" and the runtimes list, and phpMyAdmin belongs in none of
// those: there is one version anyone wants, nobody switches between two, and it
// is not part of a working environment the way PHP is.

import { fetchJson, download } from "../core/net.js";
import { extract } from "../core/archive.js";
import { mkdirp, exists, move, remove, writeText, singleRoot } from "../core/fsx.js";
import { paths, join, basename } from "../core/paths.js";
import { addProject, projectUrl } from "../project/projects.js";
import { compareVersions } from "../registry/util.js";
import { plannedPort } from "../web/ports.js";
import { publish } from "../web/publish.js";
import { setBusy, state } from "../runtime.js";

const VERSION_URL = "https://www.phpmyadmin.net/home_page/version.json";
const BUSY_ID = "phpmyadmin";

/** The folder it is served from. Its name is its domain, so it is fixed. */
function phpMyAdminDir() {
  return join(paths.www(), "phpmyadmin");
}

/** Is it there? A folder is not enough - an interrupted unpack leaves one.
 *  @returns {Promise<boolean>} */
export async function isInstalled() {
  return await exists(join(phpMyAdminDir(), "index.php"));
}

/** The URL it is served at, or null before it is installed.
 *  @returns {string | null} */
export function phpMyAdminUrl() {
  const project = phpMyAdminProject();
  return project ? projectUrl(project) : null;
}

/** Its row in the projects list, which is what makes it served at all.
 *  @returns {import("../runtime.js").Project | undefined} */
function phpMyAdminProject() {
  return state.projects.find((p) => p.path && basename(p.path) === "phpmyadmin");
}

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string} [phpVersions]  The range it declares support for, as
 *   phpmyadmin.net states it: `">=7.2,<8.4"`.
 */

/** The current release, or null when the site cannot be reached.
 *  @returns {Promise<Release | null>} */
export async function latestRelease() {
  try {
    const data = await fetchJson("phpmyadmin-version", VERSION_URL, {
      ttlMs: 24 * 60 * 60_000,
    });
    const version = String(data?.version ?? "");
    if (!/^\d+\.\d+/.test(version)) return null;
    const match = (data?.releases ?? []).find(
      (/** @type {{ version?: string }} */ r) => r.version === version,
    );
    return { version, phpVersions: match?.php_versions };
  } catch {
    return null;
  }
}

/**
 * Does `phpVersions` admit `php`?
 *
 * phpmyadmin.net states support as `">=7.2,<8.4"`, and this extension installs
 * PHP 8.5 by default - so the answer is usually NO, and saying so up front is
 * the difference between a working install and a white page. Exported for the
 * self-check, because the parsing is the part that can be wrong quietly.
 *
 * @param {string | undefined} range @param {string | null} php
 * @returns {boolean}
 */
export function phpSatisfies(range, php) {
  if (!range || !php) return true;
  for (const clause of range.split(",")) {
    const m = /^\s*(>=|<=|>|<|=)?\s*([\d.]+)\s*$/.exec(clause);
    if (!m) continue;
    // `compareVersions` sorts NEWEST FIRST, so it returns a negative number
    // when the first argument is the greater one. Read it as "php - bound".
    const diff = -compareVersions(php, m[2]);
    const ok = { "<": diff < 0, "<=": diff <= 0, ">": diff > 0, "=": diff === 0 }[m[1] ?? ">="];
    if (!(ok ?? diff >= 0)) return false;
  }
  return true;
}

/**
 * Download, unpack and serve it.
 *
 * Progress goes through `setBusy` under its own id, so the pane and the status
 * bar report it exactly like a runtime download; there is no second progress
 * vocabulary for this one thing.
 *
 * @param {(text: string, pct?: number) => void} [onProgress]
 * @returns {Promise<string>} The URL it is served at.
 */
export async function install(onProgress) {
  /** @param {string} text @param {number} [pct] */
  const say = (text, pct) => {
    setBusy(BUSY_ID, { text, ...(pct === undefined ? {} : { pct }) });
    onProgress?.(text, pct);
  };

  const target = phpMyAdminDir();
  const staging = `${target}.staging-${Date.now()}`;
  try {
    say("Resolving download");
    const release = await latestRelease();
    if (!release) throw new Error("phpmyadmin.net could not be reached.");

    const file = `phpMyAdmin-${release.version}-all-languages.zip`;
    const archive = join(paths.downloads(), file);
    await mkdirp(paths.downloads());
    say(`Downloading ${file}`, 0);
    await download(`https://files.phpmyadmin.net/phpMyAdmin/${release.version}/${file}`, archive, {
      onProgress: (pct) => say(`Downloading ${file}`, pct),
    });

    say("Unpacking");
    await mkdirp(staging);
    await extract(archive, staging);
    // The zip holds one `phpMyAdmin-<version>-all-languages/` directory, so
    // what is served is one level down. `singleRoot` returns its NAME, which is
    // the same shape `manager/install.js` unwraps every other archive with.
    const wrapper = await singleRoot(staging);
    const unpacked = wrapper ? join(staging, wrapper) : staging;

    say("Installing");
    await remove(target).catch(() => {});
    await move(unpacked, target);
    await remove(staging).catch(() => {});
    await remove(archive).catch(() => {});

    await writeConfig();
    const project = await addProject(target, { name: "phpmyadmin", kind: "php" });
    await publish().catch(() => {});
    return projectUrl(project);
  } finally {
    setBusy(BUSY_ID, null);
  }
}

/**
 * Point it at the managed MySQL.
 *
 * Rewritten whenever the port could have moved, not only at install: the port
 * is a setting, and a phpMyAdmin still dialling 3306 after MySQL was moved to
 * 3307 fails with an error about the server being down.
 *
 * `AllowNoPassword` because the account this environment creates is `root` with
 * no password, which phpMyAdmin refuses to log in as otherwise.
 *
 * @returns {Promise<void>}
 */
export async function writeConfig() {
  if (!(await isInstalled())) return;
  const secret = Array.from({ length: 32 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36)),
  ).join("");

  const lines = [
    "<?php",
    "// Written by the TEDI Dev Environment extension. Edits are overwritten when",
    "// the MySQL port changes.",
    `$cfg['blowfish_secret'] = '${secret}';`,
    "$i = 0;",
    "$i++;",
    "$cfg['Servers'][$i]['auth_type'] = 'cookie';",
    "$cfg['Servers'][$i]['host'] = '127.0.0.1';",
    `$cfg['Servers'][$i]['port'] = '${plannedPort("mysql")}';`,
    "$cfg['Servers'][$i]['compress'] = false;",
    "$cfg['Servers'][$i]['AllowNoPassword'] = true;",
    "",
  ];
  await writeText(join(phpMyAdminDir(), "config.inc.php"), lines.join("\n"));
}
