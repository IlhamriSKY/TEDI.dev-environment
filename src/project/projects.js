// The project registry: which folders this environment serves, and under what
// name.
//
// A project is a folder plus a domain. Everything else (which PHP, which
// document root, whether it gets HTTPS) has a default that works, so registering
// one is a single action and the details are opt-in.
//
// Domains are computed rather than stored, unless the user overrides them. That
// way changing the global suffix from `.test` to `.dev` moves every project at
// once instead of leaving twenty stored strings behind that all still say
// `.test`.

import { paths, join, basename, samePath } from "../core/paths.js";
import { readJson, writeJson, readDir, isDir } from "../core/fsx.js";
import { config, state } from "../runtime.js";
import { writeProjectRuntime, clearProjectRuntime } from "./resolve.js";
import { forgetCertificate } from "../web/certs.js";

/** @typedef {import("../runtime.js").Project} Project */

/** @returns {Promise<Project[]>} */
export async function loadProjects() {
  /** @type {{ projects?: Project[] }} */
  const doc = await readJson(paths.projectsFile(), {});
  const list = Array.isArray(doc.projects) ? doc.projects : [];
  state.projects = list;
  return list;
}

/** @returns {Promise<void>} */
async function saveProjects() {
  await writeJson(paths.projectsFile(), { projects: state.projects });
}

/**
 * A project's domain: its override, or its name plus the effective suffix.
 *
 * The name is slugified rather than used raw, because a folder called
 * "My Shop (v2)" is a perfectly ordinary folder and a completely invalid
 * hostname, and failing at nginx-config-generation time would be far from the
 * cause.
 *
 * @param {Project} project @returns {string}
 */
export function domainOf(project) {
  if (project.domain) return project.domain.toLowerCase();
  const suffix = (project.suffix ?? config.domainSuffix).replace(/^\.+/, "");
  return `${slug(project.name)}.${suffix}`.toLowerCase();
}

/**
 * Turn a folder name into a hostname label.
 * @param {string} value @returns {string}
 */
export function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "project"
  );
}

/**
 * The directory actually served for a project.
 *
 * Defaults to the project root, but a Laravel or Symfony app serves `public/`
 * and pointing a vhost at the root would expose `.env` to anyone who asked for
 * it. So the default is DETECTED, and the detection order matches how common
 * each layout is.
 *
 * @param {Project} project @returns {Promise<string>}
 */
export async function docRootOf(project) {
  if (project.docRoot) return join(project.path, project.docRoot);
  for (const candidate of ["public", "public_html", "web", "dist"]) {
    if (await isDir(join(project.path, candidate))) return join(project.path, candidate);
  }
  return project.path;
}

/**
 * Register a folder as a project.
 *
 * @param {string} path Absolute folder path.
 * @param {Partial<Project>} [overrides]
 * @returns {Promise<Project>}
 */
export async function addProject(path, overrides = {}) {
  const existing = state.projects.find((p) => samePath(p.path, path));
  if (existing) return existing;

  /** @type {Project} */
  const project = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: overrides.name ?? basename(path),
    path,
    kind: overrides.kind ?? ((await isDir(join(path, "vendor"))) ? "php" : undefined) ?? "php",
    https: overrides.https ?? config.autoHttps,
    enabled: overrides.enabled ?? true,
    ...overrides,
  };

  state.projects = [...state.projects, project];
  await saveProjects();
  await writeProjectRuntime(project);
  return project;
}

/**
 * Update a project and re-emit its runtime file.
 *
 * Every change goes through here rather than mutating the array, because the
 * `.tedi-runtime` rewrite is what makes a version change take effect, and a
 * caller that forgot it would leave the terminal on the old runtime with no
 * visible reason.
 *
 * @param {string} id @param {Partial<Project>} patch
 * @returns {Promise<Project | null>}
 */
export async function updateProject(id, patch) {
  const index = state.projects.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const before = state.projects[index];
  const next = { ...before, ...patch };
  state.projects = [...state.projects.slice(0, index), next, ...state.projects.slice(index + 1)];
  await saveProjects();
  await writeProjectRuntime(next);

  // A renamed project, or one whose suffix changed, has a NEW domain. Its old
  // certificate covers a name nothing serves any more, so drop it rather than
  // leave a private key on disk for a host that no longer exists.
  const wasDomain = domainOf(before);
  if (domainOf(next) !== wasDomain) await forgetCertificate(wasDomain).catch(() => {});

  return next;
}

/**
 * Unregister a project and remove the file we put in its folder.
 * @param {string} id @returns {Promise<void>}
 */
export async function removeProject(id) {
  const project = state.projects.find((p) => p.id === id);
  if (project) await clearProjectRuntime(project).catch(() => {});
  state.projects = state.projects.filter((p) => p.id !== id);
  await saveProjects();
}

/**
 * Folders under `parent` that are not registered yet.
 *
 * EVERY directory, not only the ones carrying a `composer.json` or a
 * `package.json`. The marker list was right while this scanned any folder the
 * user pointed it at - there it had to guess which of your Documents were apps -
 * and wrong now that it only ever scans the environment's own `www`. A folder
 * in there is a project by virtue of being in there: that is what the folder is
 * for, and an empty one you are about to clone into is exactly the case where
 * having the domain and the certificate already issued is worth something. A
 * scan that answered "nothing new" about a folder you had just put there was
 * reporting its own guess as a fact.
 *
 * One level deep only. A recursive scan would walk into `node_modules` and
 * `vendor`, which is thousands of directories and seconds of IO for no benefit:
 * nobody nests the app they are working on three levels inside another app.
 *
 * @param {string} parent
 * @returns {Promise<{ name: string, path: string }[]>}
 */
export async function discoverProjects(parent) {
  /** @type {{ name: string, path: string }[]} */
  const out = [];
  for (const entry of await readDir(parent, false)) {
    if (entry.kind !== "dir") continue;
    // A dependency tree dropped at the top level, and anything a tool keeps its
    // own state in. Neither is a site and both are common.
    if (entry.name === "node_modules" || entry.name === "vendor") continue;
    if (entry.name.startsWith(".")) continue;
    const path = join(parent, entry.name);
    if (state.projects.some((p) => samePath(p.path, path))) continue;
    out.push({ name: entry.name, path });
  }
  return out;
}

/** Rewrite `.tedi-runtime` for every project. Called after a global version
 *  change, so projects without a pin follow the new default immediately.
 *  @returns {Promise<void>} */
export async function refreshAllRuntimes() {
  for (const project of state.projects) {
    await writeProjectRuntime(project).catch(() => {});
  }
}
