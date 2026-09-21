// Mailpit: the mail a development site sends, caught instead of delivered.
//
// The problem it solves is the one every local environment has and none of them
// mention: a site under development sends password resets, invoices and
// verification links, and on a laptop those either fail silently or go to a real
// person. Mailpit answers SMTP on 1025, keeps everything in memory and shows it
// in a web inbox - so mail is testable, and nothing can escape to a customer.
//
// One binary, no runtime, no configuration file, and a release for every
// platform this extension supports, which is why it is a managed download here
// rather than a "use your package manager" note like Redis. Latest-only
// (`multiVersion: false`): nothing about a development mailbox benefits from
// pinning an old one.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { exeSuffix } from "../runtime.js";
import { compareVersions, osKey, shortArch } from "./util.js";

const RELEASES = "https://api.github.com/repos/axllent/mailpit/releases";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/** @typedef {{ tag_name: string, prerelease: boolean, published_at: string,
 *              assets: { name: string, browser_download_url: string }[] }} GhRelease */

/** @returns {Promise<GhRelease[]>} */
async function releases() {
  return await fetchJson("mailpit-releases", RELEASES, { ttlMs: 12 * 60 * 60_000 });
}

/**
 * The asset for this platform, by its EXACT name.
 *
 * Exact rather than by shape, because every one of the eight assets on a
 * release is a build of the same program for a different machine and a loose
 * match picks one that cannot run. The naming is `mailpit-<os>-<arch>`, and
 * Windows ships a zip where the others ship a tarball.
 *
 * Exported for the self-check.
 *
 * @returns {string}
 */
export function mailpitAsset() {
  const cpu = shortArch() === "arm64" ? "arm64" : "amd64";
  const os = osKey();
  if (os === "windows") return `mailpit-windows-${cpu}.zip`;
  // Go's own name for macOS, which is what these assets carry. `osKey()` says
  // `macos`, and the difference is one asset that does not exist and a version
  // list that comes back empty on every Mac.
  return `mailpit-${os === "macos" ? "darwin" : "linux"}-${cpu}.tar.gz`;
}

/** @returns {Promise<VersionInfo[]>} */
async function versions() {
  try {
    const wanted = mailpitAsset();
    /** @type {VersionInfo[]} */
    const list = (await releases())
      .filter((r) => !r.prerelease && (r.assets ?? []).some((a) => a.name === wanted))
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

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  const rel = (await releases()).find((r) => r.tag_name.replace(/^v/i, "") === version);
  const asset = (rel?.assets ?? []).find((a) => a.name === mailpitAsset());
  return asset ? { url: asset.browser_download_url, file: asset.name } : null;
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  const dir = paths.service("mailpit", version);
  return { binDir: dir, exe: join(dir, `mailpit${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const mailpit = {
  id: "mailpit",
  label: "Mailpit",
  kind: "service",
  multiVersion: false,
  // The WEB inbox, because that is the port a person opens and the one the row
  // offers. SMTP is fixed at 1025 by the launcher: it is the number every
  // framework's example configuration already carries, and a mail port nobody
  // typed is a mail port nobody has to change.
  defaultPort: 8025,
  blurb: "Catches mail your sites send. SMTP on 1025, with a web inbox.",
  versions,
  download,
  layout,
  systemBin: ["mailpit"],
  // `mailpit --version` is an unknown flag; the version is a SUBCOMMAND. The
  // installer's post-install check runs this, and without it every install
  // ended with a warning about a binary that is in fact fine.
  versionArgs: ["version"],
};
