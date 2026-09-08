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
 * The ports a web server binds: the configured pair, whichever server it is.
 *
 * @param {string} id
 * @returns {{ http: number, https: number }}
 */
export function serverPorts(id) {
  // Both servers, the same pair, because only one of them ever runs: starting
  // one stops the other (`services.start`).
  //
  // They used to differ - the non-default one took a fixed +8000 - so that both
  // could serve at once. That was a worse answer to a question nobody asked.
  // Two web servers up means your project answers on two addresses with two
  // sets of rules, and the second is the one you did not configure; the port
  // offset then had to be explained, and it appeared in a URL nobody typed.
  // One server, on the port you chose, is what a local environment is for.
  void id;
  return { http: config.httpPort, https: config.httpsPort };
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
  if (isWebServer(id)) return serverPorts(id).http;
  return config.ports[id] ?? defaultPortFor(id);
}

/**
 * Did the user CHOOSE this port, or is it just the convention?
 *
 * The difference decides what happens when it is taken. A database on its
 * conventional 3306 moves out of the way, because nothing is pointing at it
 * yet and refusing to start would be an obstacle. A database on a port somebody
 * typed does not move: they typed it because something else is pointing at it,
 * and silently landing on 3307 would break exactly the thing the choice was
 * made for.
 *
 * @param {string} id @returns {boolean}
 */
export function portIsPinned(id) {
  return isWebServer(id) || config.ports[id] !== undefined;
}
