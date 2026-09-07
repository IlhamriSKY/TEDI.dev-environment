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
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { setCtx, setConfig, state } from "./runtime.js";
import { provider } from "./registry/index.js";
import { install, uninstall, installRoot, verify } from "./manager/install.js";
import { scanInstalled, installedOf } from "./manager/versions.js";
import { ensureDirs } from "./core/fsx.js";
import { layoutDirs } from "./core/paths.js";

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
      const proc = spawn(args.program, args.args ?? [], {
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

    case "port_is_open":
      return false;

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

rmSync(root, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "all live checks passed" : `${failed} live check(s) FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
