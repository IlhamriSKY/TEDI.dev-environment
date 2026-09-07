// Composer, and the other package managers that are not really "installed" in
// the same sense as a runtime.
//
// Composer is a single `.phar` and is platform-independent, so it is the one
// component here with no architecture question at all. The installer notices
// the download is not an archive and places it rather than unpacking it.
//
// pnpm, yarn and bun are deliberately NOT providers. pnpm and yarn ship with
// every modern Node via Corepack, and bun is a separate runtime with its own
// installer; modelling them as managed versions would mean three more download
// matrices to keep true for something one command already does. `manager/
// packagers.js` enables them through Corepack against the ACTIVE Node instead,
// which is both less code and the behaviour a Node developer expects.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { compareVersions } from "./util.js";

const VERSIONS = "https://getcomposer.org/versions";
const BASE = "https://getcomposer.org";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/**
 * getcomposer.org's index, keyed by channel. Each entry states the phar path,
 * so the URL is never constructed from a version number here.
 * @typedef {{ stable?: ComposerRel[], preview?: ComposerRel[], snapshot?: ComposerRel[] }} VersionsDoc
 * @typedef {{ path: string, version: string, "min-php"?: number }} ComposerRel
 */

/** @returns {Promise<VersionInfo[]>} */
async function versions() {
  /** @type {VersionsDoc} */
  const doc = await fetchJson("composer-versions", VERSIONS, { ttlMs: 24 * 60 * 60_000 });
  const stable = doc.stable ?? [];
  /** @type {VersionInfo[]} */
  const list = stable
    .map((r) => ({ version: r.version, channel: "stable" }))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (list[0]) list[0].recommended = true;
  return list;
}

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  /** @type {VersionsDoc} */
  const doc = await fetchJson("composer-versions", VERSIONS, { ttlMs: 24 * 60 * 60_000 });
  const hit = (doc.stable ?? []).find((r) => r.version === version);
  // The path is stated by the index rather than built from the version, so a
  // change in their download layout does not silently 404 here.
  const path = hit?.path ?? `/download/${version}/composer.phar`;
  return { url: `${BASE}${path}`, file: "composer.phar" };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  const dir = paths.runtime("composer", version);
  return { binDir: dir, exe: join(dir, "composer.phar") };
}

/** @type {import("./index.js").Provider} */
export const composer = {
  id: "composer",
  label: "Composer",
  kind: "tool",
  multiVersion: true,
  blurb: "PHP dependency manager. One phar, run by the project's active PHP.",
  versions,
  download,
  layout,
  systemBin: ["composer"],
};
