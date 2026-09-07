// Node.js. The easiest provider here: nodejs.org publishes an official index
// listing every release with the exact set of build targets it produced, and
// official binaries exist for all three platforms on both architectures. No
// probing, no scraping, no fallback.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { compareVersions, shortArch, osKey } from "./util.js";

const DIST = "https://nodejs.org/dist";
const INDEX = `${DIST}/index.json`;

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/**
 * One row of nodejs.org's index. `lts` is `false` for a current release and the
 * codename string for an LTS one, which is exactly the distinction the picker
 * wants to show.
 * @typedef {{ version: string, date: string, files: string[], lts: false | string }} DistEntry
 */

/**
 * The archive basename for this platform, and the extension it carries.
 *
 * Linux ships `.tar.xz` (and `.tar.gz`); xz is roughly half the size and both
 * GNU tar and bsdtar decompress it from `-xf` without a flag, so there is no
 * reason to take the larger one.
 *
 * @returns {{ target: string, ext: string }}
 */
function platformTarget() {
  const arch = shortArch();
  switch (osKey()) {
    case "windows":
      return { target: `win-${arch}`, ext: "zip" };
    case "macos":
      return { target: `darwin-${arch}`, ext: "tar.gz" };
    default:
      return { target: `linux-${arch}`, ext: "tar.xz" };
  }
}

/** @returns {Promise<VersionInfo[]>} */
async function versions() {
  /** @type {DistEntry[]} */
  const index = await fetchJson("node-dist", INDEX, { ttlMs: 6 * 60 * 60_000 });
  const { target } = platformTarget();

  /** @type {VersionInfo[]} */
  const list = index
    // Only offer a version this platform actually has a build for. The index
    // states it per release, so an ARM64 machine never sees a version that
    // predates ARM64 builds.
    .filter((e) => Array.isArray(e.files) && e.files.some((f) => f.startsWith(target)))
    .map((e) => ({
      version: e.version.replace(/^v/, ""),
      channel: e.lts ? "lts" : "stable",
      released: e.date,
    }))
    .sort((a, b) => compareVersions(a.version, b.version));

  // Recommend the newest LTS rather than the newest release: it is what a
  // project that did not say otherwise should be built against.
  const lts = list.find((v) => v.channel === "lts");
  if (lts) lts.recommended = true;
  else if (list[0]) list[0].recommended = true;
  return list;
}

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  const { target, ext } = platformTarget();
  const file = `node-v${version}-${target}.${ext}`;
  return { url: `${DIST}/v${version}/${file}`, file };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  const dir = paths.runtime("node", version);
  // The Windows zip puts node.exe, npm.cmd and npx.cmd at the root of the
  // unwrapped folder; every Unix tarball uses the usual bin/ layout.
  const binDir = isWindows() ? dir : join(dir, "bin");
  return { binDir, exe: join(binDir, `node${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const node = {
  id: "node",
  label: "Node.js",
  kind: "runtime",
  multiVersion: true,
  blurb: "JavaScript runtime, plus the npm that ships with each release.",
  versions,
  download,
  layout,
  systemBin: ["node"],
};
