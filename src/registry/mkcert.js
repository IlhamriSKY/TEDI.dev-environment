// mkcert: the local certificate authority.
//
// Issuing a trusted local certificate is not one problem, it is four: generate
// a CA, install it into the OS trust store, install it into the NSS store that
// Firefox and Chromium keep separately on Linux, and issue leaf certificates
// against it. Each of those is different on every platform, and getting the
// trust-store step subtly wrong produces a certificate that looks fine in a
// terminal and shows a warning in the browser, which is the worst possible
// failure mode because it looks like the site is broken.
//
// mkcert is a single static Go binary that does exactly those four things and
// nothing else, on all three platforms. Downloading it is the same managed-tool
// pattern as everything else here, so it costs one provider and removes the
// entire per-platform trust-store branch from `web/certs.js`. `openssl` remains
// the fallback for a machine that cannot reach GitHub, and that fallback can
// issue certificates but cannot make them trusted, which the UI states.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { osKey, shortArch } from "./util.js";

const RELEASES = "https://api.github.com/repos/FiloSottile/mkcert/releases/latest";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

/** @typedef {{ tag_name: string, published_at: string,
 *              assets: { name: string, browser_download_url: string }[] }} GhRelease */

/** @returns {Promise<GhRelease>} */
async function latest() {
  return await fetchJson("mkcert-latest", RELEASES, { ttlMs: 7 * 24 * 60 * 60_000 });
}

/** The asset name fragment for this platform, as mkcert spells it. */
function target() {
  const arch = shortArch(); // x64 -> amd64 in their naming
  const cpu = arch === "arm64" ? "arm64" : "amd64";
  switch (osKey()) {
    case "windows":
      return { frag: `windows-${cpu}`, ext: ".exe" };
    case "macos":
      return { frag: `darwin-${cpu}`, ext: "" };
    default:
      return { frag: `linux-${cpu}`, ext: "" };
  }
}

/** @returns {Promise<VersionInfo[]>} */
async function versions() {
  try {
    const rel = await latest();
    return [
      {
        version: rel.tag_name.replace(/^v/i, ""),
        channel: "stable",
        released: rel.published_at?.slice(0, 10),
        recommended: true,
      },
    ];
  } catch {
    return [];
  }
}

/** @param {string} version @returns {Promise<Download | null>} */
async function download(version) {
  const rel = await latest().catch(() => null);
  if (!rel) return null;
  const { frag } = target();
  const asset = (rel.assets ?? []).find((a) => a.name.includes(frag));
  if (!asset) return null;
  return { url: asset.browser_download_url, file: asset.name };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function layout(version) {
  // A single binary, so it lives in tools/ rather than a versioned tree: there
  // is no reason to keep two mkcerts, and the CA it manages is per machine, not
  // per version.
  const binDir = paths.tools();
  return { binDir, exe: join(binDir, `mkcert${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const mkcert = {
  id: "mkcert",
  label: "mkcert",
  kind: "tool",
  multiVersion: false,
  blurb: "Local certificate authority. Makes https://project.test trusted by the browser.",
  versions,
  download,
  layout,
  systemBin: ["mkcert"],
};
