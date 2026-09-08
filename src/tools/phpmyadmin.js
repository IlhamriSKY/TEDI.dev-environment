// phpMyAdmin: downloaded, and served without being one of your projects.
//
// It is a PHP application, so what serves it is the web server this extension
// already runs and what gives it a domain and a certificate is the vhost
// machinery that already exists. But it is NOT a project: it lives outside
// `www/`, it never enters `state.projects`, and it is not something `Refresh`
// can discover. A tool this extension installed has no business appearing in a
// list of the user's own work, where Disable and Remove would offer to do
// things to it that mean nothing.
//
// What makes it served anyway is that `generate()` takes a LIST of projects
// rather than reading the store, so `web/publish.js` appends a synthetic row
// for it. That row is built here, exists for the length of one publish, and is
// the whole integration.
//
// It is deliberately not a provider either. The registry drives version
// dropdowns, "Install everything" and the runtimes list, and phpMyAdmin belongs
// in none of those.

import { fetchJson, download } from "../core/net.js";
import { extract } from "../core/archive.js";
import { mkdirp, exists, move, remove, writeText, readText, singleRoot } from "../core/fsx.js";
import { paths, join, samePath } from "../core/paths.js";
import { compareVersions } from "../registry/util.js";
import { plannedPort } from "../web/ports.js";
import { setBusy, config, state } from "../runtime.js";

const VERSION_URL = "https://www.phpmyadmin.net/home_page/version.json";
const BUSY_ID = "phpmyadmin";

/** The domain it answers on, and the folder name under `tools/`. */
const NAME = "phpmyadmin";

/** Where it is unpacked. Outside `www/`, so no scan can mistake it for a
 *  project; beside the other managed tools, because that is what it is. */
function dir() {
  return join(paths.tools(), NAME);
}

/** Our own stamp. phpMyAdmin states its version in several files and none of
 *  them is stable across releases, so the installer records what it installed
 *  rather than the reader guessing. */
function stampFile() {
  return join(dir(), ".tedi-version");
}

/**
 * The version installed, or null.
 *
 * The stamp AND `index.php`, because either alone lies: an interrupted unpack
 * leaves a folder with no entry point, and a folder emptied by hand leaves a
 * stamp claiming a version that is not there.
 *
 * @returns {Promise<string | null>}
 */
export async function installedVersion() {
  if (!(await exists(join(dir(), "index.php")))) return null;
  const stamp = (await readText(stampFile()))?.trim();
  return stamp || "unknown";
}

/**
 * The synthetic project row that makes it served, or null when it is not
 * installed.
 *
 * Shaped exactly like a real project because `generate()` and `certificateFor`
 * read the same fields from both. `id` is namespaced so nothing can confuse it
 * with a stored project, and `enabled` is always true: the way to stop serving
 * it is to remove it.
 *
 * @returns {Promise<import("../runtime.js").Project | null>}
 */
export async function servedProject() {
  if (!(await installedVersion())) return null;
  return {
    id: "tool:phpmyadmin",
    name: NAME,
    path: dir(),
    kind: "php",
    https: config.autoHttps,
    enabled: true,
  };
}

/** Where it answers, or null before it is installed. Same rule as a project's
 *  own URL, because it is served by the same vhost.
 *  @returns {string} */
export function phpMyAdminUrl() {
  const https = config.autoHttps;
  const port = https ? config.httpsPort : config.httpPort;
  const scheme = https ? "https" : "http";
  const implied = (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
  return `${scheme}://${NAME}.${config.domainSuffix}${implied ? "" : `:${port}`}`;
}

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string} [date]
 * @property {string} [phpVersions]  The range it declares support for, as
 *   phpmyadmin.net states it: `">=7.2,<8.4"`.
 */

/**
 * Every release phpmyadmin.net currently offers, newest first.
 *
 * They list more than one supported branch at a time - 5.2.x alongside a 4.9.x
 * for older PHP - which is exactly why the version is a choice here rather than
 * "the latest": the newest release is often the one that will NOT run on the
 * PHP this environment installs.
 *
 * @returns {Promise<Release[]>}
 */
export async function releases() {
  try {
    const data = await fetchJson("phpmyadmin-version", VERSION_URL, { ttlMs: 24 * 60 * 60_000 });
    const list = Array.isArray(data?.releases) ? data.releases : [];
    /** @type {Release[]} */
    const out = [];
    for (const r of list) {
      const version = String(r?.version ?? "");
      if (/^\d+\.\d+/.test(version)) {
        out.push({ version, date: r?.date, phpVersions: r?.php_versions });
      }
    }
    return out.sort((a, b) => compareVersions(a.version, b.version));
  } catch {
    return [];
  }
}

/**
 * Does `range` admit `php`?
 *
 * phpmyadmin.net states support as `">=7.2,<8.4"`, and this extension installs
 * PHP 8.5 by default - so the answer is often no, and saying so before the
 * download is the difference between a working install and a white page.
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
    // when its first argument is the greater one. Negated, it reads as
    // "php - bound".
    const diff = -compareVersions(php, m[2]);
    const ok = { "<": diff < 0, "<=": diff <= 0, ">": diff > 0, "=": diff === 0 }[m[1] ?? ">="];
    if (!(ok ?? diff >= 0)) return false;
  }
  return true;
}

/**
 * Download and unpack one version, replacing whatever is there.
 *
 * Progress goes through `setBusy` under its own id, so the pane and the status
 * bar report it exactly like a runtime download rather than inventing a second
 * progress vocabulary. The caller publishes; this only puts files on disk.
 *
 * @param {string} version
 * @returns {Promise<void>}
 */
export async function install(version) {
  /** @param {string} text @param {number} [pct] */
  const say = (text, pct) => setBusy(BUSY_ID, { text, ...(pct === undefined ? {} : { pct }) });

  const target = dir();
  const staging = `${target}.staging-${Date.now()}`;
  try {
    const file = `phpMyAdmin-${version}-all-languages.zip`;
    const archive = join(paths.downloads(), file);
    await mkdirp(paths.downloads());
    say(`Downloading ${file}`, 0);
    await download(`https://files.phpmyadmin.net/phpMyAdmin/${version}/${file}`, archive, {
      onProgress: (pct) => say(`Downloading ${file}`, pct),
    });

    say("Unpacking");
    await mkdirp(staging);
    await extract(archive, staging);
    // The zip holds one `phpMyAdmin-<version>-all-languages/` directory, so
    // what is served is one level down. `singleRoot` returns its NAME, and is
    // the same helper every other archive here is unwrapped with.
    const wrapper = await singleRoot(staging);

    say("Installing");
    await remove(target).catch(() => {});
    await move(wrapper ? join(staging, wrapper) : staging, target);
    await remove(staging).catch(() => {});
    await remove(archive).catch(() => {});

    await writeText(stampFile(), `${version}\n`);
    await writeConfig();
  } finally {
    setBusy(BUSY_ID, null);
  }
}

/** Remove it. The caller publishes, which is what stops it being served.
 *  @returns {Promise<void>} */
export async function uninstall() {
  await remove(dir());
}

/** The line the installer writes into `config.inc.php`. Proof that a folder is
 *  one WE created, which is what makes deleting it safe. */
const OURS = "Written by the TEDI Dev Environment extension";

/**
 * Clear away the copy release 0.1.22 put in `www/`.
 *
 * That release installed phpMyAdmin as a project, which put a tool the
 * extension downloaded into the user's own list of work - where Disable and
 * Remove offer to do things to it that mean nothing. It lives under `tools/`
 * now and is served without being a project at all.
 *
 * The folder is only deleted when `config.inc.php` carries the line the
 * installer wrote, which is the one thing that proves we made it. A folder
 * somebody put there themselves and happened to call `phpmyadmin` is left
 * exactly where it is, project row and all.
 *
 * @param {(id: string) => Promise<void>} forget  Drops the project row.
 * @returns {Promise<boolean>} Whether anything was cleared away.
 */
export async function migrateFromWww(forget) {
  const old = join(paths.www(), NAME);
  const config = await readText(join(old, "config.inc.php"));
  if (!config?.includes(OURS)) return false;

  for (const project of state.projects) {
    if (samePath(project.path, old)) await forget(project.id);
  }
  await remove(old);
  return true;
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
  if (!(await exists(join(dir(), "index.php")))) return;
  const secret = Array.from({ length: 32 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36)),
  ).join("");

  await writeText(
    join(dir(), "config.inc.php"),
    [
      "<?php",
      `// ${OURS}. Edits are overwritten`,
      "// when the MySQL port changes.",
      `$cfg['blowfish_secret'] = '${secret}';`,
      "$i = 0;",
      "$i++;",
      "$cfg['Servers'][$i]['auth_type'] = 'cookie';",
      "$cfg['Servers'][$i]['host'] = '127.0.0.1';",
      `$cfg['Servers'][$i]['port'] = '${plannedPort("mysql")}';`,
      "$cfg['Servers'][$i]['compress'] = false;",
      "$cfg['Servers'][$i]['AllowNoPassword'] = true;",
      "",
    ].join("\n"),
  );
}
