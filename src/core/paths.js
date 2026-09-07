// Path construction and the on-disk layout.
//
// Nothing here is a constant the user cannot change: the root comes from the
// extension's own `rootDir` setting and falls back to `~/.tedi/devenv`, the same
// `~/.tedi/<name>` convention `tedi.browser` uses. That location is deliberately
// OUTSIDE the extension install folder, because an extension update replaces
// that folder and a multi-gigabyte set of runtimes must survive one.
//
// The layout is exactly one level deep under each component
// (`runtimes/php/8.3.14/`), which is also what TEDI's own `path_probe.rs`
// expects when it descends one level into a parent like `bin\php` to find the
// versioned child. Staying that shape means the core "Additional PATH" probe
// reads our tree without being taught anything.

import { ctx, config, isWindows } from "../runtime.js";

/**
 * Join path parts with a separator the OS shell will accept.
 *
 * Forward slashes work in Win32 APIs but do not always survive `cmd` quoting,
 * so normalise once here rather than at every call site. Falsy parts are
 * dropped, which is what makes `join(home(), ...)` safe when the host could not
 * resolve a home directory.
 *
 * @param {...(string | number | undefined | null)} parts
 * @returns {string}
 */
export function join(...parts) {
  const sep = isWindows() ? "\\" : "/";
  const cleaned = parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => String(p).replace(/[\\/]+$/, ""));
  if (cleaned.length === 0) return "";
  return cleaned.join(sep).replace(/[\\/]+/g, sep);
}

/** Home directory with no trailing separator, or `""` when unresolvable.
 *  @returns {string} */
export function home() {
  return ctx?.paths?.home ?? "";
}

/** The configured data root. Falls back to `~/.tedi/devenv`.
 *  @returns {string} */
export function root() {
  const configured = config.rootDir?.trim();
  if (configured) return configured.replace(/[\\/]+$/, "");
  return join(home(), ".tedi", "devenv");
}

/** Last path segment, splitting on both separators.
 *  @param {string} p @returns {string} */
export function basename(p) {
  const parts = String(p ?? "").split(/[\\/]/);
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts[parts.length - 1] ?? "";
}

/** Everything before the last segment, or `""` at the root.
 *  @param {string} p @returns {string} */
export function dirname(p) {
  const parts = String(p ?? "").split(/[\\/]/);
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  parts.pop();
  return parts.join(isWindows() ? "\\" : "/");
}

/** Normalise for comparison: one separator, no trailing slash, case-folded on
 *  Windows because NTFS is case-insensitive.
 *  @param {string} p @returns {string} */
function normalize(p) {
  const s = String(p ?? "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return isWindows() ? s.toLowerCase() : s;
}

/** Compare two paths the way the platform filesystem would.
 *  @param {string} a @param {string} b @returns {boolean} */
export function samePath(a, b) {
  return normalize(a) === normalize(b);
}

/** Split a path into its segments, dropping empties.
 *  @param {string} p @returns {string[]} */
function segments(p) {
  return String(p ?? "")
    .split(/[\\/]/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Layout. One function per directory so no caller ever spells a path itself.
// ---------------------------------------------------------------------------

/** Provider metadata cache, TTL'd. Safe to delete at any time. */
function cache() {
  return join(root(), "cache");
}

/** Archives mid-download. Cleared on success and on next start. */
function downloads() {
  return join(root(), "downloads");
}

/** Installed runtime tree: `runtimes/<component>/<version>/`.
 *  @param {string} component @param {string} version @returns {string} */
function runtime(component, version) {
  return join(root(), "runtimes", component, version);
}

/** @param {string} component @returns {string} */
function runtimeBase(component) {
  return join(root(), "runtimes", component);
}

/** Web servers: `servers/<component>/<version>/`.
 *  @param {string} component @param {string} version @returns {string} */
function server(component, version) {
  return join(root(), "servers", component, version);
}

/** @param {string} component @returns {string} */
function serverBase(component) {
  return join(root(), "servers", component);
}

/** Service binaries: `services/<component>/<version>/`.
 *  @param {string} component @param {string} version @returns {string} */
function service(component, version) {
  return join(root(), "services", component, version);
}

/** @param {string} component @returns {string} */
function serviceBase(component) {
  return join(root(), "services", component);
}

/** Service DATA, kept apart from the binaries so upgrading a service does not
 *  put the user's databases inside a directory we are about to replace.
 *  @param {string} component @param {string} [version] @returns {string} */
function data(component, version) {
  return join(root(), "data", component, version ?? "default");
}

/** Single-file tools: composer.phar, mkcert. */
function tools() {
  return join(root(), "tools");
}

/**
 * Where projects live by default.
 *
 * Laragon's whole shape is one folder you can point at, back up or move, with
 * the binaries, the sites and the databases all inside it. Keeping `www/` under
 * the same root as `runtimes/` and `data/` is what makes that true here: the
 * root is the environment, and there is exactly one path to remember.
 *
 * A project OUTSIDE this folder still works - `addProject` takes any absolute
 * path - so an existing checkout somewhere else is never forced to move.
 */
function www() {
  return join(root(), "www");
}

/** Generated shims, the one directory that goes on the terminal PATH. */
function shims() {
  return join(root(), "shims");
}

/** Local CA and issued leaf certificates. */
function certs() {
  return join(root(), "certs");
}

/** Generated server and PHP configuration.
 *  @param {...string} rest @returns {string} */
function conf(...rest) {
  return join(root(), "conf", ...rest);
}

/**
 * Per-version php.ini.
 *
 * It lives in the runtime's own BIN directory, not under `conf/`, because that
 * is the only place PHP finds it without help: `php.exe` on Windows reads the
 * ini sitting beside it, and everywhere else the path is passed with `-c`,
 * which the shims and the FastCGI pool both build from the bin directory they
 * already resolved. Keeping it under `conf/` would mean every invocation of
 * `php` needed to know a second path.
 *
 * Two versions therefore never share a file, which is the point: `memory_limit`
 * and the enabled extension list belong to one runtime, not to the machine.
 *
 * @param {string} version @param {string} binDir @returns {string}
 */
function phpIni(version, binDir) {
  return join(binDir, "php.ini");
}

/** Generated vhost fragments, one file per project per server.
 *  @param {string} srv @returns {string} */
function vhosts(srv) {
  return join(root(), "conf", srv, "vhosts");
}

function logs() {
  return join(root(), "logs");
}

function runDir() {
  return join(root(), "run");
}

function configFile() {
  return join(root(), "config.json");
}

function projectsFile() {
  return join(root(), "projects.json");
}

/** Shim fallback when a project declares nothing. */
function globalEnv() {
  return join(root(), "global.env");
}

export const paths = {
  root,
  cache,
  downloads,
  runtime,
  runtimeBase,
  server,
  serverBase,
  service,
  serviceBase,
  data,
  tools,
  www,
  shims,
  certs,
  conf,
  phpIni,
  vhosts,
  logs,
  run: runDir,
  configFile,
  projectsFile,
  globalEnv,
};

/** Every directory that must exist before anything else runs.
 *  @returns {string[]} */
export function layoutDirs() {
  return [
    root(),
    paths.cache(),
    paths.downloads(),
    join(root(), "runtimes"),
    join(root(), "servers"),
    join(root(), "services"),
    join(root(), "data"),
    paths.tools(),
    paths.www(),
    paths.shims(),
    paths.certs(),
    paths.conf(),
    paths.logs(),
    paths.run(),
  ];
}

/** The system hosts file for this platform.
 *  @returns {string} */
export function hostsFile() {
  return isWindows() ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
}
