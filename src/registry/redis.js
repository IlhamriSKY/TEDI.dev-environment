// Redis.
//
// Redis has published no official Windows build since 2016, and no official
// binary for macOS or Linux either: the project ships source and expects a
// package manager. So this provider is the one place where a COMMUNITY build is
// the only download option, and it says so.
//
// `redis-windows` is the maintained community port and publishes GitHub
// releases with a ready archive. On macOS and Linux the answer is the system
// install, which every package manager has. Redis is deliberately declared
// `multiVersion: false`: the owner asked for latest-only, and nothing about a
// local dev cache benefits from pinning an old Redis.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { compareVersions, shortArch } from "./util.js";

const RELEASES = "https://api.github.com/repos/redis-windows/redis-windows/releases";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/** @typedef {{ tag_name: string, prerelease: boolean, published_at: string,
 *              assets: { name: string, browser_download_url: string }[] }} GhRelease */

/** @returns {Promise<GhRelease[]>} */
async function releases() {
  return await fetchJson("redis-windows-releases", RELEASES, { ttlMs: 12 * 60 * 60_000 });
}

/** @returns {Promise<VersionInfo[]>} */
async function versions() {
  if (!isWindows()) {
    // Nothing to list: there is no download to offer, and pretending otherwise
    // would put versions in a picker that cannot install any of them.
    return [];
  }
  try {
    const rels = await releases();
    /** @type {VersionInfo[]} */
    const list = rels
      .filter((r) => !r.prerelease && pickAsset(r))
      .map((r) => ({
        version: r.tag_name.replace(/^v/i, ""),
        channel: "stable",
        released: r.published_at?.slice(0, 10),
      }))
      .sort((a, b) => compareVersions(a.version, b.version));
    if (list[0]) list[0].recommended = true;
    return list;
  } catch {
    return [];
  }
}

/**
 * The Windows archive on a release, if it has one.
 *
 * Matched on shape rather than on an exact filename: this repository has
 * changed its asset naming more than once, and an exact match would silently
 * stop finding anything the next time it does.
 *
 * @param {GhRelease} rel
 * @returns {{ name: string, browser_download_url: string } | undefined}
 */
function pickAsset(rel) {
  const assets = rel.assets ?? [];
  const wantArm = shortArch() === "arm64";
  const zips = assets.filter((a) => /\.zip$/i.test(a.name));
  return (
    zips.find((a) => (wantArm ? /arm64/i.test(a.name) : /x64|amd64|x86_64/i.test(a.name))) ??
    zips.find((a) => !/arm64/i.test(a.name)) ??
    zips[0]
  );
}

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  if (!isWindows()) return null;
  const rels = await releases();
  const rel = rels.find((r) => r.tag_name.replace(/^v/i, "") === version);
  const asset = rel ? pickAsset(rel) : undefined;
  if (!asset) return null;
  return {
    url: asset.browser_download_url,
    file: asset.name,
    note: "community build (redis-windows)",
  };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  const dir = paths.service("redis", version);
  return { binDir: dir, exe: join(dir, `redis-server${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const redis = {
  id: "redis",
  label: "Redis",
  kind: "service",
  multiVersion: false,
  defaultPort: 6379,
  blurb: "In-memory cache. Community build on Windows; the system package elsewhere.",
  versions,
  download,
  layout,
  systemBin: ["redis-server"],
  packageHint: "brew install redis  |  apt install redis-server",
};
