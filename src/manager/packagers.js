// npm, pnpm, yarn and bun.
//
// Only ONE of these is a managed download here, and that is deliberate.
//
// npm ships inside every Node release, so it is already installed the moment a
// Node version is. pnpm and yarn are distributed through Corepack, which also
// ships inside Node: `corepack enable pnpm` puts a shim on the Node install and
// pins the version a project's `packageManager` field asks for. Modelling
// either as a managed download would mean maintaining a second version matrix
// for something one command already does better, and it would fight the
// `packageManager` field that every modern repository now carries.
//
// Bun is genuinely separate: it is a runtime, not a package manager, with its
// own release feed. It is detected rather than managed, because a user who
// wants Bun installs Bun, and shadowing their install with ours would be a
// surprise, not a service.

import { join } from "../core/paths.js";
import { exists, readJson } from "../core/fsx.js";
import { run, which, probe } from "../core/proc.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { resolveVersion } from "./versions.js";

/**
 * @typedef {object} PackagerStatus
 * @property {string} id
 * @property {string} label
 * @property {boolean} available
 * @property {string | null} version
 * @property {"bundled" | "corepack" | "system"} origin
 * @property {boolean} canEnable   Corepack can turn it on for the active Node.
 */

/** Windows resolves a Node-shipped CLI through its `.cmd` shim.
 *  @param {string} name @returns {string} */
function cliName(name) {
  return isWindows() ? `${name}.cmd` : name;
}

/**
 * What is available for the active Node.
 *
 * @param {string | null} nodeVersion
 * @returns {Promise<PackagerStatus[]>}
 */
export async function survey(nodeVersion) {
  const node = resolveVersion("node", nodeVersion);
  /** @type {PackagerStatus[]} */
  const out = [];

  for (const [id, label] of /** @type {[string, string][]} */ ([
    ["npm", "npm"],
    ["pnpm", "pnpm"],
    ["yarn", "Yarn"],
  ])) {
    const path = node ? join(node.binDir, cliName(id)) : null;
    const present = path ? await exists(path) : false;
    const version = present && path ? await probe(path, ["--version"]) : null;
    out.push({
      id,
      label,
      available: present,
      version,
      origin: id === "npm" ? "bundled" : "corepack",
      // npm needs no enabling; the other two do, and only when Node is ours.
      canEnable: id !== "npm" && Boolean(node) && !present,
    });
  }

  const bun = await which("bun");
  out.push({
    id: "bun",
    label: "Bun",
    available: Boolean(bun),
    version: bun ? await probe(bun, ["--version"]) : null,
    origin: "system",
    canEnable: false,
  });

  return out;
}

/**
 * Turn on pnpm or yarn for the active Node, through Corepack.
 *
 * @param {string} id  "pnpm" or "yarn"
 * @param {string | null} nodeVersion
 * @returns {Promise<void>}
 */
export async function enablePackager(id, nodeVersion) {
  if (id !== "pnpm" && id !== "yarn") {
    throw new Error(`${id} is not managed through Corepack.`);
  }
  const node = resolveVersion("node", nodeVersion);
  if (!node) throw new Error("No Node.js version is installed.");

  const corepack = join(node.binDir, cliName("corepack"));
  if (!(await exists(corepack))) {
    throw new Error(
      "This Node.js release does not ship Corepack. Install a newer Node, or install pnpm globally yourself.",
    );
  }

  // `corepack enable` writes its shims next to the Node binary, which is inside
  // our own install tree - so this changes nothing outside the version it was
  // run for, and uninstalling that Node takes the shims with it.
  const res = await run(corepack, ["enable", id], { cwd: node.binDir, timeoutMs: 120_000 });
  if (res.code !== 0) {
    throw new Error(
      `corepack enable ${id} failed: ${res.out.trim().split(/\r?\n/).slice(-2).join(" ")}`,
    );
  }
}
