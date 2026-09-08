// Self-check for the pure logic whose failure mode is silent or destructive.
//
// Run: `npm test`.
//
// Only the functions that CANNOT be checked by reading them are here. Rendering
// the hosts file is first because its failure mode is corrupting a system file
// that the user did not back up; php.ini editing is second because a bad regex
// there quietly disables every extension; version comparison is third because
// getting it wrong recommends a release ten patches old and nobody notices.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderHosts, MARKERS } from "./web/hosts.js";
import { SHIMS, windowsShim, posixShim } from "./project/shims.js";
import { plan } from "./core/archive.js";
import { setCtx, setConfig } from "./runtime.js";
import { parseLoungeIndex } from "./registry/servers.js";
import { matches, isValidSchedule, splitCommand } from "./manager/cron.js";
import { loadModuleLines } from "./web/serverroot.js";
import { serverPorts, plannedPort, portIsPinned } from "./web/ports.js";
import { setDirective, getDirective } from "./manager/phpini.js";
import { compareVersions, majorMinor, isPrerelease } from "./registry/util.js";
import { versionSatisfies } from "./project/resolve.js";
import { slug } from "./project/projects.js";
import { fastcgiPort } from "./web/vhost.js";

let passed = 0;
/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\nhosts file rendering");

test("keeps everything the user wrote, above and below", () => {
  const before = "127.0.0.1 localhost\n# my own comment";
  const after = "10.0.0.5 staging.internal";
  const out = renderHosts({ before, after }, ["a.test"], "\n");
  assert.ok(out.includes("127.0.0.1 localhost"), "lost the user's localhost line");
  assert.ok(out.includes("# my own comment"), "lost the user's comment");
  assert.ok(out.includes("10.0.0.5 staging.internal"), "lost the trailing section");
});

test("writes both an IPv4 and an IPv6 entry per domain", () => {
  const out = renderHosts({ before: "", after: "" }, ["a.test"], "\n");
  assert.ok(/127\.0\.0\.1\ta\.test/.test(out));
  assert.ok(/::1\ta\.test/.test(out));
});

test("is idempotent: rendering twice gives the same file", () => {
  const parts = { before: "127.0.0.1 localhost", after: "" };
  const once = renderHosts(parts, ["a.test", "b.test"], "\n");
  const twice = renderHosts(parts, ["a.test", "b.test"], "\n");
  assert.equal(once, twice);
});

test("an empty domain list removes the block entirely", () => {
  const out = renderHosts({ before: "127.0.0.1 localhost", after: "" }, [], "\n");
  assert.ok(!out.includes(MARKERS.BEGIN), "left an empty marker block behind");
  assert.ok(out.includes("127.0.0.1 localhost"));
});

test("always ends with exactly one newline", () => {
  for (const domains of [[], ["a.test"]]) {
    const out = renderHosts({ before: "x", after: "" }, domains, "\n");
    assert.ok(out.endsWith("\n"), "no trailing newline");
    assert.ok(!out.endsWith("\n\n"), "more than one trailing newline");
  }
});

console.log("\nphp.ini editing");

test("replaces a live directive in place, without appending a second one", () => {
  const ini = "; comment\nmemory_limit = 128M\ndisplay_errors = Off\n";
  const out = setDirective(ini, "memory_limit", "512M");
  assert.equal(getDirective(out, "memory_limit"), "512M");
  assert.equal((out.match(/memory_limit/g) ?? []).length, 1, "left a duplicate behind");
  assert.equal(getDirective(out, "display_errors"), "Off", "clobbered a neighbour");
});

test("uncomments and sets a commented-out default", () => {
  const out = setDirective(";memory_limit = 128M\n", "memory_limit", "512M");
  assert.equal(getDirective(out, "memory_limit"), "512M");
  assert.ok(!/^\s*;\s*memory_limit/m.test(out), "left the commented original");
});

test("appends a directive that appears nowhere", () => {
  const out = setDirective("display_errors = On\n", "date.timezone", "Asia/Jakarta");
  assert.equal(getDirective(out, "date.timezone"), "Asia/Jakarta");
});

test("a dot in the key is not a wildcard", () => {
  // `date.timezone` must not match `dateXtimezone`.
  const out = setDirective("dateXtimezone = UTC\n", "date.timezone", "Asia/Jakarta");
  assert.ok(out.includes("dateXtimezone = UTC"), "regex ate an unrelated key");
});

test("a commented directive reads as unset, not as its commented value", () => {
  assert.equal(getDirective(";memory_limit = 128M\n", "memory_limit"), null);
});

test("an inline comment is not part of the value", () => {
  assert.equal(getDirective("memory_limit = 512M ; was 128M\n", "memory_limit"), "512M");
});

console.log("\nversion ordering");

test("sorts numerically, not lexically", () => {
  const sorted = ["8.3.9", "8.3.10", "8.3.2"].sort(compareVersions);
  assert.deepEqual(sorted, ["8.3.10", "8.3.9", "8.3.2"]);
});

test("a release outranks its own prerelease", () => {
  assert.ok(compareVersions("8.4.0", "8.4.0-RC1") < 0);
});

test("differing segment counts compare as if zero-padded", () => {
  assert.ok(compareVersions("8.4", "8.4.1") > 0);
});

test("majorMinor takes the branch", () => {
  assert.equal(majorMinor("8.3.14"), "8.3");
  assert.equal(majorMinor("26.7.0"), "26.7");
});

test("the Stable badge agrees with the sorter about what a prerelease is", () => {
  // Two answers to one question is the bug this guards: `compareVersions`
  // already ranks a suffixed version below the plain one, so a picker calling
  // that same version Stable would contradict the order it was listed in.
  for (const v of ["8.4.0-RC1", "8.5.0-beta2", "1.2.3-alpha", "20.0.0-nightly", "3.0.0+build1"]) {
    assert.ok(isPrerelease(v), `${v} should read as a prerelease`);
    assert.ok(compareVersions(v.split(/[-+]/)[0], v) < 0, `${v} should sort below its release`);
  }
  for (const v of ["8.4.0", "1.2.3", "26.7.0", "2.10.3"]) {
    assert.ok(!isPrerelease(v), `${v} should read as stable`);
  }
});

console.log("\nproject runtime matching");

test("a branch request is satisfied by a patch release", () => {
  assert.ok(versionSatisfies("8.3.14", "8.3"));
  assert.ok(versionSatisfies("8.3.14", "8.3.14"));
});

test("a branch request does not match a longer number", () => {
  assert.ok(!versionSatisfies("8.30.1", "8.3"), "8.3 wrongly matched 8.30");
});

test("a system install still satisfies a pin", () => {
  assert.ok(versionSatisfies("8.3.14 (system)", "8.3"));
});

console.log("\ndomains and ports");

test("a folder name becomes a legal hostname label", () => {
  assert.equal(slug("My Shop (v2)"), "my-shop-v2");
  assert.equal(slug("---"), "project");
  assert.ok(slug("a".repeat(200)).length <= 63);
});

test("the FastCGI port is stable for a version and differs between versions", () => {
  assert.equal(fastcgiPort("8.3.14"), fastcgiPort("8.3.14"));
  assert.notEqual(fastcgiPort("8.3.14"), fastcgiPort("8.4.1"));
  assert.ok(fastcgiPort("8.3.14") >= 9000 && fastcgiPort("8.3.14") < 13000);
});

console.log("\narchive extraction plans");

// These three all cost a real failure during the live install check, and all
// three are invisible without running an extraction, so they are pinned here.

test("a zip always has a fallback, on every platform", () => {
  for (const platform of ["windows", "macos", "linux"]) {
    setCtx(/** @type {any} */ ({ os: { platform, arch: "x86_64" } }));
    const attempts = plan("node.zip", "/tmp/x");
    assert.ok(
      attempts.length > 1,
      `${platform} offers only one way to unpack a zip; GNU tar on PATH would end there`,
    );
  }
});

test("Windows names the system bsdtar outright, not just `tar`", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "windows", arch: "x86_64" } }));
  const [first] = plan("node.zip", "C:\\dest");
  assert.match(
    first[0],
    /System32[\\/]tar\.exe$/i,
    "the first attempt must bypass PATH, where GNU tar may shadow bsdtar",
  );
});

test("a tarball needs no decompression flag on either tar", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "linux", arch: "x86_64" } }));
  for (const name of ["x.tar.gz", "x.tar.xz", "x.tgz"]) {
    const [[, args]] = plan(name, "/tmp/x");
    assert.deepEqual(args.slice(0, 2), ["-xf", name], `${name} should use bare -xf`);
  }
});

console.log("\nweb servers");

// Three checks, and each one is a bug that shipped. None of them failed loudly:
// the first reported "no build on this platform", which is the honest answer on
// macOS and Linux and so read as normal; the second aborted Apache at startup
// with a message about a file the user never wrote; the third made the second
// web server unstartable for a reason that was in neither server's log.

test("the Apache Lounge index is read case-insensitively", () => {
  // Copied from the live page. The capital W is the whole point: the pattern
  // matched a lowercase `win64` and found ZERO builds, which is indistinguishable
  // from "this platform has no Apache" and is why it was never installed.
  const html = `
    <a href="/download/VS18/binaries/httpd-2.4.68-260827-Win64-VS18.zip">Apache 2.4.68 Win64</a>
    <a href="/download/VS18/binaries/httpd-2.4.68-260827-win32-vs18.zip">Apache 2.4.68 Win32</a>`;
  const index = parseLoungeIndex(html);
  assert.equal(index.size, 1, "did not find exactly one build");
  const url = index.get("2.4.68");
  assert.ok(url, "2.4.68 was not indexed");
  assert.match(url, /Win64-VS18\.zip$/, "picked something other than the 64-bit archive");
  assert.doesNotMatch(url, /win32/i, "the 32-bit build must never be selected");
});

test("LoadModule names only modules this build actually ships", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "windows", arch: "x86_64" } }));
  // Exactly what the Windows archive contains: no MPM module and no unixd,
  // because both are compiled in. Naming either aborts startup with
  // "Cannot load modules/mod_mpm_event.so into server".
  const windows = new Set([
    "mod_authz_core.so",
    "mod_dir.so",
    "mod_mime.so",
    "mod_proxy_fcgi.so",
    "mod_ssl.so",
  ]);
  const lines = loadModuleLines(windows, "C:\\srv\\apache\\modules");
  assert.equal(lines.length, 5, "wrote a line per available module and no more");
  assert.ok(
    !lines.some((l) => /mpm_|unixd/.test(l)),
    "named a module the Windows build does not ship",
  );
  assert.ok(
    lines.every((l) => /"[^"]*modules\/mod_\w+\.so"$/.test(l)),
    "a LoadModule path must be absolute and forward-slashed",
  );
});

test("only one MPM is loaded even when several are present", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "linux", arch: "x86_64" } }));
  const linux = new Set(["mod_mpm_event.so", "mod_mpm_prefork.so", "mod_unixd.so", "mod_dir.so"]);
  const lines = loadModuleLines(linux, "/usr/lib/apache2/modules");
  assert.equal(lines.filter((l) => l.includes("mpm_")).length, 1, "two MPMs cannot coexist");
  assert.ok(lines.some((l) => l.includes("unixd")));
});

test("nothing is written when the modules directory was not found", () => {
  assert.deepEqual(loadModuleLines(new Set(["mod_dir.so"]), null), []);
});

test("both web servers plan the configured port, because only one runs", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "windows", arch: "x86_64" } }));
  setConfig({ webServer: "nginx", httpPort: 80, httpsPort: 443, ports: {} });
  // They used to differ, so that both could serve at once. Starting one stops
  // the other now, so the port you configured is the port either of them binds
  // and no offset has to be explained in a URL.
  assert.deepEqual(serverPorts("nginx"), { http: 80, https: 443 });
  assert.deepEqual(serverPorts("apache"), { http: 80, https: 443 });

  setConfig({ httpPort: 8080, httpsPort: 8443 });
  assert.equal(serverPorts("apache").http, 8080, "the setting is the answer for both");
  setConfig({ httpPort: 80, httpsPort: 443 });
});

test("a port somebody typed is honoured, and never moved out from under them", () => {
  setCtx(/** @type {any} */ ({ os: { platform: "windows", arch: "x86_64" } }));
  setConfig({ webServer: "nginx", httpPort: 80, httpsPort: 443, ports: {} });

  // Untouched: the convention, and free to move when something else has it.
  assert.equal(plannedPort("mysql"), 3306);
  assert.equal(portIsPinned("mysql"), false);

  // Pinned: the number is used, and `choosePort` must not walk past it - they
  // typed 3307 because a connection string says 3307.
  setConfig({ ports: { mysql: 3307 } });
  assert.equal(plannedPort("mysql"), 3307);
  assert.equal(portIsPinned("mysql"), true);

  // A web server is always pinned: its port is in every project URL.
  assert.equal(portIsPinned("nginx"), true);
  setConfig({ ports: {} });
});

setCtx(null);

console.log("\ncron expressions");

// A scheduler's failure mode is silence. A job that never fires and a job that
// fires sixty times an hour both look like "nothing is wrong" from the code, so
// the matcher is pinned against real expressions rather than read.

/** @param {string} iso */
const at = (iso) => new Date(iso);

test("every minute means every minute", () => {
  assert.ok(matches("* * * * *", at("2026-09-08T11:07:00")));
  assert.ok(matches("* * * * *", at("2026-01-01T00:00:00")));
});

test("a step fires on the step, and not between", () => {
  assert.ok(matches("*/5 * * * *", at("2026-09-08T11:05:00")));
  assert.ok(matches("*/5 * * * *", at("2026-09-08T11:00:00")));
  assert.ok(!matches("*/5 * * * *", at("2026-09-08T11:07:00")));
});

test("an hour and minute pin to one minute a day", () => {
  assert.ok(matches("30 3 * * *", at("2026-09-08T03:30:00")));
  assert.ok(!matches("30 3 * * *", at("2026-09-08T04:30:00")));
  assert.ok(!matches("30 3 * * *", at("2026-09-08T03:31:00")));
});

test("a list and a range both match", () => {
  assert.ok(matches("0 9,17 * * *", at("2026-09-08T17:00:00")));
  assert.ok(!matches("0 9,17 * * *", at("2026-09-08T18:00:00")));
  assert.ok(matches("0 9-11 * * *", at("2026-09-08T10:00:00")));
  assert.ok(!matches("0 9-11 * * *", at("2026-09-08T12:00:00")));
});

test("day-of-month and day-of-week are OR, not AND", () => {
  // crontab(5): when both are restricted, EITHER matching is a match. Getting
  // this backwards makes `0 0 1 * 1` fire roughly never instead of twice a week.
  // 2026-09-01 is a Tuesday, so the 1st matches and Monday does not.
  assert.ok(matches("0 0 1 * 1", at("2026-09-01T00:00:00")), "the 1st should match on its own");
  // 2026-09-07 is a Monday and not the 1st.
  assert.ok(matches("0 0 1 * 1", at("2026-09-07T00:00:00")), "Monday should match on its own");
  // 2026-09-08 is a Tuesday and not the 1st: neither half matches.
  assert.ok(!matches("0 0 1 * 1", at("2026-09-08T00:00:00")));
});

test("a restricted weekday still narrows when the day-of-month is *", () => {
  assert.ok(matches("0 0 * * 1", at("2026-09-07T00:00:00")));
  assert.ok(!matches("0 0 * * 1", at("2026-09-08T00:00:00")));
});

test("Sunday is both 0 and 7", () => {
  // 2026-09-06 is a Sunday.
  assert.ok(matches("0 0 * * 0", at("2026-09-06T00:00:00")));
  assert.ok(matches("0 0 * * 7", at("2026-09-06T00:00:00")));
});

test("the @ aliases mean what cron says they mean", () => {
  assert.ok(matches("@hourly", at("2026-09-08T11:00:00")));
  assert.ok(!matches("@hourly", at("2026-09-08T11:01:00")));
  assert.ok(matches("@daily", at("2026-09-08T00:00:00")));
  assert.ok(!matches("@daily", at("2026-09-08T01:00:00")));
});

test("a typo never becomes a wildcard", () => {
  // The dangerous failure: a field that does not parse must not read as `*` and
  // turn a nightly job into a every-minute one.
  assert.ok(!matches("0 0 * * frobnicate", at("2026-09-08T00:00:00")));
  assert.ok(!matches("not a schedule", at("2026-09-08T00:00:00")));
  assert.ok(!matches("* * * *", at("2026-09-08T00:00:00")), "four fields is not a schedule");
});

test("the editor rejects what would never fire", () => {
  assert.ok(isValidSchedule("* * * * *"));
  assert.ok(isValidSchedule("*/15 2-4 1,15 * 1-5"));
  assert.ok(isValidSchedule("@weekly"));
  assert.ok(!isValidSchedule("* * * *"));
  assert.ok(!isValidSchedule("99 * * * *"), "a minute out of range can never match");
  assert.ok(!isValidSchedule(""));
});

console.log("\ncron command parsing");

test("a quoted path stays one argument", () => {
  assert.deepEqual(splitCommand('php "D:\\Dev Env\\www\\my site\\artisan" schedule:run'), [
    "php",
    "D:\\Dev Env\\www\\my site\\artisan",
    "schedule:run",
  ]);
});

test("ordinary words split on whitespace", () => {
  assert.deepEqual(splitCommand("  npm   run   backup "), ["npm", "run", "backup"]);
});

test("an explicitly empty argument survives", () => {
  assert.deepEqual(splitCommand('php artisan tinker --execute ""'), [
    "php",
    "artisan",
    "tinker",
    "--execute",
    "",
  ]);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(splitCommand("   "), []);
});

console.log("\nrescan-after-change (source, because only the live app shows it)");

// The bug this pins: `openInstaller` downloaded correctly and never rescanned,
// so a successful install was invisible in the dashboard and `global.env` kept
// resolving to the previous runtime. Nothing failed, nothing threw, and the
// only symptom was the UI disagreeing with the disk - which is why it survived
// a typecheck, 27 unit tests and a code read, and was caught by driving the
// real app. Asserted as source text because the alternative is mounting the
// whole extension host.

test("every runtime mutation is followed by applyRuntimeChange", () => {
  // Across every view that can mutate, not one of them. The installer moved out
  // of `runtimes-view` when the service rows gained the same control, and this
  // check caught it - which is the whole point, but it only caught it because
  // the file was named. So the file list is derived from the mutations rather
  // than the other way round, and EVERY occurrence is checked, not the first.
  const files = ["ui/runtimes-view.js", "ui/version-picker.js", "ui/services-view.js"];
  const mutations = ["await install(", "await uninstall(", "await setActiveVersion("];

  /** @type {string[]} */
  const seen = [];
  for (const file of files) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const mutation of mutations) {
      let at = src.indexOf(mutation);
      while (at >= 0) {
        seen.push(mutation);
        assert.ok(
          src.indexOf("applyRuntimeChange()", at) > at,
          `${file}: ${mutation} is not followed by applyRuntimeChange(); the dashboard would show stale state`,
        );
        at = src.indexOf(mutation, at + 1);
      }
    }
  }

  // And the mutations still happen SOMEWHERE, or the loop above passes by
  // finding nothing at all.
  for (const mutation of mutations) {
    assert.ok(seen.includes(mutation), `nothing calls ${mutation} any more`);
  }
});

test("applyRuntimeChange does all three things, not one", () => {
  const src = readFileSync(new URL("./manager/apply.js", import.meta.url), "utf8");
  for (const step of ["scanInstalled()", "writeGlobalEnv()", "refreshAllRuntimes()"]) {
    assert.ok(src.includes(step), `applyRuntimeChange no longer calls ${step}`);
  }
});

console.log("\nshim scripts (executed, not just generated)");

// The batch walk is the single most fragile thing in this extension: it reads
// correct and can behave otherwise, delayed expansion is easy to get subtly
// wrong, and its failure is a terminal where `php` mysteriously resolves to the
// wrong version. So the REAL generated script is written to disk and run.

const tmp = mkdtempSync(join(tmpdir(), "devenv-shim-"));
const shimsDir = join(tmp, "shims");
const nested = join(tmp, "project", "src", "deep");
mkdirSync(shimsDir, { recursive: true });
mkdirSync(nested, { recursive: true });

const phpShim = SHIMS.find((s) => s.name === "php");

/** @param {string} cwd @returns {{ code: number, out: string }} */
function runShim(cwd, file) {
  const isWin = process.platform === "win32";
  const res = isWin
    ? spawnSync("cmd.exe", ["/c", file], { cwd, encoding: "utf8" })
    : spawnSync("sh", [file], { cwd, encoding: "utf8" });
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * What the shim prints when the walk and the fallback both came up empty. That
 * message - not an exit code - is the thing these tests are actually about.
 *
 * The tests used to assert `code !== 127`, on the reasoning that 127 is the
 * shim's own "nothing is configured" exit. That holds on Windows and is WRONG on
 * POSIX: `sh` also exits 127 when the exec target is missing ("exec: .../php:
 * not found"), so the two states the assertion separates produce the same
 * number, and all three tests failed the first time CI ran them on Linux.
 */
const UNCONFIGURED = /no PHP_BIN is configured/i;

/**
 * A runtime directory the shim can resolve, and on POSIX actually execute.
 *
 * POSIX gets a real `php` script, so the test proves the resolved path is not
 * merely computed but RUN. Windows shims exec `php.exe` specifically, and a
 * genuine one cannot be fabricated here - so there the assertion stays at "the
 * shim resolved something instead of giving up", which is what it can honestly
 * check.
 *
 * @param {string} dir @param {string} marker @returns {string} the dir
 */
function fakeRuntime(dir, marker) {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    const exe = join(dir, "php");
    writeFileSync(exe, `#!/bin/sh\necho ${marker}\n`);
    chmodSync(exe, 0o755);
  }
  return dir;
}

/** True when the shim ran the fake and it printed its marker. POSIX only. */
const ranMarker = (out, marker) =>
  process.platform === "win32" ? true : new RegExp(marker).test(out);

const shimFile = join(shimsDir, process.platform === "win32" ? "php.cmd" : "php");
writeFileSync(shimFile, process.platform === "win32" ? windowsShim(phpShim) : posixShim(phpShim));

test("reports a clear error, and exit 127, when nothing is configured", () => {
  const { code, out } = runShim(nested, shimFile);
  assert.equal(code, 127, `expected exit 127, got ${code}: ${out}`);
  assert.match(out, /no PHP_BIN is configured/i);
});

test("walks UP from the working directory to find .tedi-runtime", () => {
  // The file sits three levels above where the command runs.
  fakeRuntime(join(tmp, "fake-php"), "FAKE_PHP_RAN");
  writeFileSync(
    join(tmp, "project", ".tedi-runtime"),
    "# generated\nPHP_BIN=" + join(tmp, "fake-php") + "\n",
  );
  const { out } = runShim(nested, shimFile);
  assert.doesNotMatch(out, UNCONFIGURED, `did not resolve the parent's runtime file: ${out}`);
  assert.ok(ranMarker(out, "FAKE_PHP_RAN"), `resolved a path but did not run it: ${out}`);
});

test("falls back to global.env when no project declares one", () => {
  rmSync(join(tmp, "project", ".tedi-runtime"));
  fakeRuntime(join(tmp, "global-php"), "GLOBAL_PHP_RAN");
  writeFileSync(join(tmp, "global.env"), "PHP_BIN=" + join(tmp, "global-php") + "\n");
  const { out } = runShim(nested, shimFile);
  assert.doesNotMatch(out, UNCONFIGURED, `fallback to global.env did not happen: ${out}`);
  assert.ok(ranMarker(out, "GLOBAL_PHP_RAN"), `fell back but did not run it: ${out}`);
});

test("a comment line in the runtime file is not parsed as a key", () => {
  fakeRuntime(join(tmp, "right"), "RIGHT_PHP_RAN");
  writeFileSync(
    join(tmp, "project", ".tedi-runtime"),
    "# PHP_BIN=C:\\wrong\\commented\nPHP_BIN=" + join(tmp, "right") + "\n",
  );
  const { out } = runShim(nested, shimFile);
  assert.ok(!out.includes("commented"), `used a commented-out line: ${out}`);
  assert.doesNotMatch(out, UNCONFIGURED, `the commented line broke the parse: ${out}`);
  assert.ok(ranMarker(out, "RIGHT_PHP_RAN"), `did not run the uncommented value: ${out}`);
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}\n`);
