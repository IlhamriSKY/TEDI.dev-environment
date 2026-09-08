// Applying a runtime change, as one operation.
//
// Installing, removing or switching a version has THREE consequences, and
// missing any one of them leaves the app in a state the user reads as a bug:
//
//   1. `state.installed` is stale, so the dashboard still shows the old set -
//      you install PHP 8.3 and the card still says "1 installed, system".
//   2. `global.env` still points at the previous runtime, so a terminal in a
//      folder with no project config keeps resolving the old binary.
//   3. Every project's `.tedi-runtime` was written against the old resolution,
//      so a project following the global default does not follow it any more.
//
// The first of those actually shipped: `openInstaller` downloaded correctly and
// then never rescanned, so a successful install was invisible until the pane was
// reopened. It was found by driving the real UI, not by reading the code, which
// is the argument for this file existing at all: one function that does all
// three, so no call site can do two of them.
//
// This module is deliberately a leaf that nothing in `manager/` imports, which
// is what keeps `versions -> projects -> resolve -> versions` from becoming a
// cycle.

import { scanInstalled, globalBinDirs, installedOf } from "./versions.js";
import { ensureIni, iniPathFor } from "./phpini.js";
import { enableDefaults } from "./phpext.js";
import { refreshAllRuntimes } from "../project/projects.js";
import { renderEnvFile } from "../project/shims.js";
import { writeText } from "../core/fsx.js";
import { paths } from "../core/paths.js";
import { publishHandoff } from "./handoff.js";
import { config, warn } from "../runtime.js";
import { markDriversSeeded } from "./config.js";

/**
 * Write the shim fallback: what a directory with no `.tedi-runtime` resolves to.
 *
 * @returns {Promise<void>}
 */
export async function writeGlobalEnv() {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const entry of globalBinDirs(config.defaults)) {
    if (entry.id === "php") vars.PHP_BIN = entry.binDir;
    if (entry.id === "node") vars.NODE_BIN = entry.binDir;
    if (entry.id === "composer") vars.COMPOSER_BIN = entry.binDir;
  }
  await writeText(paths.globalEnv(), renderEnvFile(vars));
}

/**
 * Give every managed PHP the php.ini it was installed without.
 *
 * A Windows PHP zip ships `php.ini-development` and `php.ini-production` and no
 * `php.ini` at all, and nothing here created one: `ensureIni` was reached only
 * by CHANGING something - applying a setting, enabling an extension, wiring
 * Xdebug. So a freshly installed PHP had no ini until you edited one, which
 * meant the Configure dialog opened on an empty settings grid and an empty
 * editor, and the runtime itself ran with no `extension_dir`, no timezone and
 * the compiled-in defaults. "Install PHP" has to mean a PHP you can use.
 *
 * Only a DOWNLOADED one. A system PHP's ini belongs to whatever put it there,
 * and seeding it from a template would overwrite that machine's configuration
 * with ours.
 *
 * Idempotent: `ensureIni` returns early when the file is already there, so this
 * costs one existence check per installed version.
 *
 * @returns {Promise<void>}
 */
export async function ensurePhpInis() {
  // Once, for the installs that predate this: a php.ini seeded by an earlier
  // release has the database drivers commented out, and the environment cannot
  // reach the MySQL it installed. Recorded in config so it is a one-off rather
  // than an argument with anyone who later switches one off.
  const backfill = !config.driversSeeded;

  for (const row of installedOf("php")) {
    if (row.origin !== "download") continue;
    // Whether the file is about to be CREATED, asked before it is. A fresh
    // php.ini gets the database drivers turned on; an existing one is left
    // alone, because a user who switched one off has decided.
    const before = await iniPathFor(row.version);
    const fresh = before !== null && !before.exists;
    await ensureIni(row.version).catch((err) => warn("could not seed php.ini", row.version, err));
    if (!fresh && !backfill) continue;
    const on = await enableDefaults(row.version).catch(() => []);
    if (on.length) warn(`enabled ${on.join(", ")} for PHP ${row.version}`);
  }

  if (backfill) await markDriversSeeded();
}

/**
 * Re-read what is installed and push the consequences everywhere.
 *
 * Call after ANY change to the set of installed versions or to the active one.
 *
 * @returns {Promise<void>}
 */
export async function applyRuntimeChange() {
  await scanInstalled();
  await ensurePhpInis();
  await writeGlobalEnv();
  await refreshAllRuntimes();
  // Which databases exist and on what port both just changed. The file is a
  // courtesy to another extension and never throws, so it goes last.
  await publishHandoff();
}
