// Who is holding a port, and how to make them stop.
//
// "Port 80 is already in use" is a true sentence and a useless one: it names
// the problem and nothing you can act on. Nine times in ten the answer is
// another copy of the same server left running by something else on the
// machine, and the fix is one signal to one process - but only if the pane can
// say WHICH process, because "kill whatever has port 80" is not a thing anyone
// should press blind.
//
// So this asks the operating system rather than guessing, and it asks with the
// tools that are already on every machine: `netstat` + `tasklist` on Windows,
// `lsof` on macOS, `lsof` or `ss` on Linux. No new dependency, and nothing here
// is installed for it.
//
// The kill is deliberately two-stage. A plain attempt first, because the common
// case is a process this user started and owns; elevation only when that is
// refused, so nobody is asked for administrator rights to stop their own
// `php -S`.

import { run } from "../core/proc.js";
import { elevate } from "../core/elevate.js";
import { isWindows, isMac, warn } from "../runtime.js";
import { inUse } from "./ports.js";

/**
 * @typedef {object} PortOwner
 * @property {number} pid   The TOP of the same-executable process tree, which
 *   is not always the process holding the socket. See `rootOf`.
 * @property {string} name  The executable, as the OS reports it. "?" when only
 *   the pid could be found, which is still enough to act on.
 * @property {string | null} [path]  Full path to that executable, when the
 *   platform could give one. This is what "is it ours" is decided on.
 */

/**
 * What is listening on `port`, or `null` if nothing is or nothing could be
 * determined.
 *
 * Never throws: this runs to improve an error message, and an error message
 * that fails is worse than the plain one it was improving.
 *
 * @param {number} port
 * @returns {Promise<PortOwner | null>}
 */
export async function portOwner(port) {
  try {
    return isWindows() ? await windowsOwner(port) : await posixOwner(port);
  } catch (err) {
    warn("could not identify what holds port", port, err);
    return null;
  }
}

/**
 * Windows: `netstat -ano` for the pid, then `tasklist` for the name.
 *
 * `-p TCP` rather than the whole table, and LISTENING only - an outbound
 * connection FROM port 80 is not what is blocking a bind, and matching it would
 * offer to kill a browser.
 *
 * @param {number} port @returns {Promise<PortOwner | null>}
 */
async function windowsOwner(port) {
  const res = await run("netstat", ["-ano", "-p", "TCP"], { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  const listener = parseNetstat(res.out, port);
  if (listener === null) return null;

  // Resolve the tree, the name and the path in ONE call rather than three.
  const root = await windowsRoot(listener);
  if (root) return root;

  // The walk failed for some reason; the listening pid and its name are still
  // better than nothing.
  const named = await run("tasklist", ["/FI", `PID eq ${listener}`, "/FO", "CSV", "/NH"], {
    timeoutMs: 15_000,
  });
  return {
    pid: listener,
    name: (named.code === 0 ? parseTasklist(named.out) : null) ?? "?",
    path: null,
  };
}

/**
 * Walk up from the listening pid while the parent runs the same executable.
 *
 * This is the whole reason "stop it" did not stop anything. nginx on Windows is
 * a master plus workers, and the LISTENING socket belongs to a WORKER: killing
 * that pid, tree and all, leaves the master to spawn a replacement which
 * inherits the socket, so the port is never released and the button appears to
 * do nothing. Killing the topmost nginx.exe takes the whole thing down. Apache,
 * MySQL and PHP-FPM all have the same shape.
 *
 * Stops at the first parent running something ELSE, which is what keeps it from
 * walking out of the server and into TEDI - the master's parent is this app.
 *
 * @param {number} pid @returns {Promise<PortOwner | null>}
 */
async function windowsRoot(pid) {
  // The comparison key is the full path when it is readable and the image name
  // when it is not. A protected system process reports NO ExecutablePath to an
  // unelevated query, and comparing two empty strings said "same binary" for
  // every parent - so a walk from `svchost.exe` climbed through `services.exe`
  // all the way to `wininit.exe`, and the button would have offered to kill it.
  const script = [
    `$me = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
    "if (-not $me) { exit 1 }",
    "$path = $me.ExecutablePath",
    "$key = if ($me.ExecutablePath) { $me.ExecutablePath } else { $me.Name }",
    "if (-not $key) { exit 1 }",
    "for ($i = 0; $i -lt 16; $i++) {",
    "  $pp = $me.ParentProcessId",
    "  if (-not $pp -or $pp -le 0) { break }",
    '  $par = Get-CimInstance Win32_Process -Filter "ProcessId=$pp" -ErrorAction SilentlyContinue',
    "  if (-not $par) { break }",
    "  $pk = if ($par.ExecutablePath) { $par.ExecutablePath } else { $par.Name }",
    "  if (-not $pk -or $pk -ne $key) { break }",
    "  $me = $par",
    "  if ($me.ExecutablePath) { $path = $me.ExecutablePath }",
    "}",
    "Write-Output $me.ProcessId",
    "Write-Output $me.Name",
    "Write-Output $path",
  ].join("; ");

  const res = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 25_000,
  });
  if (res.code !== 0) return null;
  const lines = res.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const root = Number(lines[0]);
  if (!Number.isInteger(root) || root <= 0) return null;
  // Three lines when the path was readable, two when it was not - `Write-Output`
  // of an empty value prints nothing at all rather than a blank line.
  return { pid: root, name: lines[1] || "?", path: lines[2] ?? null };
}

/**
 * The pid listening on `port`, out of `netstat -ano -p TCP`.
 *
 * LISTENING only: an outbound connection FROM port 80 is not what blocks a
 * bind, and matching one would offer to kill a browser.
 *
 * @param {string} out @param {number} port @returns {number | null}
 */
export function parseNetstat(out, port) {
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    if (localPort(parts[1]) !== port) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * The image name out of one `tasklist /FO CSV /NH` row.
 *
 * `"httpd.exe","1234","Console","1","12,345 K"`. A pid with no process gives a
 * sentence instead ("INFO: No tasks are running..."), which matches nothing.
 *
 * @param {string} out @returns {string | null}
 */
export function parseTasklist(out) {
  const first = out.trim().split(/\r?\n/)[0] ?? "";
  const m = /^"([^"]+)"/.exec(first.trim());
  return m ? m[1] : null;
}

/**
 * macOS and Linux: `lsof`, falling back to `ss`.
 *
 * `lsof` is on every macOS and most Linux boxes; `ss` is on every modern Linux
 * and no macOS. Between them nearly everything is covered, and a machine with
 * neither gets the plain message it had before rather than an error about a
 * tool it was never told it needed.
 *
 * @param {number} port @returns {Promise<PortOwner | null>}
 */
async function posixOwner(port) {
  // -F is lsof's machine-readable mode: one field per line, tagged.
  const viaLsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
    timeoutMs: 15_000,
  }).catch(() => null);
  if (viaLsof && viaLsof.code === 0) {
    const hit = parseLsof(viaLsof.out);
    if (hit) return { ...hit, pid: await posixRoot(hit.pid) };
  }

  if (isMac()) return null;

  const viaSs = await run("ss", ["-H", "-ltnp", `sport = :${port}`], {
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!viaSs || viaSs.code !== 0) return null;
  const hit = parseSs(viaSs.out);
  return hit ? { ...hit, pid: await posixRoot(hit.pid) } : null;
}

/**
 * The same walk on macOS and Linux, where nginx, Apache and PHP-FPM are also a
 * master with workers and the socket belongs to a worker.
 *
 * `sh -c` because this is a loop, not a command; `which()` already needs a
 * shell for the same kind of reason. Falls back to the pid it was given, so a
 * machine whose `ps` disagrees still gets the old behaviour rather than an
 * error.
 *
 * @param {number} pid @returns {Promise<number>}
 */
async function posixRoot(pid) {
  const script = [
    `p=${pid}`,
    "for i in 1 2 3 4 5 6 7 8; do",
    '  pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
    '  [ -z "$pp" ] && break',
    '  [ "$pp" -le 1 ] && break',
    '  a=$(ps -o comm= -p "$p" 2>/dev/null)',
    '  b=$(ps -o comm= -p "$pp" 2>/dev/null)',
    '  [ "$a" != "$b" ] && break',
    "  p=$pp",
    "done",
    'echo "$p"',
  ].join("; ");

  const res = await run("sh", ["-c", script], { timeoutMs: 20_000 }).catch(() => null);
  const root = Number((res?.out ?? "").trim());
  return Number.isInteger(root) && root > 0 ? root : pid;
}

/**
 * `lsof -F pc` output: one tagged field per line, `p` then `c` per process.
 *
 * @param {string} out @returns {PortOwner | null}
 */
export function parseLsof(out) {
  let pid = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid > 0) return { pid, name: line.slice(1) || "?" };
  }
  return pid > 0 ? { pid, name: "?" } : null;
}

/**
 * `ss -H -ltnp` output, whose process column is `users:(("nginx",pid=1234,fd=6))`.
 *
 * @param {string} out @returns {PortOwner | null}
 */
export function parseSs(out) {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(out);
  return m ? { pid: Number(m[2]), name: m[1] } : null;
}

/**
 * The port out of `0.0.0.0:80`, `[::]:80` or `127.0.0.1:80`.
 *
 * Split on the LAST colon, or an IPv6 local address takes the whole thing with
 * it and every row parses as port `NaN`.
 *
 * @param {string} local @returns {number}
 */
function localPort(local) {
  const at = local.lastIndexOf(":");
  return at === -1 ? NaN : Number(local.slice(at + 1));
}

/**
 * The executable a pid is running, or `null`.
 *
 * This is the only honest answer to "is that one of ours". A name match is not:
 * plenty of people have their own `nginx.exe`, and adopting theirs would mean
 * our Stop button kills a server we never started. The path is compared against
 * the binary we would have launched, so a match is proof rather than a guess.
 *
 * @param {number} pid
 * @returns {Promise<string | null>}
 */
export async function processPath(pid) {
  try {
    if (isWindows()) {
      const res = await run(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`,
        ],
        { timeoutMs: 20_000 },
      );
      const path = res.out.trim();
      return res.code === 0 && path ? path : null;
    }
    // `-d txt` is the text segment, which is the executable itself; `-F n`
    // prints it as one `n`-tagged line.
    const res = await run("lsof", ["-p", String(pid), "-a", "-d", "txt", "-F", "n"], {
      timeoutMs: 20_000,
    });
    if (res.code !== 0) return null;
    const line = res.out.split(/\r?\n/).find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch (err) {
    warn("could not read the executable path for pid", pid, err);
    return null;
  }
}

/**
 * Stop a process by pid, with the same two-stage escalation `freePort` uses.
 *
 * Exported for the one caller that has a pid but no handle: a service adopted
 * after a crash, whose process this extension started but no longer owns a
 * host-side handle for.
 *
 * @param {number} pid @returns {Promise<void>}
 */
export async function killPid(pid) {
  const plain = await killProcess(pid, false);
  if (!plain.ok) await killProcess(pid, true);
}

/**
 * Stop the process holding `port`.
 *
 * Verified by re-probing the port rather than by trusting the kill's exit
 * code: `taskkill` reports success for a process that then takes a moment to
 * release its socket, and `kill` succeeds for a process that catches the signal
 * and carries on. What the caller needs to know is whether the port is free,
 * which is a different question from whether the signal was delivered.
 *
 * @param {PortOwner} owner
 * @param {number} port
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function freePort(owner, port) {
  await killProcess(owner.pid, false);
  if (await released(port)) return { ok: true };

  // Refused, almost always because it belongs to another user or to a service.
  // Only now is anyone asked for administrator rights.
  const elevated = await killProcess(owner.pid, true);
  if (await released(port)) return { ok: true };

  return {
    ok: false,
    message:
      elevated.message ??
      `${owner.name} (pid ${owner.pid}) is still holding port ${port}. It may be a system service that restarts itself.`,
  };
}

/** @param {number} pid @param {boolean} elevated
 *  @returns {Promise<{ ok: boolean, message?: string }>} */
async function killProcess(pid, elevated) {
  if (!elevated) {
    const res = isWindows()
      ? await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 20_000 })
      : await run("kill", ["-TERM", String(pid)], { timeoutMs: 20_000 });
    return { ok: res.code === 0 };
  }
  const line = isWindows()
    ? `Stop-Process -Id ${pid} -Force -ErrorAction Stop`
    : `kill -TERM ${pid} || kill -KILL ${pid}`;
  const res = await elevate([line], {
    description: `TEDI Dev Environment needs to stop process ${pid}`,
  });
  return { ok: res.ok, message: res.message };
}

/** Did the port actually come free? Polled, because a socket is released a
 *  moment after the process that held it goes.
 *  @param {number} port @returns {Promise<boolean>} */
async function released(port) {
  for (let i = 0; i < 10; i++) {
    if (!(await inUse(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
