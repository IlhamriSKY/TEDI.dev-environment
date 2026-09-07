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

import { paths, join } from "../core/paths.js";
import { exists, mkdirp, readDir, writeText } from "../core/fsx.js";
import { spawn, kill, run, isAlive, sleep, logs } from "../core/proc.js";
import { state, config, isWindows, exeSuffix, warn } from "../runtime.js";
import { installedOf, resolveVersion } from "./versions.js";
import { activeVersion } from "./config.js";
import { fastcgiPort, generate } from "../web/vhost.js";
import { phpFastCgi } from "../registry/php.js";
import { defaultPortFor, inUse, findFree } from "../web/ports.js";

/** @typedef {import("../runtime.js").ServiceStatus} ServiceStatus */

/** Services this module knows how to run, in dashboard order. */
export const SERVICE_IDS = ["nginx", "apache", "mysql", "postgres", "redis"];

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
  Object.assign(s, patch);
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

  const version = activeVersion(id) ?? installedOf(id)[0]?.version ?? null;
  const row = resolveVersion(id, version);
  if (!row) {
    return setStatus(id, {
      state: "error",
      error: `${id} is not installed.`,
      handle: null,
    });
  }

  setStatus(id, { state: "starting", error: null, version: row.version });

  try {
    const port = await choosePort(id);
    const plan = await planFor(id, row.binDir, row.version, port);
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
    return setStatus(id, { state: "error", error: message, handle: null });
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
  const row = resolveVersion(id, s.version);

  if (row && (id === "nginx" || id === "apache")) {
    const exe = join(row.binDir, `${id === "nginx" ? "nginx" : "httpd"}${exeSuffix()}`);
    const args =
      id === "nginx"
        ? ["-p", row.dir, "-c", join(paths.conf("nginx"), "nginx.conf"), "-s", "stop"]
        : ["-f", join(paths.conf("apache"), "httpd.conf"), "-k", "stop"];
    await run(exe, args, { timeoutMs: 20_000 }).catch(() => {});
  }

  if (s.handle !== null) await kill(s.handle);
  return setStatus(id, { state: "stopped", handle: null, error: null });
}

/** @param {string} id @returns {Promise<ServiceStatus>} */
export async function restart(id) {
  await stop(id);
  await sleep(300);
  return await start(id);
}

/**
 * The port this service will actually bind.
 *
 * A DATABASE moves out of the way: nothing links to `localhost:3306` from a
 * bookmark, the connection string comes from the dashboard, and refusing to
 * start because some other MySQL is running would be an obstacle rather than a
 * safeguard. A WEB SERVER does not move, because its port is in every URL the
 * user has open, and silently answering on 8080 instead of 80 turns "my site is
 * down" into a mystery. So the conflict is reported there and resolved here.
 *
 * @param {string} id
 * @returns {Promise<number>}
 */
async function choosePort(id) {
  const isWebServer = id === "nginx" || id === "apache";
  const wanted = isWebServer ? config.httpPort : defaultPortFor(id);
  if (!(await inUse(wanted))) return wanted;

  if (isWebServer) {
    // Starting anyway fails with an opaque bind error deep in a log file.
    throw new Error(
      `Port ${wanted} is already in use. Stop whatever is serving it, or change the HTTP port in Settings.`,
    );
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
 * Write the web server's configuration before it is asked to read it.
 *
 * Every other service has an `init` that creates what it needs - mysqld its data
 * directory, redis its conf - and the web servers had none, because their config
 * is written by `generate()` on "Apply changes" or when a project is added. On a
 * freshly set-up environment neither has happened, so `nginx -c <path>` pointed
 * at a file in an empty `conf/` directory and the process exited before the
 * first status poll. The error even sent the user to a log that did not exist:
 * "nginx exited immediately. Check <root>\logs\nginx.log".
 *
 * Idempotent and cheap - it rewrites the vhosts from the current project list,
 * which is what starting a server should do anyway.
 *
 * @returns {Promise<void>}
 */
async function writeServerConfig() {
  await generate(state.projects);
}

/**
 * How each service is launched.
 *
 * @param {string} id @param {string} binDir @param {string} version
 * @param {number} port  Resolved by `choosePort`, which may have moved it.
 * @returns {Promise<StartPlan>}
 */
async function planFor(id, binDir, version, port) {
  const dataDir = paths.data(id, version);
  const logFile = join(paths.logs(), `${id}.log`);

  switch (id) {
    case "nginx": {
      const row = resolveVersion("nginx", version);
      return {
        program: join(binDir, `nginx${exeSuffix()}`),
        // -p is the PREFIX nginx resolves `mime.types` and `fastcgi_params`
        // against, so it must be nginx's own install directory even though the
        // config we hand it with -c is ours.
        args: ["-p", row?.dir ?? binDir, "-c", join(paths.conf("nginx"), "nginx.conf")],
        init: writeServerConfig,
      };
    }

    case "apache":
      return {
        program: join(binDir, `httpd${exeSuffix()}`),
        args: ["-f", join(paths.conf("apache"), "httpd.conf"), "-D", "FOREGROUND"],
        init: writeServerConfig,
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
          // initdb refuses to run as root and needs the password file to exist
          // before it is read, so write it first.
          const pwFile = join(paths.run(), "pg-init-pass");
          await writeText(pwFile, "postgres\n");
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
    const s = statusOf(id);
    if (s.state === "running" && s.handle !== null && !(await isAlive(s.handle))) {
      setStatus(id, { state: "stopped", handle: null });
    }
  }
}

/** Stop everything this extension started. Called on deactivate.
 *  @returns {Promise<void>} */
export async function stopAll() {
  await stopPhpPools();
  for (const id of SERVICE_IDS) {
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
    if (id === "nginx" || id === "apache") continue;
    if (installedOf(id).length === 0) continue;
    await start(id).catch(() => {});
  }
}
