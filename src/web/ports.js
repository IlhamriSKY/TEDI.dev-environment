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

import { ctx } from "../runtime.js";

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
