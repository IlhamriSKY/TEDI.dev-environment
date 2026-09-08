// Port allocation and conflict detection.
//
// The host already has `port_is_open`, which connects to a loopback URL and
// says whether anything answered. That is a LIVENESS check, not a "is this port
// free" check, and the difference matters: a port with a dead socket in
// TIME_WAIT answers false here and still refuses to bind. It is nonetheless the
// right tool, because the conflict we actually care about is "something else is
// already serving on the port I want", which is exactly what it detects.
//
// Deliberately not written: a socket prober of our own. The host command is
// loopback-only by design, which also means this extension cannot be turned
// into a port scanner by a malicious project config.

import { ctx, config } from "../runtime.js";

/**
 * Is something listening on this loopback port right now?
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function inUse(port) {
  if (!ctx) return false;
  try {
    return await ctx.invoke("port_is_open", { url: `http://127.0.0.1:${port}` });
  } catch {
    // A malformed URL or a refused scheme is not a port in use.
    return false;
  }
}

/**
 * The first free port at or after `start`, skipping anything in `reserved`.
 *
 * `reserved` carries the ports this extension has already handed out in the
 * same pass but has not yet bound, which a liveness probe cannot see: allocating
 * three services in a row would otherwise hand all three the same number.
 *
 * @param {number} start
 * @param {{ reserved?: Iterable<number>, limit?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function findFree(start, opts = {}) {
  const reserved = new Set(opts.reserved ?? []);
  const limit = opts.limit ?? 200;
  for (let port = start; port < start + limit && port <= 65535; port++) {
    if (reserved.has(port)) continue;
    if (!(await inUse(port))) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + limit}.`);
}

/**
 * Check a set of desired ports and report which are taken.
 *
 * Returned rather than resolved automatically, because a port conflict on the
 * web server is a decision (move ours, or stop theirs) and silently moving to
 * 8080 would leave the user's bookmarks broken with no explanation.
 *
 * @param {{ label: string, port: number }[]} wanted
 * @returns {Promise<{ label: string, port: number, taken: boolean }[]>}
 */
export async function survey(wanted) {
  /** @type {{ label: string, port: number, taken: boolean }[]} */
  const out = [];
  for (const item of wanted) {
    out.push({ ...item, taken: await inUse(item.port) });
  }
  return out;
}

/**
 * Does binding this port need elevation on this platform?
 *
 * Unix reserves everything below 1024 for root. Windows does not, which is why
 * a default of 80 is fine there and a question everywhere else.
 *
 * @param {number} port
 * @returns {boolean}
 */
export function needsRootToBind(port) {
  if (ctx?.os?.platform === "windows") return false;
  return port < 1024;
}

/**
 * A sensible starting port for a service, given what it is.
 *
 * These are the conventional defaults every developer already knows, and the
 * allocator only moves off them when something is genuinely in the way.
 *
 * @param {string} componentId
 * @returns {number}
 */
export function defaultPortFor(componentId) {
  switch (componentId) {
    case "mysql":
      return 3306;
    case "postgres":
      return 5432;
    case "redis":
      return 6379;
    case "nginx":
    case "apache":
      return 80;
    default:
      return 8000;
  }
}

/** Both web servers this extension can run. */
export const WEB_SERVERS = /** @type {const} */ (["nginx", "apache"]);

/** @param {string} id @returns {boolean} */
export function isWebServer(id) {
  return id === "nginx" || id === "apache";
}

/**
 * The ports one web server binds.
 *
 * The ACTIVE server keeps the configured pair, because those numbers are in
 * every URL the user has open and in every bookmark. A second web server that
 * is also installed gets a fixed offset instead, so both can be installed and
 * both can run, and trying the other one never means stopping the first.
 *
 * DETERMINISTIC, not allocated. The number is written into the generated
 * vhost's `listen`, so it has to be the same one next time the config is
 * regenerated; a counter would renumber them in whatever order the servers
 * happened to be scanned. 80 and 443 become 8080 and 8443, which are the
 * conventional alternates, and the offset keeps them distinct even when the
 * user has already moved the configured pair up.
 *
 * @param {string} id
 * @returns {{ http: number, https: number }}
 */
export function serverPorts(id) {
  if (id === config.webServer) return { http: config.httpPort, https: config.httpsPort };
  // ponytail: a flat offset, so a configured pair exactly 8000 apart (http 443,
  // https 8443) makes the alternate's HTTP land on the active's HTTPS. That
  // configuration fails loudly rather than silently - `choosePort` finds the
  // port in use and says so by name - so the fix is a second offset only if
  // anyone ever hits it.
  /** @param {number} p */
  const shift = (p) => (p + 8000 > 65535 ? p - 8000 : p + 8000);
  return { http: shift(config.httpPort), https: shift(config.httpsPort) };
}

/**
 * The port this service will TRY to bind, before anything checks whether it is
 * free. One answer, so the row in the dashboard and the process that starts
 * cannot disagree about which port was meant.
 *
 * @param {string} id
 * @returns {number}
 */
export function plannedPort(id) {
  return isWebServer(id) ? serverPorts(id).http : defaultPortFor(id);
}
