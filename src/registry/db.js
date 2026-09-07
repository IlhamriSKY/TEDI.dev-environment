// Database servers.
//
// These two are the clearest illustration of why `download()` may answer null.
//
// PostgreSQL publishes ready-to-run binary bundles through EnterpriseDB for
// Windows and macOS, and does NOT publish them for Linux, where the project
// expects you to use a distribution package or their apt/yum repository. So on
// Linux this provider offers the detected system install and names the command,
// rather than inventing a URL that returns 403.
//
// MySQL has no machine-readable version index at all. The current version is
// scraped from the one page that always states it, and the UI additionally
// accepts a typed version, so a user who needs an exact older release is not
// blocked by the absence of an API. Its macOS archives embed the macOS SDK
// version in the filename (`mysql-X-macos14-arm64.tar.gz`), which is not
// derivable from the version alone, so macOS falls back to the system install
// too rather than guessing and 404ing.

import { fetchText, fetchJson, urlExists } from "../core/net.js";
import { paths, join } from "../core/paths.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { compareVersions, majorMinor, osKey, shortArch } from "./util.js";

/** @typedef {import("./index.js").VersionInfo} VersionInfo */
/** @typedef {import("./index.js").Download} Download */

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const PG_VERSIONS = "https://www.postgresql.org/versions.json";
const PG_BINARIES = "https://get.enterprisedb.com/postgresql";

/** @typedef {{ major: string, latestMinor: string, supported: boolean, current?: boolean }} PgRow */

/** @returns {Promise<VersionInfo[]>} */
async function pgVersions() {
  /** @type {PgRow[]} */
  const rows = await fetchJson("postgres-versions", PG_VERSIONS, { ttlMs: 24 * 60 * 60_000 });
  /** @type {VersionInfo[]} */
  const list = rows
    .filter((r) => r.supported)
    .map((r) => ({
      version: `${r.major}.${r.latestMinor}`,
      channel: r.current ? "stable" : "supported",
    }))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (list[0]) list[0].recommended = true;
  return list;
}

/** @param {string} version @returns {Promise<Download | null>} */
async function pgDownload(version) {
  const os = osKey();
  // EDB's platform token, and the fact they only build these two.
  const plat = os === "windows" ? `windows-x64` : os === "macos" ? "osx" : null;
  if (!plat) return null;
  const file = `postgresql-${version}-1-${plat}-binaries.zip`;
  const url = `${PG_BINARIES}/${file}`;
  if (!(await urlExists(url))) return null;
  return { url, file };
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function pgLayout(version) {
  // The EDB archive unwraps to `pgsql/` containing bin/, lib/, share/.
  const dir = paths.service("postgres", version);
  const binDir = join(dir, "bin");
  return { binDir, exe: join(binDir, `postgres${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const postgres = {
  id: "postgres",
  label: "PostgreSQL",
  kind: "service",
  multiVersion: true,
  defaultPort: 5432,
  blurb: "Relational database. Binary bundles on Windows and macOS; the system package on Linux.",
  versions: pgVersions,
  download: pgDownload,
  layout: pgLayout,
  systemBin: ["postgres", "pg_ctl"],
  packageHint: "apt install postgresql  |  dnf install postgresql-server",
};

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const MYSQL_PAGE = "https://dev.mysql.com/downloads/mysql/";
const MYSQL_GET = "https://dev.mysql.com/get/Downloads";

/** glibc builds MySQL has shipped against; probed newest first because a newer
 *  glibc build exists only for newer releases. */
const GLIBC_CANDIDATES = ["2.28", "2.17"];

/**
 * The versions MySQL currently advertises.
 *
 * Scraped, because there is no index to fetch. The page always contains the
 * Windows archive name, and that name always contains the exact version, so one
 * regex over one page is both the smallest and the most reliable thing
 * available. A failure returns an empty list rather than throwing: the UI still
 * offers "install a specific version" and the user is not stuck.
 *
 * @returns {Promise<VersionInfo[]>}
 */
async function mysqlVersions() {
  try {
    const html = await fetchText(MYSQL_PAGE, { timeoutMs: 30_000 });
    const found = new Set([...html.matchAll(/mysql-(\d+\.\d+\.\d+)-winx64/g)].map((m) => m[1]));
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
async function mysqlDownload(version) {
  const branch = majorMinor(version);
  const os = osKey();

  if (os === "windows") {
    const file = `mysql-${version}-winx64.zip`;
    const url = `${MYSQL_GET}/MySQL-${branch}/${file}`;
    return (await urlExists(url)) ? { url, file } : null;
  }

  if (os === "linux" && shortArch() === "x64") {
    for (const glibc of GLIBC_CANDIDATES) {
      const file = `mysql-${version}-linux-glibc${glibc}-x86_64.tar.xz`;
      const url = `${MYSQL_GET}/MySQL-${branch}/${file}`;
      if (await urlExists(url)) return { url, file };
    }
    return null;
  }

  // macOS archives carry the macOS SDK version in the filename, which cannot be
  // derived from the MySQL version. Rather than probe a matrix of guesses, say
  // there is no build and let the system install answer.
  return null;
}

/** @param {string} version @returns {Promise<import("./index.js").Layout>} */
async function mysqlLayout(version) {
  const dir = paths.service("mysql", version);
  const binDir = join(dir, "bin");
  return { binDir, exe: join(binDir, `mysqld${exeSuffix()}`) };
}

/** @type {import("./index.js").Provider} */
export const mysql = {
  id: "mysql",
  label: "MySQL",
  kind: "service",
  multiVersion: true,
  defaultPort: 3306,
  blurb: "Relational database. Official archives on Windows and Linux x64.",
  versions: mysqlVersions,
  download: mysqlDownload,
  layout: mysqlLayout,
  systemBin: ["mysqld"],
  packageHint: isWindows() ? "" : "brew install mysql  |  apt install mysql-server",
};
