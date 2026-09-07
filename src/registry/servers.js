// Web servers: Nginx and Apache.
//
// Both are Windows-download / system-elsewhere, for the same reason as the
// databases: nginx.org publishes an official Windows zip and nothing else, and
// Apache's Windows builds come from Apache Lounge because the ASF itself ships
// only source. On macOS and Linux both are one package-manager command away and
// the detected system binary is used.
//
// Apache Lounge is the one source here with neither an API nor a derivable
// filename: the archive name carries a build date (`httpd-2.4.62-240904-win64-
// VS17.zip`) that no version number predicts. So it is scraped, once, from the
// page that lists it. If that scrape ever fails the provider returns an empty
// list rather than a guess, and the UI offers Nginx instead.

import { fetchText } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { compareVersions, osKey } from "./util.js";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

const NGINX_DOWNLOAD = "https://nginx.org/download/";

/** @returns {Promise<VersionInfo[]>} */
async function nginxVersions() {
  if (!isWindows()) return [];
  try {
    const html = await fetchText(NGINX_DOWNLOAD, { timeoutMs: 30_000 });
    // The directory index lists every archive; the .zip ones are the Windows
    // builds, which is exactly the filter we want.
    const found = new Set([...html.matchAll(/nginx-(\d+\.\d+\.\d+)\.zip/g)].map((m) => m[1]));
    /** @type {VersionInfo[]} */
    const list = [...found]
      .map((version) => ({ version, channel: "stable" }))
      .sort((a, b) => compareVersions(a.version, b.version));
    if (list[0]) list[0].recommended = true;
    return list;
  } catch {
    return [];
  }
}

/** @param {string} version @returns {Promise<Download | null>} */
async function nginxDownload(version) {
  if (!isWindows()) return null;
  const file = `nginx-${version}.zip`;
  return { url: `${NGINX_DOWNLOAD}${file}`, file };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function nginxLayout(version) {
  const dir = paths.server("nginx", version);
  // The Windows zip unwraps to `nginx-<ver>/` with nginx.exe at its root.
  const binDir = isWindows() ? dir : join(dir, "sbin");
  return { binDir, exe: join(binDir, `nginx${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const nginx = {
  id: "nginx",
  label: "Nginx",
  kind: "server",
  multiVersion: true,
  defaultPort: 80,
  blurb: "The default web server. Serves virtual hosts and speaks FastCGI to PHP.",
  versions: nginxVersions,
  download: nginxDownload,
  layout: nginxLayout,
  systemBin: ["nginx"],
  packageHint: "brew install nginx  |  apt install nginx",
};

// ---------------------------------------------------------------------------
// Apache
// ---------------------------------------------------------------------------

const LOUNGE_PAGE = "https://www.apachelounge.com/download/";

/** Cached scrape: version -> archive URL. One page fetch answers both
 *  `versions()` and `download()`, and they must agree or a listed version
 *  fails to install. @type {Map<string, string> | null} */
let loungeIndex = null;

/** @returns {Promise<Map<string, string>>} */
async function apacheIndex() {
  if (loungeIndex) return loungeIndex;
  const map = new Map();
  try {
    const html = await fetchText(LOUNGE_PAGE, { timeoutMs: 30_000 });
    // e.g. /download/VS17/binaries/httpd-2.4.62-240904-win64-VS17.zip
    for (const m of html.matchAll(
      /((?:\/download\/)?VS\d+\/binaries\/httpd-(\d+\.\d+\.\d+)-[\w-]*win64-VS\d+\.zip)/g,
    )) {
      const rel = m[1].startsWith("/") ? m[1] : `/download/${m[1]}`;
      map.set(m[2], `https://www.apachelounge.com${rel}`);
    }
  } catch {
    /* leave the map empty; callers treat that as "no builds found" */
  }
  loungeIndex = map;
  return map;
}

/** @returns {Promise<VersionInfo[]>} */
async function apacheVersions() {
  if (!isWindows()) return [];
  const index = await apacheIndex();
  /** @type {VersionInfo[]} */
  const list = [...index.keys()]
    .map((version) => ({ version, channel: "stable" }))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (list[0]) list[0].recommended = true;
  return list;
}

/** @param {string} version @returns {Promise<Download | null>} */
async function apacheDownload(version) {
  if (!isWindows()) return null;
  const index = await apacheIndex();
  const url = index.get(version);
  if (!url) return null;
  return {
    url,
    file: url.split("/").pop() ?? `httpd-${version}-win64.zip`,
    note: "Apache Lounge build",
  };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function apacheLayout(version) {
  const dir = paths.server("apache", version);
  // The Lounge zip unwraps to `Apache24/` with bin/httpd.exe inside.
  const binDir = join(dir, "bin");
  return { binDir, exe: join(binDir, `httpd${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const apache = {
  id: "apache",
  label: "Apache",
  kind: "server",
  multiVersion: true,
  defaultPort: 80,
  blurb: "Alternative web server, for projects that rely on .htaccess.",
  versions: apacheVersions,
  download: apacheDownload,
  layout: apacheLayout,
  systemBin: ["httpd", "apache2"],
  packageHint: "brew install httpd  |  apt install apache2",
};
