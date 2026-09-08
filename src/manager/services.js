// Starting and stopping the long-running processes.
//
// Every service is spawned through `shell_bg_spawn_direct`, which gives back a
// handle and no environment control, so each one is configured entirely through
// generated files and command-line flags. That constraint turns out to be a
// feature: the exact argv is visible in the dashboard, and reproducing a
// failure outside TEDI is a copy and paste.
//
// Databases need their data directory initialised before the first start, and
// that is done here rather than at install time on purpose. Installing is
// cheap and reversible; initialising writes a database the user may later have
// real data in, and it should happen when they first ask for the service, not
// as a side effect of downloading it.

import { paths, join, samePath } from "../core/paths.js";
import { exists, mkdirp, readDir, writeText } from "../core/fsx.js";
import { spawn, kill, run, isAlive, sleep, logs } from "../core/proc.js";
import { state, config, isWindows, exeSuffix, warn, repaint } from "../runtime.js";
import { installedOf, resolveVersion } from "./versions.js";
import { activeVersion, startsWithAll } from "./config.js";
import { fastcgiPort, generate } from "../web/vhost.js";
import { phpFastCgi } from "../registry/php.js";
import { plannedPort, portIsPinned, isWebServer, inUse, findFree } from "../web/ports.js";
import { portOwner, processPath, killPid } from "../web/portowner.js";
import { serverExe } from "../web/serverroot.js";
import { startCron, stopCron, isRunning as isCronRunning } from "./cron.js";

/** @typedef {import("../runtime.js").ServiceStatus} ServiceStatus */

/** Services this module knows how to run, in dashboard order. */
export const SERVICE_IDS = ["nginx", "apache", "mysql", "postgres", "redis", "cron"];

/**
 * Services that are a timer in this extension rather than a process on disk.
 *
 * The scheduler has no version to resolve, nothing to download and no handle to
 * supervise, so every "is it installed" gate in here and in the dashboard would
 * answer no and disable its own Start button. One set, asked in the four places
 * that care, beats an `id === "cron"` scattered through them.
 */
export const IN_PROCESS = new Set(["cron"]);

/** @param {string} id @returns {ServiceStatus} */
function statusOf(id) {
  let s = state.services.get(id);
  if (!s) {
    s = { id, state: "stopped", handle: null, port: null, error: null, version: null };
    state.services.set(id, s);
  }
  return s;
}

/** @param {string} id @param {Partial<ServiceStatus>} patch */
function setStatus(id, patch) {
  const s = statusOf(id);
  const before = s.state;
  Object.assign(s, patch);
  // A transition the user is standing there waiting for - "starting", then
  // "running" or "error" - has to reach the screen when it happens, not on the
  // next four-second tick. `start` deliberately waits 400ms to catch a process
  // that dies immediately, so without this the row said "stopped" for the whole
  // of a start while the button beside it was already showing a spinner.
  //
  // Only on a real change of `state`, which is what keeps the poll's own
  // no-change ticks from repainting: `refreshStatuses` calls this for every
  // service on every tick.
  if (patch.state !== undefined && patch.state !== before) {
    repaint();
    // The status bar too, and not through `repaint`: that only reaches MOUNTED
    // panes, and the bar is what you read when the pane is closed.
    state.onServices?.();
  }
  return s;
}

/**
 * Start one service.
 *
 * @param {string} id
 * @returns {Promise<ServiceStatus>}
 */
export async function start(id) {
  const current = statusOf(id);
  if (current.state === "running" && current.handle && (await isAlive(current.handle))) {
    return current;
  }

  // The scheduler is a timer here, not a process out there. Which is also the
  // honest scope of it: your development cron runs exactly while your
  // development environment does, and never behind your back.
  if (IN_PROCESS.has(id)) {
    try {
      await startCron();
      return setStatus(id, { state: "running", handle: null, port: null, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return setStatus(id, { state: "error", handle: null, error: message });
    }
  }

  // ONE web server at a time. Starting the other one stops this one first.
  //
  // They used to run side by side on offset ports, and that was the wrong trade:
  // two servers up means a project answers on two addresses under two sets of
  // rules, the second being the one you did not configure, and the offset then
  // shows up in a URL nobody typed. Stopping the other one is also what frees
  // the port before `choosePort` looks at it, which is why this is here and not
  // further down.
  if (isWebServer(id)) {
    const other = id === "nginx" ? "apache" : "nginx";
    if (state.services.get(other)?.state === "running") await stop(other);
  }

  const version = activeVersion(id) ?? installedOf(id)[0]?.version ?? null;
  const row = resolveVersion(id, version);
  if (!row) {
    return setStatus(id, {
      state: "error",
      error: `${id} is not installed.`,
      handle: null,
    });
  }

  setStatus(id, { state: "starting", error: null, conflict: null, version: row.version });

  try {
    const port = await choosePort(id);
    const plan = await planFor(id, row, port);
    if (plan.init) await plan.init();

    const handle = await spawn(plan.program, plan.args, plan.cwd ? { cwd: plan.cwd } : {});
    // A process that dies immediately (bad config, missing module) exits before
    // the first status poll, and the dashboard would show "running" until then.
    await sleep(400);
    if (!(await isAlive(handle))) {
      // Its OWN last words, not a file path. This used to say "Check
      // <root>\logs\<id>.log" - a file nginx never writes (it writes
      // nginx.error.log) and does not write at all when it dies before opening
      // its logs, which is exactly the case here. The one line that mattered
      // (`[emerg] CreateFile() ".../mime.types" failed`) was on stderr the whole
      // time and took a manual `nginx -t` to find.
      const out = await logs(handle).catch(() => null);
      const tail = (typeof out === "string" ? out : (out?.bytes ?? ""))
        .split("\n")
        .map((/** @type {string} */ line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      throw new Error(`${id} exited immediately.${tail ? ` ${tail}` : ""}`);
    }
    return setStatus(id, { state: "running", handle, port, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`could not start ${id}:`, message);
    const conflict =
      /** @type {{ conflict?: { port: number, pid: number, name: string } }} */ (err)?.conflict ??
      null;
    return setStatus(id, { state: "error", error: message, handle: null, conflict });
  }
}

/**
 * Stop one service.
 *
 * nginx and Apache are asked to stop through their own control flag first: they
 * fork workers, and killing only the handle we hold leaves those workers holding
 * port 80, so the next start fails with a bind error that looks unrelated.
 *
 * @param {string} id
 * @returns {Promise<ServiceStatus>}
 */
export async function stop(id) {
  const s = statusOf(id);
  if (IN_PROCESS.has(id)) {
    stopCron();
    return setStatus(id, { state: "stopped", handle: null, error: null });
  }
  const row = resolveVersion(id, s.version);

  if (row && isWebServer(id)) {
    // Resolved, not spelled: Debian and Ubuntu ship Apache's binary as
    // `apache2`, so `join(binDir, "httpd")` names nothing there and the
    // graceful stop silently did not happen.
    const exe = await serverExe(/** @type {"nginx"|"apache"} */ (id), row);
    const args =
      id === "nginx"
        ? ["-p", paths.internal(), "-c", join(paths.conf("nginx"), "nginx.conf"), "-s", "stop"]
        : ["-f", join(paths.conf("apache"), "httpd.conf"), "-k", "stop"];
    await run(exe, args, { timeoutMs: 20_000 }).catch(() => {});
  }

  if (s.handle !== null) await kill(s.handle);
  // Adopted after a crash: the handle died with the app that owned it, so the
  // pid is the only way to reach the process. The graceful path above has
  // usually already stopped a web server by here; this is what stops a database.
  else if (s.adopted) await killPid(s.adopted);

  // Wait for the port to actually go quiet, for EVERY service that had one.
  //
  // `nginx -s stop` returns as soon as the master has been SIGNALLED, and the
  // workers holding the listening socket take a moment longer to exit. So
  // `restart`, which slept a fixed 300ms, could hand `start` a port that was
  // still bound, and the failure surfaces as "Port 80 is already in use" -
  // which reads as another program's fault rather than as our own previous
  // process.
  //
  // This was briefly gated on the web servers, on the reasoning that a database
  // is allowed to move. That is backwards: a web server that cannot reclaim its
  // port at least says so, while a database SILENTLY moves to the next free one
  // (`choosePort`) - so restarting MySQL while its own dying process still held
  // 3306 would land it on 3307, and every connection string pointing at 3306
  // would then be wrong with nothing on screen to say why.
  //
  // Bounded, because `deactivate` also goes through here and quitting TEDI must
  // not sit waiting on a port something ELSE is holding. The bound is a
  // ceiling, not a cost: a killed process releases its socket in well under a
  // second, so a normal quit spends a few hundred milliseconds here in total.
  if (s.port !== null) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await inUse(s.port))) await sleep(150);
  }

  return setStatus(id, { state: "stopped", handle: null, error: null });
}

/** @param {string} id @returns {Promise<ServiceStatus>} */
export async function restart(id) {
  // No sleep of its own: `stop` now waits for the port rather than guessing how
  // long a shutdown takes, which is the only version of this that is right on a
  // slow machine as well as a fast one.
  await stop(id);
  return await start(id);
}

/**
 * The port this service will actually bind.
 *
 * A DATABASE moves out of the way: nothing links to `localhost:3306` from a
 * bookmark, the connection string comes from the dashboard, and refusing to
 * start because some other MySQL is running would be an obstacle rather than a
 * safeguard. A WEB SERVER does not move, because its port is written into the
 * `listen` line of every generated vhost - moving it here would leave the
 * process and its own configuration disagreeing - and because its port is in
 * every URL the user has open. So the conflict is reported there and resolved
 * here.
 *
 * Which port a web server wants is `ports.js`'s answer, not this file's: the
 * active server keeps the configured pair and a second installed one takes a
 * fixed offset, so both can run at once.
 *
 * @param {string} id
 * @returns {Promise<number>}
 */
async function choosePort(id) {
  const wanted = plannedPort(id);
  if (!(await inUse(wanted))) return wanted;

  // A port somebody TYPED is never moved. They typed it because something is
  // pointing at it, and landing on the next one along would break exactly the
  // thing the choice was made for. Starting anyway fails with an opaque bind
  // error deep in a log file, so say it here instead.
  if (portIsPinned(id)) {
    // Ask WHO. "Port 80 is already in use" is true and useless; nine times in
    // ten it is another copy of the same server, and naming it is the whole
    // difference between a dead end and one button.
    const owner = await portOwner(wanted);
    const err = new Error(
      owner
        ? `Port ${wanted} is already in use by ${owner.name} (pid ${owner.pid}).`
        : `Port ${wanted} is already in use. Stop whatever is serving it, or give ${id} a different port.`,
    );
    if (owner) {
      // Carried on the error so `start`'s catch can put it on the status, which
      // is where the row reads it from.
      Object.assign(err, { conflict: { port: wanted, pid: owner.pid, name: owner.name } });
    }
    throw err;
  }

  const taken = new Set(
    [...state.services.values()].map((s) => s.port).filter((p) => typeof p === "number"),
  );
  const free = await findFree(wanted + 1, { reserved: taken });
  warn(`${id}: port ${wanted} is taken, using ${free}`);
  return free;
}

/**
 * @typedef {object} StartPlan
 * @property {string} program
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {() => Promise<void>} [init]  First-run setup.
 */

/**
 * How each service is launched.
 *
 * Every service has an `init` that creates what it needs before the process is
 * asked to read it - mysqld its data directory, redis its conf, and the web
 * servers their whole generated tree. The web servers had none, because their
 * config was written by `generate()` on "Apply changes" or when a project was
 * added; on a freshly set-up environment neither had happened, so
 * `nginx -c <path>` pointed at a file in an empty `conf/` directory and the
 * process exited before the first status poll. Regenerating here is idempotent
 * and cheap, and it is what starting a server should do anyway.
 *
 * @param {import("../runtime.js").InstalledVersion} row
 * @param {string} id
 * @param {number} port  Resolved by `choosePort`, which may have moved it.
 * @returns {Promise<StartPlan>}
 */
async function planFor(id, row, port) {
  const { binDir, version } = row;
  const dataDir = paths.data(id, version);
  const logFile = join(paths.logs(), `${id}.log`);

  switch (id) {
    case "nginx":
      return {
        program: await serverExe("nginx", row),
        // -p is the PREFIX for anything still relative, which is only nginx's
        // own temp directories: everything the generated config names is
        // absolute. So it points at OUR `internal/`, which is writable on every
        // platform and is where that scratch belongs, rather than at nginx's
        // install directory - which for a system nginx is `/usr/sbin` and
        // cannot be written to at all.
        args: ["-p", paths.internal(), "-c", join(paths.conf("nginx"), "nginx.conf")],
        init: async () => {
          await generate(state.projects, "nginx");
        },
      };

    case "apache":
      return {
        program: await serverExe("apache", row),
        args: ["-f", join(paths.conf("apache"), "httpd.conf"), "-D", "FOREGROUND"],
        init: async () => {
          await generate(state.projects, "apache");
        },
      };

    case "mysql":
      return {
        program: join(binDir, `mysqld${exeSuffix()}`),
        args: [
          `--datadir=${dataDir}`,
          `--port=${port}`,
          `--log-error=${logFile}`,
          // Loopback only. A local dev database with an insecure root account
          // must not be reachable from the network the laptop is on.
          "--bind-address=127.0.0.1",
        ],
        init: async () => {
          if (await isInitialised(dataDir)) return;
          await mkdirp(dataDir);
          const res = await run(
            join(binDir, `mysqld${exeSuffix()}`),
            [`--datadir=${dataDir}`, "--initialize-insecure", `--log-error=${logFile}`],
            { timeoutMs: 5 * 60_000 },
          );
          if (res.code !== 0) throw new Error(`mysqld could not initialise its data directory.`);
        },
      };

    case "postgres":
      return {
        program: join(binDir, `postgres${exeSuffix()}`),
        args: ["-D", dataDir, "-p", String(port), "-k", paths.run()],
        init: async () => {
          if (await isInitialised(dataDir)) return;
          await mkdirp(dataDir);
          // `-A trust` and no password, which is what a loopback-only local
          // development database wants. There was a `run/pg-init-pass` written
          // here with `postgres` in it, on a comment claiming initdb needed the
          // file to exist first; initdb was never given `--pwfile`, so it was a
          // plaintext password nothing read and nothing removed.
          const res = await run(
            join(binDir, `initdb${exeSuffix()}`),
            ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8"],
            { timeoutMs: 5 * 60_000 },
          );
          if (res.code !== 0) throw new Error("initdb could not create the data directory.");
        },
      };

    case "redis": {
      const confDir = paths.conf("redis");
      const conf = join(confDir, "redis.conf");
      return {
        program: join(binDir, `redis-server${exeSuffix()}`),
        // The BASENAME, run from the config's own directory.
        //
        // The Windows redis build is a Cygwin binary, and it resolves the path
        // it is given against its own POSIX view of the world - handed an
        // absolute `D:\tedi\conf\redis\redis.conf` it looked for
        // `/cygdrive/d/<app cwd>/D:\tedi\conf\redis\redis.conf` and died with
        // "Fatal error, can't open config file". Exactly the shape of the GNU
        // tar bug (a colon before the first slash reads as `host:path`), and
        // exactly the same fix.
        args: ["redis.conf"],
        cwd: confDir,
        init: async () => {
          await mkdirp(dataDir);
          await writeText(
            conf,
            [
              "# Generated by the TEDI Dev Environment extension.",
              `port ${port}`,
              "bind 127.0.0.1",
              `dir "${dataDir.replace(/\\/g, "/")}"`,
              `logfile "${logFile.replace(/\\/g, "/")}"`,
              "save 900 1",
              "",
            ].join("\n"),
          );
        },
      };
    }

    default:
      throw new Error(`No start plan for "${id}".`);
  }
}

/** A data directory that already holds a database.
 *  @param {string} dir @returns {Promise<boolean>} */
async function isInitialised(dir) {
  const entries = await readDir(dir, true);
  return entries.length > 0;
}

// ---------------------------------------------------------------------------
// PHP FastCGI pools. One per installed PHP version, so several versions can
// serve at the same time and a project switching version needs no restart of
// the web server.
// ---------------------------------------------------------------------------

/** Handles of running PHP pools, keyed by version. @type {Map<string, number>} */
const phpPools = new Map();

/**
 * Make sure a FastCGI worker is listening for this PHP version.
 *
 * Windows PHP has no FPM, so `php-cgi.exe -b host:port` is used there; it
 * serves one request at a time, which is fine locally and is what every Windows
 * PHP stack does. Elsewhere php-fpm is given a generated pool config.
 *
 * @param {string} version
 * @returns {Promise<number | null>} the port, or null when it could not start
 */
async function ensurePhpPool(version) {
  const existing = phpPools.get(version);
  if (existing !== undefined && (await isAlive(existing))) return fastcgiPort(version);

  const row = resolveVersion("php", version);
  if (!row) return null;
  const port = fastcgiPort(version);

  try {
    if (isWindows()) {
      const exe = phpFastCgi(version);
      if (!(await exists(exe))) return null;
      const handle = await spawn(exe, ["-b", `127.0.0.1:${port}`]);
      phpPools.set(version, handle);
      return port;
    }

    const exe = phpFastCgi(version);
    if (!(await exists(exe))) return null;
    const confFile = join(paths.conf("php", version), "php-fpm.conf");
    await writeText(
      confFile,
      [
        "; Generated by the TEDI Dev Environment extension.",
        "[global]",
        `error_log = ${join(paths.logs(), `php-fpm-${version}.log`)}`,
        "daemonize = no",
        "",
        "[www]",
        `listen = 127.0.0.1:${port}`,
        "pm = dynamic",
        "pm.max_children = 10",
        "pm.start_servers = 2",
        "pm.min_spare_servers = 1",
        "pm.max_spare_servers = 4",
        "",
      ].join("\n"),
    );
    const handle = await spawn(exe, ["-y", confFile, "-F"]);
    phpPools.set(version, handle);
    return port;
  } catch (err) {
    warn(`could not start a PHP pool for ${version}`, err);
    return null;
  }
}

/**
 * Restart the FastCGI worker for one PHP version, if one is running.
 *
 * This is what makes a php.ini change take effect on the WEB side. The CLI
 * picks an edit up immediately because every `php` is a new process; the pool
 * is long-lived and would otherwise keep serving the old configuration until
 * something unrelated restarted it, which reads as "my memory_limit change did
 * nothing".
 *
 * A version with no pool running is not started here: that would turn editing a
 * setting into starting a service the user had deliberately stopped.
 *
 * @param {string} version
 * @returns {Promise<boolean>} whether a pool was actually recycled
 */
export async function reloadPhpPool(version) {
  const handle = phpPools.get(version);
  if (handle === undefined) return false;
  await kill(handle);
  phpPools.delete(version);
  await sleep(200);
  return (await ensurePhpPool(version)) !== null;
}

/** Stop every PHP pool. @returns {Promise<void>} */
async function stopPhpPools() {
  for (const [version, handle] of phpPools) {
    await kill(handle);
    phpPools.delete(version);
  }
}

/** Which PHP versions currently have a pool running. @returns {string[]} */
export function runningPhpPools() {
  return [...phpPools.keys()];
}

/**
 * Refresh every service status against reality.
 *
 * A handle we hold can be dead (the process crashed, or the user killed it), so
 * the dashboard must ask rather than trust its own last write.
 *
 * @returns {Promise<void>}
 */
export async function refreshStatuses() {
  for (const id of SERVICE_IDS) {
    // No handle to ask about; the timer either exists or it does not.
    if (IN_PROCESS.has(id)) {
      setStatus(id, { state: isCronRunning() ? "running" : "stopped" });
      continue;
    }
    const s = statusOf(id);
    if (s.state !== "running") continue;
    if (s.handle !== null) {
      if (!(await isAlive(s.handle))) await died(id, s.handle);
      continue;
    }
    // Adopted, so there is no handle to ask. The port is the liveness check:
    // without this an adopted service would read "running" forever, including
    // after somebody stopped it from outside.
    if (s.adopted && s.port !== null && !(await inUse(s.port))) {
      setStatus(id, { state: "stopped", adopted: null });
    }
  }
}

/**
 * A service that was running has exited without being asked to.
 *
 * The row used to go quietly back to "stopped", which is the least useful thing
 * it could say: something the user started is gone and the reason is in a
 * buffer nobody reads. The process's OWN last words go on the row instead, the
 * same way a failed start already reports them - "it stopped by itself" is a
 * question, and the answer was already in hand.
 *
 * @param {string} id @param {number} handle @returns {Promise<void>}
 */
async function died(id, handle) {
  const out = await logs(handle).catch(() => null);
  const tail = (typeof out === "string" ? out : (out?.bytes ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  setStatus(id, {
    state: "error",
    handle: null,
    error: `${id} stopped on its own.${tail ? ` ${tail}` : ""}`,
  });
}

/**
 * Forget a recorded port conflict.
 *
 * Called once the port has actually been freed. Without it the row keeps
 * offering to stop a process that is already gone, and the button's own success
 * is the thing that makes it look broken.
 *
 * @param {string} id @returns {void}
 */
export function clearConflict(id) {
  setStatus(id, { conflict: null, error: null, state: "stopped" });
}

/**
 * Take back over anything still running from before a crash.
 *
 * TEDI closing normally stops these; TEDI being killed does not, on the
 * platforms where a child outlives its parent. The symptom is a dashboard
 * saying "stopped" over a MySQL that is very much running, and a Start that
 * then fails with "port 3306 is already in use" - blaming a conflict on the
 * user's own previous session.
 *
 * Adoption is only ever offered on PROOF, never on a guess: something is
 * listening on the port this service would use, and the process holding it is
 * running the exact binary this service would have launched. A name match would
 * not do - plenty of people have their own nginx - because the consequence of
 * being wrong is a Stop button that kills a server this extension never
 * started.
 *
 * Cheap when there is nothing to recover, which is the normal case: a loopback
 * connect per installed service, and the two subprocesses that identify a
 * process only run when something actually answered.
 *
 * @returns {Promise<number>} How many were taken back over.
 */
export async function recoverRunning() {
  let found = 0;
  for (const id of SERVICE_IDS) {
    // The scheduler is a timer inside this extension. Nothing of it survives
    // the process that was running it, so there is nothing to adopt.
    if (IN_PROCESS.has(id)) continue;
    if (statusOf(id).state === "running") continue;

    const row = resolveVersion(id, activeVersion(id) ?? installedOf(id)[0]?.version ?? null);
    if (!row) continue;

    const port = plannedPort(id);
    if (!(await inUse(port))) continue;

    const owner = await portOwner(port);
    if (!owner) continue;

    // The Windows walk already returned the path; only pay for a second lookup
    // where it could not.
    const path = owner.path ?? (await processPath(owner.pid));
    if (!path || !(await isOurBinary(id, row, path))) continue;

    setStatus(id, {
      state: "running",
      handle: null,
      adopted: owner.pid,
      port,
      error: null,
      conflict: null,
      version: row.version,
    });
    warn(`recovered ${id} (pid ${owner.pid}) still running on port ${port}`);
    found++;
  }
  return found;
}

/**
 * Is `path` the executable this service would have launched?
 *
 * Compared through `samePath`, which folds case on Windows and normalises
 * separators: `netstat` and `Get-Process` disagree with our own `join` about
 * both, and a string comparison would decline to adopt a process that is
 * plainly ours.
 *
 * @param {string} id
 * @param {import("../runtime.js").InstalledVersion} row
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isOurBinary(id, row, path) {
  const plan = await planFor(id, row, 0).catch(() => null);
  if (!plan) return false;
  return samePath(plan.program, path);
}

/** Stop everything this extension started. Called on deactivate.
 *  @returns {Promise<void>} */
export async function stopAll() {
  await stopPhpPools();
  for (const id of SERVICE_IDS) {
    // The in-process ones have no handle, so the test below would skip them
    // forever and leave a scheduler firing after the extension was disabled.
    if (IN_PROCESS.has(id)) {
      await stop(id).catch(() => {});
      continue;
    }
    const s = state.services.get(id);
    if (s?.handle !== null && s?.handle !== undefined) await stop(id).catch(() => {});
  }
}

/** Start the web server and the PHP pools its vhosts point at.
 *  @returns {Promise<void>} */
export async function startAll() {
  for (const row of installedOf("php")) {
    if (row.origin === "download") await ensurePhpPool(row.version);
  }
  await start(config.webServer);

  // Every installed database too. The button says "Start all" and "Stop all"
  // already stops all of them, so starting only the web server made the pair
  // asymmetric and left three services sitting at "stopped" after a press that
  // claimed to have started everything. Anything not installed is skipped, and
  // one failing never stops the rest - a MySQL data directory that will not
  // initialise must not cost you Redis.
  for (const id of SERVICE_IDS) {
    if (isWebServer(id)) continue;
    // Nothing to install means the check below would skip it every time.
    if (!IN_PROCESS.has(id) && installedOf(id).length === 0) continue;
    // Unticked on its row. Starting everything installed was the right default
    // and the wrong rule: MySQL and PostgreSQL run side by side happily, and
    // most people use one, so "Start all" was starting a second database nobody
    // asked for and holding its port.
    if (!startsWithAll(id)) continue;
    await start(id).catch(() => {});
  }
}
