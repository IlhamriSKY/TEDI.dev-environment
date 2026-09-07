// Working out which runtime a project should use, and writing that decision
// somewhere the shims can read it.
//
// The order below is not arbitrary. An explicit pin the user set in TEDI wins,
// because they set it here. Below that come files the project ALREADY has and
// that other tools already honour: `.nvmrc` is read by nvm, fnm and volta, and
// `composer.json`'s `config.platform.php` is what Composer itself resolves
// dependencies against. Reading those means a repository that was already set
// up for a version manager works with no extra file and no migration, and a
// team member not using TEDI still gets the same answer from their own tools.
//
// Inventing a new file and ignoring the two standards would have been less code
// here and more work for every user, forever.

import { join } from "../core/paths.js";
import { readText, readJson, writeText, exists, remove } from "../core/fsx.js";
import { resolveVersion } from "../manager/versions.js";
import { config } from "../runtime.js";
import { renderEnvFile, RUNTIME_FILE } from "./shims.js";

/** @typedef {import("../runtime.js").Project} Project */

/**
 * @typedef {object} ResolvedRuntime
 * @property {string | null} php      Version string, as installed.
 * @property {string | null} phpBin
 * @property {string | null} node
 * @property {string | null} nodeBin
 * @property {string | null} composerBin
 * @property {Record<string, string>} sources  Which file decided each pick.
 */

/**
 * The version a project asks for, before it is matched against what is
 * installed. Returns the raw request plus where it came from, so the UI can say
 * "8.3 (from composer.json)" instead of leaving the user guessing.
 *
 * @param {Project} project
 * @returns {Promise<{ php: string | null, node: string | null, sources: Record<string, string> }>}
 */
export async function readRequests(project) {
  /** @type {Record<string, string>} */
  const sources = {};
  let php = project.php ?? null;
  let node = project.node ?? null;
  if (php) sources.php = "project settings";
  if (node) sources.node = "project settings";

  if (!node) {
    for (const file of [".nvmrc", ".node-version"]) {
      const raw = await readText(join(project.path, file));
      if (raw === null) continue;
      // `.nvmrc` may hold `v20.11.0`, `20`, `lts/iron` or a comment line. Only
      // a numeric request is actionable; an alias is left alone rather than
      // guessed at, because guessing "lts" wrong is worse than falling back.
      const line = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      const m = line?.match(/^v?(\d+(?:\.\d+)*)$/);
      if (m) {
        node = m[1];
        sources.node = file;
        break;
      }
    }
  }

  if (!php) {
    /** @type {{ config?: { platform?: { php?: string } }, require?: Record<string, string> }} */
    const composer = await readJson(join(project.path, "composer.json"), {});
    const platform = composer.config?.platform?.php;
    const required = composer.require?.php;
    // `config.platform.php` is an exact version by definition. A `require`
    // constraint is a RANGE (`^8.2`), so only its floor is meaningful here.
    const pick = platform ?? required;
    const m = pick?.match(/(\d+(?:\.\d+)*)/);
    if (m) {
      php = m[1];
      sources.php = platform ? "composer.json platform" : "composer.json require";
    }
  }

  return { php, node, sources };
}

/**
 * Resolve a project to concrete bin directories.
 *
 * A request that names a version which is not installed falls back through
 * `resolveVersion`, which prefers the global default and then the newest
 * install. That is deliberate: a project pinned to a PHP the user later removed
 * should keep working with a warning, not break the terminal.
 *
 * @param {Project} project
 * @returns {Promise<ResolvedRuntime>}
 */
export async function resolveProject(project) {
  const { php: phpReq, node: nodeReq, sources } = await readRequests(project);

  const php = resolveVersion("php", phpReq ?? config.defaults.php ?? null);
  const node = resolveVersion("node", nodeReq ?? config.defaults.node ?? null);
  const composer = resolveVersion("composer", config.defaults.composer ?? null);

  if (phpReq && php && !versionSatisfies(php.version, phpReq)) {
    sources.phpFallback = `${phpReq} is not installed; using ${php.version}`;
  }
  if (nodeReq && node && !versionSatisfies(node.version, nodeReq)) {
    sources.nodeFallback = `${nodeReq} is not installed; using ${node.version}`;
  }

  return {
    php: php?.version ?? null,
    phpBin: php?.binDir ?? null,
    node: node?.version ?? null,
    nodeBin: node?.binDir ?? null,
    composerBin: composer?.binDir ?? null,
    sources,
  };
}

/**
 * Does `installed` satisfy a request of `wanted`?
 *
 * A request is a PREFIX, not an exact match: asking for `8.3` is satisfied by
 * `8.3.14`, which is what a user means. Asking for `8.3.14` is satisfied only
 * by that. The dot guard is what stops `8.3` from matching `8.30`.
 *
 * @param {string} installed @param {string} wanted @returns {boolean}
 */
export function versionSatisfies(installed, wanted) {
  const clean = installed.replace(/\s*\(system\)$/, "");
  return clean === wanted || clean.startsWith(`${wanted}.`);
}

/**
 * Write `.tedi-runtime` into the project so the shims resolve it.
 *
 * This is the hot-reload mechanism in its entirety: rewriting this file changes
 * what the next `php` in that directory runs. Nothing is restarted, no terminal
 * is reopened, and TEDI is not involved.
 *
 * @param {Project} project
 * @returns {Promise<ResolvedRuntime>}
 */
export async function writeProjectRuntime(project) {
  const resolved = await resolveProject(project);
  const body = renderEnvFile({
    PHP_BIN: resolved.phpBin ?? "",
    NODE_BIN: resolved.nodeBin ?? "",
    COMPOSER_BIN: resolved.composerBin ?? "",
  });
  await writeText(join(project.path, RUNTIME_FILE), body);
  return resolved;
}

/**
 * Remove the generated file, for a project being unregistered. The project
 * directory belongs to the user, so nothing of ours may outlive their use of
 * it.
 *
 * @param {Project} project @returns {Promise<void>}
 */
export async function clearProjectRuntime(project) {
  const file = join(project.path, RUNTIME_FILE);
  if (await exists(file)) await remove(file);
}
