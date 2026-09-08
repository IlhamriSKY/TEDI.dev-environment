// Where a web server keeps its OWN files.
//
// The generated configuration has to name three things that belong to the
// server rather than to us: nginx's `mime.types` and `fastcgi_params`, and
// Apache's `ServerRoot` plus the directory its `.so` modules live in. Every one
// of them is somewhere different depending on how the server got onto the
// machine.
//
// This used to be derived from `installedOf(id)[0].dir`, which is the DOWNLOAD
// directory for a managed install and, for a detected system one, the directory
// the BINARY sits in - because that is all `detectSystem` can honestly claim to
// know. So on macOS and Linux, where neither server has a download and both are
// always system installs, the generated config said:
//
//     include "/usr/sbin/conf/mime.types"      # nginx
//     ServerRoot "/usr/sbin"                    # Apache
//
// Neither path exists, so neither server could start. That is two of the three
// platforms this extension claims to support, and nothing caught it because
// nothing here had ever been run on them.
//
// So the locations are ASKED FOR rather than derived. Both servers will tell
// you where they were compiled to look (`nginx -V` prints `--conf-path=`,
// `httpd -V` prints `HTTPD_ROOT`), and the answer is then confirmed by looking
// for a file that must be there. A candidate list covers the builds that do not
// answer, and a wrong guess is impossible to act on because nothing is returned
// unless the file was actually found.
//
// Apache's module list is READ, never assumed, for the same class of reason:
// the Windows build ships no `mod_mpm_event.so` and no `mod_unixd.so` at all
// (the WinNT MPM is built in, and unixd is POSIX-only), so a hardcoded
// `LoadModule` list refuses to start with "Cannot load modules/mod_mpm_event.so
// into server" on the one platform that has an official download.

import { join, dirname } from "../core/paths.js";
import { exists, readDir, isDir } from "../core/fsx.js";
import { run } from "../core/proc.js";
import { exeSuffix, isWindows, warn } from "../runtime.js";

/** @typedef {import("../runtime.js").InstalledVersion} InstalledVersion */

/** Executable names each server is published under. Debian and Ubuntu rename
 *  Apache's binary to `apache2`, which is why this is a list and not a string:
 *  `join(binDir, "httpd")` finds nothing there. */
const EXE_NAMES = { nginx: ["nginx"], apache: ["httpd", "apache2"] };

/**
 * The server binary to run for an installed row.
 *
 * @param {"nginx" | "apache"} id
 * @param {InstalledVersion} row
 * @returns {Promise<string>}
 */
export async function serverExe(id, row) {
  const names = EXE_NAMES[id];
  for (const name of names) {
    const candidate = join(row.binDir, `${name}${exeSuffix()}`);
    if (await exists(candidate)) return candidate;
  }
  // Nothing found: hand back the conventional name so the failure names a path
  // rather than an empty string.
  return join(row.binDir, `${names[0]}${exeSuffix()}`);
}

/**
 * The first candidate directory that contains `marker`.
 *
 * Existence of the marker is the whole test. A directory that merely exists
 * proves nothing - `/usr/sbin` exists - and returning it would put an
 * unusable path into a config file that then fails at start with an error
 * pointing at the wrong thing.
 *
 * @param {(string | null | undefined)[]} candidates
 * @param {string} marker  A filename that must be present.
 * @returns {Promise<string | null>}
 */
async function firstWith(candidates, marker) {
  const want = marker.toLowerCase();
  for (const dir of candidates) {
    if (!dir) continue;
    const entries = await readDir(dir, false);
    if (entries.some((e) => e.name.toLowerCase() === want)) return dir;
  }
  return null;
}

/**
 * Run `<exe> -V` and return its output.
 *
 * Both servers print their build configuration on STDERR and exit non-zero on
 * neither, so the combined stream `run()` collects is exactly what is wanted.
 * A failure is not an error here: the candidate list below covers it.
 *
 * @param {string} exe @returns {Promise<string>}
 */
async function buildInfo(exe) {
  const res = await run(exe, ["-V"], { timeoutMs: 15_000 }).catch(() => null);
  return res?.out ?? "";
}

/**
 * Where nginx's own `conf/` lives, or null when it could not be found.
 *
 * @param {InstalledVersion} row
 * @returns {Promise<string | null>}
 */
export async function nginxConfDir(row) {
  const info = await buildInfo(await serverExe("nginx", row));
  // `--conf-path=/etc/nginx/nginx.conf` names the FILE; its directory is what
  // holds mime.types and fastcgi_params.
  const declared = info.match(/--conf-path=(\S+)/)?.[1];

  const found = await firstWith(
    [
      // A managed install: the Windows zip unpacks `conf/` beside `nginx.exe`.
      join(row.dir, "conf"),
      row.dir,
      declared ? dirname(declared) : null,
      "/etc/nginx",
      "/usr/local/etc/nginx",
      "/opt/homebrew/etc/nginx",
    ],
    "mime.types",
  );
  if (!found) warn("could not find nginx's conf directory; mime types will be missing");
  return found;
}

/**
 * @typedef {object} ApachePaths
 * @property {string} serverRoot   Absolute, and it exists.
 * @property {string | null} modulesDir  Absolute, and it holds `mod_dir.so`.
 * @property {Set<string>} modules  The `.so` filenames actually present there.
 * @property {string | null} mimeTypes   Absolute path to a `mime.types`.
 */

/**
 * Everything Apache's generated config needs to name about Apache itself.
 *
 * @param {InstalledVersion} row
 * @returns {Promise<ApachePaths>}
 */
export async function apachePaths(row) {
  const info = await buildInfo(await serverExe("apache", row));
  const declared = info.match(/HTTPD_ROOT="([^"]+)"/)?.[1];

  const roots = [
    // A managed install: the archive unpacks `modules/` beside `bin/`.
    row.dir,
    declared,
    "/etc/apache2",
    "/etc/httpd",
    "/usr/local/apache2",
    "/opt/homebrew/etc/httpd",
  ];

  const modulesDir = await firstWith(
    [
      ...roots.map((r) => (r ? join(r, "modules") : null)),
      "/usr/lib/apache2/modules",
      "/usr/lib64/httpd/modules",
      "/usr/lib/httpd/modules",
      "/usr/libexec/apache2",
      "/opt/homebrew/lib/httpd/modules",
    ],
    `mod_dir.so`,
  );

  /** @type {Set<string>} */
  const modules = new Set();
  if (modulesDir) {
    for (const entry of await readDir(modulesDir, false)) {
      if (/\.so$/i.test(entry.name)) modules.add(entry.name.toLowerCase());
    }
  }

  // ServerRoot only has to be a real directory - Apache resolves whatever is
  // still relative against it, and everything this extension writes is
  // absolute. Prefer the one the binary itself declares.
  let serverRoot = row.dir;
  for (const candidate of roots) {
    if (candidate && (await isDir(candidate))) {
      serverRoot = candidate;
      break;
    }
  }

  const mimeDir = await firstWith(
    [join(serverRoot, "conf"), serverRoot, "/etc/apache2", "/etc"],
    "mime.types",
  );

  if (!modulesDir) {
    warn("could not find Apache's modules directory; no LoadModule lines will be written");
  }

  return {
    serverRoot,
    modulesDir,
    modules,
    mimeTypes: mimeDir ? join(mimeDir, "mime.types") : null,
  };
}

/**
 * The `LoadModule` lines to write, given what is actually on disk.
 *
 * Pure, and exported, because this is the list whose failure mode is a server
 * that refuses to start: Apache aborts on the first `LoadModule` naming a file
 * it cannot open, so a module that is compiled in rather than shipped as a
 * `.so` - which is every MPM on Windows - must be left out rather than named
 * optimistically. Dropping one is safe in the other direction too: a build that
 * has the feature compiled in already has it.
 *
 * @param {Set<string>} available  Lowercased `.so` filenames present.
 * @param {string | null} modulesDir  Absolute; names are emitted against it.
 * @returns {string[]}
 */
export function loadModuleLines(available, modulesDir) {
  if (!modulesDir) return [];
  /** The modules the generated vhosts actually use. Both MPMs are listed
   *  because exactly one of them exists on any given build, and on Windows
   *  neither does. */
  const wanted = [
    ["mpm_event_module", "mod_mpm_event.so"],
    ["mpm_prefork_module", "mod_mpm_prefork.so"],
    ["authz_core_module", "mod_authz_core.so"],
    ["dir_module", "mod_dir.so"],
    ["mime_module", "mod_mime.so"],
    ["log_config_module", "mod_log_config.so"],
    ["unixd_module", "mod_unixd.so"],
    ["proxy_module", "mod_proxy.so"],
    ["proxy_fcgi_module", "mod_proxy_fcgi.so"],
    ["proxy_http_module", "mod_proxy_http.so"],
    ["rewrite_module", "mod_rewrite.so"],
    ["ssl_module", "mod_ssl.so"],
    ["socache_shmcb_module", "mod_socache_shmcb.so"],
    ["headers_module", "mod_headers.so"],
    ["setenvif_module", "mod_setenvif.so"],
    ["alias_module", "mod_alias.so"],
  ];

  /** @type {string[]} */
  const lines = [];
  let mpm = false;
  for (const [name, file] of wanted) {
    if (!available.has(file)) continue;
    // Two MPMs cannot be loaded at once; the first one present wins.
    if (name.startsWith("mpm_")) {
      if (mpm) continue;
      mpm = true;
    }
    const path = join(modulesDir, file);
    lines.push(`LoadModule ${name} "${isWindows() ? path.replace(/\\/g, "/") : path}"`);
  }
  return lines;
}
