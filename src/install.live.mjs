// Live integration check for the install pipeline.
//
// Run: `npm run test:live`. NOT part of `npm test`: it downloads real archives
// from real servers, so it needs network and takes a minute.
//
// This exercises the code that had never been executed at all - net.js,
// archive.js, the staging/unwrap/verify lifecycle in install.js, and the
// provider version resolution - against genuine upstream downloads.
//
// The `ctx` below is a faithful stand-in for the host's command surface,
// INCLUDING the two quirks that shape fsx.js: `fs_create_dir` refuses a path
// that already exists (even though it is recursive), and `fs_rename` refuses an
// existing target. Emulating those exactly is itself a check on whether the
// extension's understanding of the host contract is right - if fsx.js only
// worked because the real host was more forgiving, it would fail here.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { setCtx, setConfig, state } from "./runtime.js";
import { provider } from "./registry/index.js";
import { install, uninstall, installRoot, verify } from "./manager/install.js";
import { scanInstalled, installedOf } from "./manager/versions.js";
import { addProject, discoverProjects } from "./project/projects.js";
import { migrateLayout } from "./manager/migrate.js";
import { iniPathFor } from "./manager/phpini.js";
import { saveJob, runJob } from "./manager/cron.js";
import { writeShims } from "./project/shims.js";
import { writeGlobalEnv, applyRuntimeChange } from "./manager/apply.js";
import { generate } from "./web/vhost.js";
import { serverExe } from "./web/serverroot.js";
import { start, stop, recoverRunning } from "./manager/services.js";
import { inUse, plannedPort } from "./web/ports.js";
import { install as installPhpMyAdmin, latestRelease } from "./tools/phpmyadmin.js";
import { portOwner, freePort } from "./web/portowner.js";
import { run, sleep } from "./core/proc.js";
import { ensureDirs } from "./core/fsx.js";
import { layoutDirs, paths } from "./core/paths.js";

const root = mkdtempSync(path.join(tmpdir(), "devenv-live-"));

// ---------------------------------------------------------------------------
// The host stand-in.
// ---------------------------------------------------------------------------

/** @type {Map<number, {proc: import("node:child_process").ChildProcess, buf: Buffer, exited: boolean, code: number | null}>} */
const procs = new Map();
let nextHandle = 1;

const invoke = async (command, args = {}) => {
  switch (command) {
    case "shell_bg_spawn_direct": {
      const handle = nextHandle++;
      // The host is Rust, whose `std::process::Command` calls `CreateProcessW`,
      // and CreateProcess runs a `.cmd` perfectly well - checked, not assumed:
      // Python's `subprocess.run(shell=False)` uses the same call and runs one.
      // Node is the odd one out. It refuses with EINVAL unless `shell: true`,
      // which is a deliberate Node restriction rather than a Windows one, so
      // routing batch files through `cmd /c` HERE is what makes this stand-in
      // behave like the host rather than like Node.
      //
      // It matters because the shims are `.cmd` files on Windows, and both the
      // package-manager survey and every scheduled job spawn one.
      // `/s` makes cmd strip the first and last quote of the whole command line
      // and take the rest literally, so the payload has to be wrapped in ONE
      // more pair - `cmd /d /s /c ""C:\Program Files\x.cmd" "arg""`. Without
      // that wrapper a path with a space in it splits and cmd reports
      // `'C:\Users\IT' is not recognized`, which is the failure this stand-in
      // exists to not have.
      const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(args.program);
      const quoted = [args.program, ...(args.args ?? [])].map((a) => `"${a}"`).join(" ");
      const proc = isBatch
        ? spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
            cwd: args.cwd || undefined,
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
          })
        : spawn(args.program, args.args ?? [], {
            cwd: args.cwd || undefined,
            shell: false,
            windowsHide: true,
          });
      const rec = { proc, buf: Buffer.alloc(0), exited: false, code: null };
      const take = (chunk) => {
        rec.buf = Buffer.concat([rec.buf, chunk]);
      };
      proc.stdout?.on("data", take);
      proc.stderr?.on("data", take);
      proc.on("close", (code) => {
        rec.exited = true;
        rec.code = code;
      });
      proc.on("error", (err) => {
        rec.exited = true;
        rec.code = -1;
        take(Buffer.from(String(err)));
      });
      procs.set(handle, rec);
      return handle;
    }
    case "shell_bg_logs": {
      const rec = procs.get(args.handle);
      if (!rec) throw new Error("no such handle");
      const from = args.sinceOffset ?? 0;
      const slice = rec.buf.subarray(Math.min(from, rec.buf.length));
      return {
        bytes: slice.toString("utf8"),
        next_offset: rec.buf.length,
        dropped: 0,
        exited: rec.exited,
        exit_code: rec.code,
      };
    }
    case "shell_bg_kill": {
      procs.get(args.handle)?.proc.kill();
      return null;
    }
    case "shell_bg_remove":
      procs.delete(args.handle);
      return null;
    case "shell_bg_list":
      return [...procs.entries()].map(([handle, r]) => ({
        handle,
        command: "",
        cwd: null,
        started_at_ms: 0,
        exited: r.exited,
        exit_code: r.code,
      }));

    // The host refuses when the path exists, even though it creates parents.
    case "fs_create_dir":
      if (existsSync(args.path)) throw new Error(`already exists: ${args.path}`);
      await fs.mkdir(args.path, { recursive: true });
      return null;

    case "fs_read_file": {
      const st = statSync(args.path);
      const content = await fs.readFile(args.path, "utf8");
      return { kind: "text", content, size: st.size };
    }
    case "fs_write_file":
      await fs.writeFile(args.path, args.content, "utf8");
      return null;

    case "fs_read_dir": {
      const entries = await fs.readdir(args.path, { withFileTypes: true });
      return entries
        .filter((e) => (args.includeHidden ? true : !e.name.startsWith(".")))
        .map((e) => ({
          name: e.name,
          kind: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
          size: 0,
          mtime: 0,
        }));
    }
    case "fs_delete":
      if (!existsSync(args.path)) throw new Error(`not found: ${args.path}`);
      await fs.rm(args.path, { recursive: true, force: true });
      return null;

    // The host refuses to overwrite.
    case "fs_rename":
      if (!existsSync(args.from)) throw new Error(`not found: ${args.from}`);
      if (existsSync(args.to)) throw new Error(`already exists: ${args.to}`);
      await fs.rename(args.from, args.to);
      return null;

    case "fs_canonicalize":
      return await fs.realpath(args.path);

    // Real, because the checks below use it to ask whether a server that says
    // it is running actually answers. The host's own version connects to a
    // loopback URL and reports whether anything was there, which is exactly
    // this.
    case "port_is_open":
      return await new Promise((resolve) => {
        const port = Number(new URL(args.url).port);
        const socket = net.connect({ host: "127.0.0.1", port });
        const done = (/** @type {boolean} */ answer) => {
          socket.destroy();
          resolve(answer);
        };
        socket.setTimeout(1500);
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.once("timeout", () => done(false));
      });

    default:
      throw new Error(`unmocked command: ${command}`);
  }
};

setCtx(
  /** @type {any} */ ({
    invoke,
    os: {
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux",
      arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    },
    paths: { home: root },
    logger: { info() {}, warn: console.warn, error: console.error },
    settings: { async get() {}, async set() {} },
    ui: { toast() {} },
  }),
);
setConfig({ rootDir: root, defaults: {} });
state.active = true;

// ---------------------------------------------------------------------------

let failed = 0;
/** @param {string} name @param {() => Promise<void>} fn */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    // A third party being down is not this extension being broken, and a check
    // that cannot tell the difference gets ignored the third time it goes red for
    // a reason nobody here can fix. `Skip` is how a step says which one it is.
    if (err instanceof Skip) {
      console.log(`  skip  ${name}\n        ${err.message}`);
      return;
    }
    failed++;
    console.error(`  FAIL  ${name}\n        ${err?.message ?? err}`);
  }
}

/** Thrown by a step whose PRECONDITION is unmet, rather than its assertion. */
class Skip extends Error {}

/** @param {string} url @returns {Promise<boolean>} */
async function reachable(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return res.ok || res.status === 405;
  } catch {
    return false;
  }
}

console.log(`\nlive install check, root = ${root}\n`);

// The layout migration, first and without touching the network.
//
// It moves nine entries of a REAL user's environment, one of which is the shim
// directory whose path is registered on the terminal PATH. Nothing about that
// can be checked by reading it, and the cost of getting it wrong is somebody's
// working setup - so it runs against a fabricated copy of the old shape, which
// is what the previous release actually wrote.
await step("migration moves the old layout into internal/, once", async () => {
  const legacy = mkdtempSync(path.join(tmpdir(), "devenv-legacy-"));
  const previous = root;
  try {
    setConfig({ rootDir: legacy });

    // Exactly what 0.1.0 left at the top level.
    const old = ["cache", "certs", "conf", "data", "downloads", "logs", "run"];
    const kept = ["data", "logs", "runtimes", "servers", "services", "www"];
    for (const name of [...old, ...kept, "shims", "tools"]) {
      mkdirSync(path.join(legacy, name), { recursive: true });
    }
    // Files that have to travel, and one that must not.
    writeFileSync(path.join(legacy, "global.env"), "PHP_BIN=C:\\old\\php\n");
    writeFileSync(path.join(legacy, "shims", "php.cmd"), "@echo off\n");
    writeFileSync(path.join(legacy, "certs", "a.test.pem"), "x\n");
    writeFileSync(path.join(legacy, "projects.json"), '{"projects":[]}\n');

    const first = await migrateLayout();
    if (!first.shims) throw new Error("the shim directory did not move");

    // Everything that moved is under internal/, with its contents intact.
    for (const name of ["cache", "downloads", "run", "tools", "shims", "certs", "conf"]) {
      if (!existsSync(path.join(legacy, "internal", name))) {
        throw new Error(`${name} is not under internal/`);
      }
      if (existsSync(path.join(legacy, name))) throw new Error(`${name} is still at the root`);
    }
    if (!existsSync(path.join(legacy, "internal", "shims", "php.cmd"))) {
      throw new Error("the shims moved but their contents did not");
    }
    if (!existsSync(path.join(legacy, "internal", "certs", "a.test.pem"))) {
      throw new Error("an issued certificate was lost");
    }
    if (!existsSync(path.join(legacy, "internal", "global.env"))) {
      throw new Error("global.env did not travel with the shims");
    }

    // The user's own things are untouched. This is the assertion that matters:
    // a migration that moved `data/` would take somebody's databases with it.
    for (const name of [...kept, "projects.json"]) {
      if (!existsSync(path.join(legacy, name))) throw new Error(`${name} was moved or removed`);
    }

    // Idempotent: a second activation must be a no-op, not a second move.
    const again = await migrateLayout();
    if (again.moved.length !== 0) throw new Error(`ran twice: ${again.moved.join(", ")}`);
    console.log(`        moved ${first.moved.length} entries, second pass moved none`);
  } finally {
    setConfig({ rootDir: previous });
    rmSync(legacy, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
});

await ensureDirs(layoutDirs());

// Composer: a bare .phar, so it exercises the "download is not an archive"
// branch that a container-only pipeline would get wrong.
await step("composer: resolve, download, place, verify", async () => {
  const p = provider("composer");
  const versions = await p.versions();
  if (versions.length === 0) throw new Error("no versions listed");
  const target = versions[0].version;

  await install(p, target);
  const dir = installRoot(p, target);
  const { exe } = await p.layout(target);
  if (!existsSync(exe)) throw new Error(`phar missing at ${exe}`);
  if (statSync(exe).size < 500_000) throw new Error("phar is implausibly small");
  console.log(`        composer ${target} -> ${dir}`);
});

// Node: a real archive, so it exercises download progress, extraction, the
// single-root unwrap, chmod on Unix, and the `--version` verify.
await step("node: resolve, download, extract, unwrap, verify", async () => {
  const p = provider("node");
  const versions = await p.versions();
  const target = (versions.find((v) => v.recommended) ?? versions[0]).version;

  let sawProgress = false;
  await install(p, target, (_msg, pct) => {
    if (typeof pct === "number" && pct > 0) sawProgress = true;
  });
  if (!sawProgress) throw new Error("no download progress was ever reported");

  const { exe, binDir } = await p.layout(target);
  if (!existsSync(exe)) throw new Error(`node missing at ${exe}`);
  // The unwrap must have collapsed `node-vX-win-x64/` away; if it did not, the
  // binary would be one level deeper and this is exactly how that shows up.
  if (!existsSync(binDir)) throw new Error(`bin dir missing at ${binDir}`);
  if (!(await verify(p, target))) throw new Error("the installed node did not answer --version");
  console.log(`        node ${target} -> ${exe}`);
});

await step("scan finds both installs", async () => {
  await scanInstalled();
  const node = installedOf("node").filter((r) => r.origin === "download");
  const composer = installedOf("composer").filter((r) => r.origin === "download");
  if (node.length !== 1) throw new Error(`expected 1 downloaded node, found ${node.length}`);
  if (composer.length !== 1) throw new Error(`expected 1 composer, found ${composer.length}`);
});

// PHP, and the php.ini that has to exist the moment it is installed.
//
// The zip ships `php.ini-development` and `php.ini-production` and no `php.ini`
// at all, and nothing created one: `ensureIni` was reached only by CHANGING
// something. So a freshly installed PHP had no ini until you edited a setting -
// the Configure dialog opened on an empty grid, and the runtime ran with no
// `extension_dir`, which is the one directive that must be right or no
// extension can load at all. None of that is visible without installing a real
// PHP and looking, which is why the check lives here.
await step("php: installs with a usable php.ini, not without one", async () => {
  const p = provider("php");
  const versions = await p.versions();
  if (versions.length === 0) throw new Error("no PHP versions listed");
  const target = (versions.find((v) => v.recommended) ?? versions[0]).version;

  await install(p, target);
  await applyRuntimeChange();

  const info = await iniPathFor(target);
  if (!info) throw new Error("PHP installed but did not resolve to an ini path");
  if (!info.exists) throw new Error(`no php.ini was created at ${info.path}`);

  const ini = readFileSync(info.path, "utf8");
  const extDir = ini.match(/^extension_dir\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!extDir) throw new Error("php.ini has no extension_dir");
  if (!existsSync(extDir)) throw new Error(`extension_dir points nowhere: ${extDir}`);
  // The seeding is the whole point, so check it actually took: a template
  // copied verbatim would leave the commented-out default in place.
  if (!/^date\.timezone\s*=/m.test(ini)) throw new Error("php.ini was not seeded with defaults");

  // And running it a second time must not rewrite what the user has since
  // edited - `ensureIni` returns early when the file is there.
  writeFileSync(info.path, ini + "\n; edited by hand\n");
  await applyRuntimeChange();
  if (!readFileSync(info.path, "utf8").includes("; edited by hand")) {
    throw new Error("a later apply overwrote the user's php.ini");
  }
  console.log(`        php ${target} -> ${info.path}, extension_dir ok`);
});

// Nginx, so the config check below has both servers to hand a config to.
if (process.platform === "win32") {
  await step("nginx: resolve, download, extract, verify", async () => {
    const p = provider("nginx");
    const versions = await p.versions();
    if (versions.length === 0) throw new Error("nginx.org listed no Windows builds");
    const target = (versions.find((v) => v.recommended) ?? versions[0]).version;
    await install(p, target);
    const { exe } = await p.layout(target);
    if (!existsSync(exe)) throw new Error(`nginx missing at ${exe}`);
    // `-v`, not `--version`: nginx treats the long form as a usage error, which
    // used to make every install of it warn "installed but did not answer".
    if (!(await verify(p, target))) throw new Error("the installed nginx did not answer");
    console.log(`        nginx ${target} -> ${exe}`);
  });
}

// Apache on Windows: the one archive here whose payload sits in a wrapper
// directory NEXT TO loose files - `Apache24/`, `ReadMe.txt`, `Security.txt` and
// a build-tag file, all at the top level. The old unwrap rule was "exactly one
// subdirectory and no files", so it left this alone: the binary landed at
// `<root>/Apache24/bin/httpd.exe` while `layout()` named `<root>/bin/httpd.exe`,
// `verify` only warned, and Apache never appeared as installed at all. There is
// no way to check that without a real archive, which is why it lives here.
if (process.platform === "win32") {
  await step("apache: the wrapper is lifted past the files beside it", async () => {
    const p = provider("apache");
    const versions = await p.versions();
    if (versions.length === 0) {
      // Empty means one of two very different things, and this used to assert
      // the alarming one: the site is unreachable (nothing to do with us), or it
      // answered and we parsed nothing out of it (our bug). So ask which.
      const up = await reachable("https://www.apachelounge.com/download/");
      if (!up) throw new Skip("apachelounge.com is unreachable; nothing to check against");
      throw new Error("Apache Lounge answered but listed no builds - has the page changed?");
    }
    const target = (versions.find((v) => v.recommended) ?? versions[0]).version;

    await install(p, target);
    const { exe } = await p.layout(target);
    if (!existsSync(exe)) throw new Error(`httpd missing at ${exe}`);
    // The generated config points LoadModule at this directory, so its absence
    // is the difference between a server that starts and one that aborts.
    const mod = path.join(installRoot(p, target), "modules", "mod_dir.so");
    if (!existsSync(mod)) throw new Error(`modules/ missing at ${mod}`);
    console.log(`        apache ${target} -> ${exe}`);
  });
}

// The generated configuration, handed to the server it was written for.
//
// This is the only check that can catch the class of bug the config generator
// had: every path in it names something OUTSIDE our tree - the modules
// directory, mime.types, ServerRoot - and a wrong one is a server that aborts at
// startup with a message about a file the user never wrote. Reading the code
// cannot tell you whether `/usr/sbin/conf/mime.types` exists; `nginx -t` can.
//
// HTTPS is switched off for it, so the check does not depend on a local CA
// having been installed on the machine running it.
await step("the generated config is accepted by the server it was written for", async () => {
  const site = path.join(root, "www", "example");
  mkdirSync(site, { recursive: true });
  // A HIGH port, because this nginx build's `-t` opens the listening sockets as
  // well as parsing the file: left on the default 80 the check depended on the
  // running machine's port 80 being free, and failed with a bind error about a
  // server that has nothing to do with it.
  setConfig({ autoHttps: false, webServer: "nginx", httpPort: 18080, httpsPort: 18443 });
  await scanInstalled();

  const project = await addProject(site, { name: "example", kind: "static" });

  for (const id of ["nginx", "apache"]) {
    const rows = installedOf(id);
    if (rows.length === 0) continue;
    await generate([project], id);

    const exe = await serverExe(id, rows[0]);
    const args =
      id === "nginx"
        ? ["-p", paths.internal(), "-c", path.join(paths.conf("nginx"), "nginx.conf"), "-t"]
        : ["-f", path.join(paths.conf("apache"), "httpd.conf"), "-t"];
    const res = await run(exe, args, { timeoutMs: 30_000 });
    if (res.code !== 0) {
      throw new Error(`${id} rejected its own generated config:\n        ${res.out.trim()}`);
    }
    console.log(`        ${id}: ${res.out.trim().split(/\r?\n/).slice(-1)[0]}`);
  }
});

// One web server at a time, and the handover really happens.
//
// The claim is that starting either of them stops the other and takes the SAME
// configured port. Two live processes are the only thing that can show it: a
// unit check can say the two plan the same number, but not that nginx actually
// let go of it in time for Apache to bind, which is the half that breaks.
//
// Deliberately on a high port. Binding 80 here would fight whatever the machine
// running the check is already serving, and what is under test is the handover.
await step("only one web server runs: starting one stops the other", async () => {
  if (installedOf("nginx").length === 0 || installedOf("apache").length === 0) return;
  setConfig({ webServer: "nginx", httpPort: 18080, httpsPort: 18443, autoHttps: false });

  try {
    const first = await start("nginx");
    if (first.state !== "running") {
      throw new Error(`nginx did not start: ${first.error ?? "no reason given"}`);
    }
    await sleep(600);
    if (!(await inUse(18080))) throw new Error("nginx is running but nothing answers on 18080");

    // Apache wants the very port nginx is holding, so this only works if
    // starting it stopped nginx AND waited for the socket to go quiet.
    const second = await start("apache");
    if (second.state !== "running") {
      throw new Error(`apache did not start: ${second.error ?? "no reason given"}`);
    }
    if (second.port !== first.port) {
      throw new Error(`apache took ${second.port} rather than the configured ${first.port}`);
    }
    if (state.services.get("nginx")?.state === "running") {
      throw new Error("nginx was left running alongside apache");
    }
    await sleep(600);
    if (!(await inUse(18080))) throw new Error("apache took over but nothing answers on 18080");
    console.log(`        nginx :${first.port} handed 18080 to apache, one at a time`);
  } finally {
    for (const id of ["nginx", "apache"]) await stop(id).catch(() => {});
  }
});

// A scheduled job, actually run.
//
// The claim being checked is the one the whole design rests on: a job's `node`
// is not the system's, it is the one the shim resolves for the folder the job
// runs in. That goes through four things nothing else here exercises together -
// the generated shim, `global.env`, `programFor`, and the host's willingness to
// spawn a `.cmd` - and any one of them being wrong produces a job that either
// runs the wrong runtime or does not run at all.
// The bug that made "stop it" do nothing, driven against a real server.
//
// nginx is a master plus workers and the LISTENING socket belongs to a WORKER.
// Killing that pid - tree and all - leaves the master to spawn a replacement
// which inherits the socket, so the port is never released and the button looks
// broken. Nothing about that is visible from reading the code: it depends on
// which process the OS reports for the socket, which is why this starts a real
// nginx and asks.
await step("a port conflict names the master, and stopping it frees the port", async () => {
  if (installedOf("nginx").length === 0) return;
  setConfig({ webServer: "nginx", httpPort: 18080, httpsPort: 18443, autoHttps: false });

  const started = await start("nginx");
  if (started.state !== "running") {
    throw new Error(`nginx did not start: ${started.error ?? "no reason given"}`);
  }
  await sleep(800);

  try {
    const owner = await portOwner(18080);
    if (!owner) throw new Error("nothing was reported as holding a port nginx is serving");

    // It must be OUR nginx, by path rather than by name.
    if (!owner.path || !owner.path.toLowerCase().includes("nginx")) {
      throw new Error(`reported ${owner.name} at ${owner.path ?? "an unknown path"}`);
    }

    // And it must be the MASTER: the process the socket belongs to may be a
    // worker, and a worker's parent is another nginx.
    const workers = await countNginx();
    console.log(`        ${workers} nginx process(es); owner reported as pid ${owner.pid}`);

    // The real assertion. If this stops only a worker, the master replaces it
    // and the port stays bound - which is exactly what the user saw.
    const freed = await freePort(owner, 18080);
    if (!freed.ok) throw new Error(`freePort said: ${freed.message}`);
    if (await inUse(18080)) throw new Error("freePort returned ok but the port is still held");
    console.log("        stopped it, and :18080 came free");
  } finally {
    state.services.clear();
    await stop("nginx").catch(() => {});
  }
});

/** How many nginx processes exist, for the log line above. Windows only; the
 *  count is context, never an assertion. */
async function countNginx() {
  if (process.platform !== "win32") return "?";
  const res = spawnSync("tasklist", ["/FI", "IMAGENAME eq nginx.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
  });
  return (res.stdout ?? "").split(/\r?\n/).filter((l) => l.includes("nginx.exe")).length;
}

// Recovery after a crash, which cannot be reasoned about: it depends on whether
// a spawned child outlives the process that started it, on what the OS reports
// as holding the port, and on whether the executable path it reports matches the
// one we would have launched closely enough to compare. All three are answered
// by driving it.
//
// The crash is simulated exactly as the extension experiences one: the process
// keeps running and the in-memory handle is gone. Nothing else about a relaunch
// is different.
await step("a service still running after a crash is taken back over", async () => {
  if (installedOf("nginx").length === 0) return;
  setConfig({ webServer: "nginx", httpPort: 18080, httpsPort: 18443, autoHttps: false });

  const started = await start("nginx");
  if (started.state !== "running") {
    throw new Error(`nginx did not start: ${started.error ?? "no reason given"}`);
  }
  await sleep(600);

  try {
    // The crash. The process lives; every trace of it in this extension does not.
    state.services.clear();
    if (!(await inUse(18080))) {
      // Nothing survived, so there is nothing to recover and nothing to check.
      // That is the correct outcome on a platform that kills children with
      // their parent, not a failure of this code.
      console.log("        the child did not outlive its parent here; nothing to adopt");
      return;
    }

    const found = await recoverRunning();
    if (found !== 1) throw new Error(`recovered ${found} services, expected 1`);

    const st = state.services.get("nginx");
    if (st?.state !== "running") throw new Error(`nginx reads "${st?.state}" after recovery`);
    if (st.port !== 18080) throw new Error(`recovered on port ${st.port}, expected 18080`);
    if (!st.adopted) throw new Error("recovered without a pid, so Stop could never reach it");
    if (st.handle !== null) throw new Error("an adopted service must have no host handle");

    // A second pass must not re-adopt what is already running, or every launch
    // would toast about services it recovered from itself.
    if ((await recoverRunning()) !== 0) throw new Error("re-adopted a service already running");

    // And the whole point: it can be stopped without the handle it lost.
    await stop("nginx");
    if (await inUse(18080)) throw new Error("an adopted service could not be stopped");
    console.log(`        adopted nginx (pid ${st.adopted}) on :18080, and stopped it again`);
  } finally {
    await stop("nginx").catch(() => {});
  }
});

// Something ELSE on the port is never adopted. The consequence of getting this
// wrong is a Stop button that kills a server this extension did not start, so
// the check is that a real listener we did not launch is left alone.
await step("a port held by something else is not adopted", async () => {
  if (installedOf("nginx").length === 0) return;
  setConfig({ webServer: "nginx", httpPort: 18081, httpsPort: 18443, autoHttps: false });
  state.services.clear();

  // A listener that is plainly not ours: node itself.
  const intruder = spawn(
    process.execPath,
    [
      "-e",
      "require('net').createServer().listen(18081, '127.0.0.1', () => setInterval(() => {}, 1e9))",
    ],
    { stdio: "ignore" },
  );
  try {
    for (let i = 0; i < 25 && !(await inUse(18081)); i++) await sleep(200);
    if (!(await inUse(18081))) throw new Error("the stand-in listener never came up");

    const found = await recoverRunning();
    if (found !== 0) throw new Error("adopted a process this extension never started");
    if (state.services.get("nginx")?.state === "running") {
      throw new Error("nginx was marked running because something else held its port");
    }
    console.log("        left a listener we did not start alone");
  } finally {
    intruder.kill();
  }
});

await step("a scheduled job runs the runtime the shim resolves", async () => {
  const installed = installedOf("node").find((r) => r.origin === "download");
  if (!installed) throw new Error("no managed node to resolve to");

  // What activation does, so the shims exist and know where node is.
  await writeShims();
  await writeGlobalEnv();

  const job = await saveJob({
    name: "version probe",
    schedule: "* * * * *",
    command: "node --version",
    cwd: root,
  });

  const res = await runJob(job);
  if (res.code !== 0) throw new Error(`the job exited ${res.code}: ${res.out}`);
  if (!res.out.includes(installed.version)) {
    throw new Error(
      `the job ran a different node: wanted ${installed.version}, got "${res.out.trim()}"`,
    );
  }
  // Recorded, because the dashboard reads the result off the job rather than
  // keeping a log the user has to go and find.
  if (job.lastExit !== 0 || !job.lastRun) throw new Error("the run was not recorded on the job");
  console.log(`        node --version through the shim -> ${res.out.trim()}`);
});

await step("a bare folder in www is a project, marker file or not", async () => {
  // This scanned for `composer.json`, `package.json`, `artisan` and friends,
  // which was right while it scanned any folder the user pointed it at and
  // wrong once it only ever scans the environment's own `www`: a folder in
  // there is a project because of where it is. The case that made it obvious is
  // the empty one you just made and are about to clone into - the scan said
  // "nothing new" about a folder the user had put there thirty seconds ago.
  const www = path.join(root, "www");
  const bare = path.join(www, "bare-checkout");
  const junk = path.join(www, "node_modules");
  mkdirSync(bare, { recursive: true });
  mkdirSync(junk, { recursive: true });
  mkdirSync(path.join(www, ".git"), { recursive: true });

  const found = await discoverProjects(www);
  const names = found.map((f) => f.name);
  if (!names.includes("bare-checkout")) {
    throw new Error(`an empty folder in www was not offered: saw ${names.join(", ") || "nothing"}`);
  }
  if (names.includes("node_modules")) throw new Error("a dependency tree was offered as a project");
  if (names.includes(".git")) throw new Error("a dotfolder was offered as a project");

  // And registering it takes it out of the answer, or every Refresh would add
  // the same project again.
  await addProject(bare);
  const again = await discoverProjects(www);
  if (again.some((f) => f.name === "bare-checkout")) {
    throw new Error("an already-registered folder was offered a second time");
  }
  console.log(`        offered ${names.join(", ")}, and not again once registered`);
});

// phpMyAdmin: a real download, unpacked and registered as a served project.
//
// The part that cannot be read off the code is the shape of the archive. It
// holds one `phpMyAdmin-<version>-all-languages/` directory, and serving THAT
// would put the version in the URL and leave `index.php` one level below where
// the vhost points - a 404 with nothing in any log to explain it.
await step("phpMyAdmin unpacks to a served folder, not a versioned one", async () => {
  setConfig({ autoHttps: false, webServer: "nginx", httpPort: 18080, httpsPort: 18443 });

  const release = await latestRelease();
  if (!release) {
    throw new Skip("phpmyadmin.net is unreachable; nothing to check against");
  }

  const url = await installPhpMyAdmin();
  const dir = path.join(root, "www", "phpmyadmin");
  if (!existsSync(path.join(dir, "index.php"))) {
    throw new Error(`index.php is not at the top of ${dir}; the wrapper was not lifted`);
  }
  // Its config has to name the port MySQL is actually on, or it reports the
  // server as down with no way to tell why from inside phpMyAdmin.
  const config = readFileSync(path.join(dir, "config.inc.php"), "utf8");
  if (!config.includes(`'port'] = '${plannedPort("mysql")}'`)) {
    throw new Error("config.inc.php does not point at the configured MySQL port");
  }
  // And it is a project, which is the whole reason it is served at all.
  if (!state.projects.some((pr) => pr.name === "phpmyadmin")) {
    throw new Error("phpMyAdmin was unpacked but never registered as a project");
  }
  console.log(`        phpMyAdmin ${release.version} -> ${url}`);
});

await step("uninstall removes the tree", async () => {
  const p = provider("node");
  const target = installedOf("node").find((r) => r.origin === "download")?.version;
  if (!target) throw new Error("nothing to uninstall");
  await uninstall(p, target);
  if (existsSync(installRoot(p, target))) throw new Error("install directory survived uninstall");
});

await step("a bad version is refused before anything is downloaded", async () => {
  const p = provider("node");
  let threw = false;
  try {
    await install(p, "../../escape");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("a path-traversal version was accepted");
});

// Retried, because a web server that has just been stopped can still hold a
// handle in its install directory for a moment after its port went quiet. A
// leftover temp folder is not worth failing a run that otherwise passed.
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
} catch {
  console.log(`\n  (left ${root} behind; something was still holding it)`);
}
console.log(`\n${failed === 0 ? "all live checks passed" : `${failed} live check(s) FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
