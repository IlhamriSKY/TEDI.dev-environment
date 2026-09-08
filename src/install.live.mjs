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

import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { setCtx, setConfig, state } from "./runtime.js";
import { provider } from "./registry/index.js";
import { install, uninstall, installRoot, verify } from "./manager/install.js";
import { scanInstalled, installedOf } from "./manager/versions.js";
import { addProject } from "./project/projects.js";
import { migrateLayout } from "./manager/migrate.js";
import { saveJob, runJob } from "./manager/cron.js";
import { writeShims } from "./project/shims.js";
import { writeGlobalEnv } from "./manager/apply.js";
import { generate } from "./web/vhost.js";
import { serverExe } from "./web/serverroot.js";
import { start, stop } from "./manager/services.js";
import { inUse } from "./web/ports.js";
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
    failed++;
    console.error(`  FAIL  ${name}\n        ${err?.message ?? err}`);
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
      throw new Error("the Apache Lounge index listed no builds - has the page or the URL moved?");
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
  setConfig({ autoHttps: false, webServer: "nginx" });
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

// Both servers, up at the same time, on ports that differ.
//
// The whole reason the second web server can exist: it takes a fixed offset
// instead of the configured pair, writes its own vhost tree and binds
// alongside. A syntax check cannot show that - only two live processes can.
//
// Deliberately on high ports. Binding 80 here would fight whatever the machine
// running the check is already serving, and the numbers under test are the
// OFFSET between the two, not the specific pair.
await step("both web servers run at once, on ports that differ", async () => {
  if (installedOf("nginx").length === 0 || installedOf("apache").length === 0) return;
  setConfig({ webServer: "nginx", httpPort: 18080, httpsPort: 18443, autoHttps: false });

  /** @type {Record<string, number | null>} */
  const bound = {};
  try {
    for (const id of ["nginx", "apache"]) {
      const status = await start(id);
      if (status.state !== "running") {
        throw new Error(`${id} did not start: ${status.error ?? "no reason given"}`);
      }
      bound[id] = status.port;
    }
    if (bound.nginx === bound.apache) {
      throw new Error(`both servers planned port ${bound.nginx}`);
    }
    // Started is not serving. Give each a moment to finish binding, then ask.
    await sleep(600);
    for (const [id, port] of Object.entries(bound)) {
      if (port === null) throw new Error(`${id} reported no port`);
      if (!(await inUse(port))) throw new Error(`${id} is running but nothing answers on ${port}`);
    }
    console.log(`        nginx :${bound.nginx}, apache :${bound.apache}, both answering`);
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
