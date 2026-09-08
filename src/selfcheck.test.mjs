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
import { setCtx, setConfig, state } from "./runtime.js";
import { startsWithAll } from "./manager/config.js";
import { parseNetstat, parseTasklist, parseLsof, parseSs } from "./web/portowner.js";
import { parseLoungeIndex } from "./registry/servers.js";
import { matches, isValidSchedule, splitCommand } from "./manager/cron.js";
import { loadModuleLines } from "./web/serverroot.js";
import { serverPorts, plannedPort, portIsPinned } from "./web/ports.js";
import { setDirective, getDirective } from "./manager/phpini.js";
import { compareVersions, majorMinor, isPrerelease } from "./registry/util.js";
import { versionSatisfies } from "./project/resolve.js";
import { slug } from "./project/projects.js";
import { fastcgiPort } from "./web/vhost.js";
import { offeredConnections } from "./manager/handoff.js";
import { releaseDate } from "./ui/version-picker.js";

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

test("applyRuntimeChange does every consequence, not one", () => {
  const src = readFileSync(new URL("./manager/apply.js", import.meta.url), "utf8");
  const steps = [
    "scanInstalled()",
    "writeGlobalEnv()",
    "refreshAllRuntimes()",
    // A database install changes what the handoff file offers, so it is a
    // consequence of a runtime change exactly like the three above.
    "publishHandoff()",
  ];
  for (const step of steps) {
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

console.log("\nasking before destroying (source, because a modal needs a DOM)");

// Every Remove in this pane used to fire on the first click. They are not
// equal - removing a project unpublishes a site, removing a version deletes a
// four-minute download - and none of them can be undone, so all of them ask.
// Source text for the same reason the check above is: the alternative is
// mounting the whole extension host to click a button.

test("every Remove asks first", () => {
  const sites = [
    ["ui/runtimes-view.js", "await uninstall("],
    ["ui/cron-view.js", "await removeJob("],
    ["ui/projects-view.js", "await removeProject("],
  ];
  for (const [file, call] of sites) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const at = src.indexOf(call);
    assert.ok(at > 0, `${file}: nothing calls ${call} any more`);
    // The confirm and its bail-out both come BEFORE the destructive call, or
    // the dialog is decoration over something that already happened.
    const before = src.slice(0, at);
    assert.ok(
      before.lastIndexOf("await confirm({") > before.lastIndexOf("button("),
      `${file}: ${call} is reachable without confirm()`,
    );
    assert.ok(before.includes("if (!ok) return;"), `${file}: ${call} ignores the answer`);
  }
});

console.log("\nthe status bar follows what is running");

// The bar is what you read when the pane is CLOSED, and the poll that drives
// the pane only runs while a pane is mounted - so driving the bar from there
// would leave it stale in exactly the case it exists for. It hangs off the same
// state transition the repaint does.

test("a service starting or stopping reaches the status bar", () => {
  const src = readFileSync(new URL("./manager/services.js", import.meta.url), "utf8");
  const at = src.indexOf("function setStatus(");
  assert.ok(at > 0, "setStatus is gone");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(
    body,
    /patch\.state !== undefined && patch\.state !== before/,
    "setStatus no longer guards on a real change, so the poll would repaint every tick",
  );
  assert.ok(
    body.includes("state.onServices?.()"),
    "a state change no longer reaches the status bar",
  );

  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(
    index,
    /tone: running\.length > 0 \? "success" : "default"/,
    "the status item no longer lights up while something is running",
  );
  // A late callback firing into a torn-down context is the classic version of
  // this bug, and the one that survives a reload as a hard-to-place error.
  assert.match(index, /state\.onServices = null;/, "deactivate leaves the sync callback attached");
});

console.log("\nwho is holding the port");

// "Port 80 is already in use" is true and useless. Naming the process is the
// whole difference between a dead end and one button, and the naming is four
// text parsers against four tools whose output nobody here controls - so they
// are pure functions checked against REAL output, captured from the machines
// this runs on rather than written from memory of the man page.

test("netstat: the LISTENING row for the port, and only that row", () => {
  // Captured from `netstat -ano -p TCP` on Windows 11.
  const out = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1520",
    "  TCP    0.0.0.0:7680           0.0.0.0:0              LISTENING       3176",
    "  TCP    127.0.0.1:80           0.0.0.0:0              LISTENING       9012",
    // An outbound connection FROM 80 is not what blocks a bind. Matching it
    // would offer to kill a browser.
    "  TCP    192.168.1.5:52210      93.184.216.34:80       ESTABLISHED     4444",
    "  TCP    [::]:7680              [::]:0                 LISTENING       3176",
  ].join("\r\n");

  assert.equal(parseNetstat(out, 7680), 3176);
  assert.equal(parseNetstat(out, 80), 9012, "a loopback-only listener still holds the port");
  assert.equal(parseNetstat(out, 135), 1520);
  assert.equal(parseNetstat(out, 4444), null, "an ESTABLISHED row must never match");
  assert.equal(parseNetstat(out, 3306), null);

  // IPv6: splitting on the FIRST colon takes the whole address and every row
  // parses as NaN.
  const v6 = "  TCP    [::]:443               [::]:0                 LISTENING       2200";
  assert.equal(parseNetstat(v6, 443), 2200, "an IPv6 local address must still yield its port");
});

test("tasklist: the image name out of the CSV row", () => {
  // Captured from `tasklist /FI "PID eq 3176" /FO CSV /NH`.
  assert.equal(parseTasklist('"svchost.exe","3176","Services","0","25.624 K"'), "svchost.exe");
  assert.equal(parseTasklist('"php-cgi.exe","880","Console","1","9,120 K"'), "php-cgi.exe");
  // A pid with no process answers with a sentence, not a row.
  assert.equal(
    parseTasklist("INFO: No tasks are running which match the specified criteria."),
    null,
  );
  assert.equal(parseTasklist(""), null);
});

test("lsof and ss name the process on the other two platforms", () => {
  // `lsof -nP -iTCP:80 -sTCP:LISTEN -F pc`
  assert.deepEqual(parseLsof("p1234\ncnginx\np1235\ncnginx\n"), { pid: 1234, name: "nginx" });
  // A pid with no command line still gets acted on.
  assert.deepEqual(parseLsof("p1234\n"), { pid: 1234, name: "?" });
  assert.equal(parseLsof(""), null);

  // `ss -H -ltnp 'sport = :80'`
  const ss =
    'LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1234,fd=6))';
  assert.deepEqual(parseSs(ss), { pid: 1234, name: "nginx" });
  assert.equal(parseSs("LISTEN 0 511 0.0.0.0:80 0.0.0.0:*"), null, "no users: column, no owner");
});

console.log("\nwhat Start all starts");

// Two databases run side by side perfectly happily, which is exactly the
// problem: "Start all" started every one that was installed, so anyone who had
// tried both ended up with a second database running and holding its port every
// time they pressed it. The tick is per service, and ABSENT MEANS YES so an
// environment configured before this existed starts what it always did.

test("Start all includes a service until it is unticked", () => {
  setConfig({ autostart: {} });
  assert.equal(startsWithAll("mysql"), true, "absent must mean included");

  setConfig({ autostart: { mysql: false } });
  assert.equal(startsWithAll("mysql"), false, "an unticked service must be skipped");
  assert.equal(startsWithAll("postgres"), true, "unticking one must not affect another");
  setConfig({ autostart: {} });
});

test("the scheduler is the one that stays off until it is asked for", () => {
  // It fires jobs - a queue worker, a backup, a deploy - so a scheduler that
  // comes up because you pressed "Start all" is the one that surprises you at
  // 3am. Every other service is a server sitting on a port waiting to be asked
  // something, which is harmless to have running.
  setConfig({ autostart: {} });
  assert.equal(startsWithAll("cron"), false, "the scheduler must default to OFF");
  for (const id of ["mysql", "postgres", "redis"]) {
    assert.equal(startsWithAll(id), true, `${id} must default to ON`);
  }

  // Ticking it stores the departure; unticking it again stores nothing, so the
  // record stays the set of deliberate exceptions rather than a copy of every
  // service.
  setConfig({ autostart: { cron: true } });
  assert.equal(startsWithAll("cron"), true, "ticking the scheduler must include it");
  setConfig({ autostart: {} });
});

test("Start all consults the tick, and a web server's tick is which one", () => {
  const src = readFileSync(new URL("./manager/services.js", import.meta.url), "utf8");
  const at = src.indexOf("export async function startAll");
  assert.ok(at > 0, "startAll is gone");
  assert.ok(
    src.indexOf("startsWithAll(", at) > at,
    "startAll no longer checks the tick, so it starts every installed database again",
  );

  // A web server's tick is exclusive and writes `webServer`, not `autostart`:
  // nginx and apache cannot both hold port 80, so there is no state where
  // neither is chosen, and unticking the ticked one has to be a no-op.
  const view = readFileSync(new URL("./ui/services-view.js", import.meta.url), "utf8");
  const tick = view.slice(view.indexOf("function rowTick("));
  assert.ok(tick.length > 0, "the row tick is gone");
  assert.match(
    tick,
    /if \(web && on\) return;/,
    "unticking the serving web server would leave the projects with no server at all",
  );
  assert.match(
    tick,
    /if \(web\) await useWebServer\(/,
    "a web server's tick must hand over, not write autostart",
  );
  // And the button that used to say the same thing is gone, rather than left to
  // be kept in agreement with it.
  assert.ok(
    !view.includes('button("Use this"'),
    "two controls now say which web server serves, and they can disagree",
  );
});

console.log("\nasking for administrator rights");

// The hosts file is the only thing here that needs elevation, and it holds ONE
// thing: project domains pointed at 127.0.0.1. So an action that cannot change
// the project set must not trigger a sync. Switching from Apache to nginx
// raising a UAC prompt is a frightening thing to be asked for pressing "Use
// this", and the prompt cannot even be explained by what was pressed.

test("only a change to the projects can ask for administrator rights", () => {
  const server = readFileSync(new URL("./ui/services-view.js", import.meta.url), "utf8");
  let at = server.indexOf("publish(");
  assert.ok(at > 0, "services-view no longer publishes at all");
  while (at >= 0) {
    assert.ok(
      server.startsWith("publish({ hosts: false })", at),
      `services-view.js: a publish() at index ${at} still syncs the hosts file; ` +
        "nothing in that view changes a project domain",
    );
    at = server.indexOf("publish(", at + 1);
  }

  // And the views that DO change domains must still sync, or a new project
  // resolves nowhere.
  for (const file of ["ui/projects-view.js", "ui/settings-view.js"]) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(
      src,
      /await publish\(\)/,
      `${file} never syncs the hosts file, so its domains would resolve nowhere`,
    );
  }
});

test("the elevated window is hidden, and the prompt is not", () => {
  const src = readFileSync(new URL("./core/elevate.js", import.meta.url), "utf8");
  // Everything else is spawned with CREATE_NO_WINDOW by the host; `-Verb RunAs`
  // goes out through ShellExecute and inherits none of it.
  assert.ok(
    src.includes("-Verb RunAs -WindowStyle Hidden"),
    "the elevated PowerShell would flash a console window over the app",
  );
  assert.ok(src.includes("-Verb RunAs"), "the elevation no longer asks for administrator rights");
});

console.log('\none way to say "working"');

// The pane had THREE ideas of it at once: a breathing ring on a service row, a
// spinning Play triangle on the button beside it, and a plain idle circle on the
// setup step actually running the download. A rotating triangle is not a thing
// loading, it is a thing gone wrong, and a checklist drawing "idle" over a live
// download is just wrong. One glyph, named once, swapped in - asserted as source
// text because none of it exists outside a DOM.

test("one loading glyph, named once", () => {
  const el = readFileSync(new URL("./ui/el.js", import.meta.url), "utf8");
  assert.match(
    el,
    /const LOADING_ICON = "lucide:LoaderCircle"/,
    "el.js no longer names the loading glyph in one place",
  );
  // A button SWAPS to it rather than spinning whatever icon it already has.
  assert.ok(el.includes("const setLoading = (on) =>"), "button() no longer swaps its icon");
  assert.ok(
    el.includes("setLoading(true);"),
    "nothing puts a button into its loading state while its handler runs",
  );
  // And no view invents a second one.
  const views = [
    "ui/runtimes-view.js",
    "ui/services-view.js",
    "ui/projects-view.js",
    "ui/dashboard.js",
    "ui/cron-view.js",
    "ui/php-view.js",
    "ui/version-picker.js",
  ];
  for (const file of views) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      src,
      /lucide:(Loader|CircleDashed|RefreshCcw)/,
      `${file} names a loading glyph of its own; use status("working")`,
    );
  }
});

test("every row that can be busy draws the working state", () => {
  const sites = [
    ["ui/runtimes-view.js", 'status(busy ? "working"'],
    ["ui/services-view.js", 'busy ? "working"'],
    ["ui/dashboard.js", 'status(step.working ? "working"'],
  ];
  for (const [file, needle] of sites) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(src.includes(needle), `${file} does not show a working state; it draws idle instead`);
  }
});

console.log("\nthe version picker");

test("a release date reads day-month-year, whatever the upstream sends", () => {
  // Every upstream states it ISO, some with a time on the end, and one or two
  // send nothing recognisable at all. The last case must still render: a picker
  // row that throws takes the whole list with it.
  assert.equal(releaseDate("2024-04-24"), "24-04-2024");
  assert.equal(releaseDate("2024-04-24T19:35:44.000Z"), "24-04-2024");
  assert.equal(releaseDate("2026-01-05"), "05-01-2026", "a single-digit day keeps its zero");
  assert.equal(releaseDate("8.3.14"), "8.3.14", "an unparseable date is shown, not dropped");
  assert.equal(releaseDate(""), "");
});

console.log("\nthe database handoff");

// What another extension is handed. The shape is SQL Explorer's own connection
// record on purpose, so its existing import sanitiser accepts these unchanged;
// these assertions are the parts of that shape a typo would break silently,
// because the reader answers a bad record by showing nothing at all.

test("every offered connection is addressable and prefixed", () => {
  for (const id of ["mysql", "postgres"]) {
    state.installed.set(id, [{ version: "1.0", origin: "download", dir: "/x", binDir: "/x" }]);
  }
  const offered = offeredConnections();
  assert.equal(offered.length, 2, "both installed databases are offered");
  for (const conn of offered) {
    assert.ok(conn.id.startsWith("devenv:"), `${conn.id} is not namespaced to this extension`);
    assert.equal(conn.host, "127.0.0.1", "a managed database is loopback only");
    // The reader stores ports as strings (a blank one means "the dialect
    // default"), so a number here would be dropped by its sanitiser.
    assert.equal(typeof conn.port, "string", `${conn.id}: port must be a string`);
    assert.ok(Number(conn.port) > 0, `${conn.id}: port ${conn.port} is not a port`);
    assert.ok(conn.user, `${conn.id}: no user to log in as`);
  }
  // PostgreSQL binds ONE database per connection, so a blank target cannot
  // connect at all; MySQL reaches every database over one connection.
  assert.equal(offered.find((c) => c.kind === "postgres")?.database, "postgres");
  state.installed.clear();
});

test("nothing is offered when no database is installed", () => {
  state.installed.clear();
  assert.deepEqual(offeredConnections(), []);
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}\n`);
