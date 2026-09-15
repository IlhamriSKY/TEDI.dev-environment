// cloudflared: a public address for a project, without an account.
//
// A "quick tunnel" (`cloudflared tunnel --url http://127.0.0.1:<port>`) dials
// OUT to Cloudflare's edge and is handed a random `*.trycloudflare.com` name
// with a real certificate. Nothing is opened on the router, no port is
// forwarded, nothing needs signing up for, and the process is the whole
// lifecycle: kill it and the address is gone. The alternatives each lose
// something that matters here - ngrok needs an account and a token, bore and
// its kin give plain TCP with no TLS on a shared public host, and an ssh
// reverse tunnel depends on a free service's terms of the week.
//
// NOT in the registry's list, deliberately. Everything there is installed by
// "Install everything", and a 20-50 MB download most people never use has no
// business in a first-run setup. It is installed the first time someone asks
// for a public link, through the same `install()` as everything else.

import { fetchJson } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { osKey, shortArch } from "./util.js";

const RELEASES = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

/** @typedef {{ tag_name: string, published_at: string,
 *              assets: { name: string, browser_download_url: string }[] }} GhRelease */

/** @returns {Promise<GhRelease>} */
async function latest() {
  return await fetchJson("cloudflared-latest", RELEASES, { ttlMs: 7 * 24 * 60 * 60_000 });
}

/**
 * The asset for this platform, by its EXACT name.
 *
 * A substring match is wrong here in a way it is not for mkcert: the release
 * carries `cloudflared-linux-amd64`, `cloudflared-linux-amd64.deb` and
 * `cloudflared-fips-linux-amd64` side by side. Windows has no arm64 build, and
 * the amd64 one runs under the emulation every Windows on ARM ships with.
 *
 * @returns {string}
 */
export function cloudflaredAsset() {
  const cpu = shortArch() === "arm64" ? "arm64" : "amd64";
  switch (osKey()) {
    case "windows":
      return "cloudflared-windows-amd64.exe";
    case "macos":
      return `cloudflared-darwin-${cpu}.tgz`;
    default:
      return `cloudflared-linux-${cpu}`;
  }
}

/** @returns {Promise<import("./index.js").VersionInfo[]>} */
async function versions() {
  const rel = await latest().catch(() => null);
  return rel
    ? [{ version: rel.tag_name.replace(/^v/i, ""), channel: "stable", recommended: true }]
    : [];
}

/** @param {string} _version @returns {Promise<import("./index.js").Download | null>} */
async function download(_version) {
  const rel = await latest().catch(() => null);
  const asset = rel?.assets?.find((a) => a.name === cloudflaredAsset());
  return asset ? { url: asset.browser_download_url, file: asset.name } : null;
}

/** @param {string} _version @returns {Promise<import("./index.js").Layout>} */
async function layout(_version) {
  // macOS ships a tarball, which unpacks into a folder of its own; the others
  // are a bare binary placed straight into tools/.
  if (osKey() === "macos") {
    const binDir = join(paths.tools(), "cloudflared");
    return { binDir, exe: join(binDir, "cloudflared") };
  }
  const binDir = paths.tools();
  return { binDir, exe: join(binDir, osKey() === "windows" ? "cloudflared.exe" : "cloudflared") };
}

/** @type {import("./index.js").Provider} */
export const cloudflared = {
  id: "cloudflared",
  label: "cloudflared",
  kind: "tool",
  multiVersion: false,
  blurb: "Cloudflare quick tunnels. Gives a project a temporary public https address.",
  versions,
  download,
  layout,
  systemBin: ["cloudflared"],
};
