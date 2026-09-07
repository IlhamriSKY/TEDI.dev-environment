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

import { scanInstalled, globalBinDirs } from "./versions.js";
import { refreshAllRuntimes } from "../project/projects.js";
import { renderEnvFile } from "../project/shims.js";
import { writeText } from "../core/fsx.js";
import { paths } from "../core/paths.js";
import { config } from "../runtime.js";

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
 * Re-read what is installed and push the consequences everywhere.
 *
 * Call after ANY change to the set of installed versions or to the active one.
 *
 * @returns {Promise<void>}
 */
export async function applyRuntimeChange() {
  await scanInstalled();
  await writeGlobalEnv();
  await refreshAllRuntimes();
}
