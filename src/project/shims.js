// Shims: how a terminal ends up running the project's PHP instead of the
// global one.
//
// TEDI's `pty_open` takes cols, rows and cwd, and NO environment. That single
// host fact rules out the obvious design (compute the project's env, hand it to
// the terminal) and leaves exactly one that works: put a directory of small
// executables on PATH, and have each of them work out at exec time which real
// binary to call, from the directory it was invoked in.
//
// So a shim walks up from `$PWD` looking for a `.tedi-runtime` file, which the
// extension generates next to a project's config. That file is flat
// `KEY=VALUE` text rather than JSON for one reason: a Windows `.cmd` can parse
// it with `for /f` and no interpreter, which keeps the added latency of every
// `php` call in the tens of milliseconds. Parsing JSON there would mean
// starting PowerShell per command.
//
// The directory itself is registered once with TEDI's "Additional PATH"
// setting, which `pty/shell_init.rs` reads per spawn - so a change to a
// project's runtime is picked up by the next terminal with no restart of TEDI,
// the PTY daemon, or anything else.

import { paths, join } from "../core/paths.js";
import { writeText, mkdirp, remove, readDir } from "../core/fsx.js";
import { run } from "../core/proc.js";
import { isWindows } from "../runtime.js";

/**
 * One shimmed command.
 *
 * `key` is the `.tedi-runtime` variable naming the bin directory; `exe` is the
 * file inside it. `viaPhp` marks a phar that has to be handed to an interpreter
 * rather than executed.
 *
 * @typedef {{ name: string, key: string, exe: string, viaPhp?: boolean }} Shim
 */

/** @type {Shim[]} */
export const SHIMS = [
  { name: "php", key: "PHP_BIN", exe: "php" },
  { name: "php-cgi", key: "PHP_BIN", exe: "php-cgi" },
  { name: "node", key: "NODE_BIN", exe: "node" },
  { name: "npm", key: "NODE_BIN", exe: "npm" },
  { name: "npx", key: "NODE_BIN", exe: "npx" },
  { name: "corepack", key: "NODE_BIN", exe: "corepack" },
  { name: "pnpm", key: "NODE_BIN", exe: "pnpm" },
  { name: "yarn", key: "NODE_BIN", exe: "yarn" },
  { name: "composer", key: "COMPOSER_BIN", exe: "composer.phar", viaPhp: true },
];

/** The file a project drops to declare its runtimes. */
export const RUNTIME_FILE = ".tedi-runtime";

/**
 * Generate every shim into `<root>/shims/`.
 *
 * Rewritten wholesale rather than patched: the set is small, generation is
 * cheap, and a stale shim for a tool that no longer exists is worse than a
 * rebuild, because it shadows a real binary further along PATH.
 *
 * @returns {Promise<void>}
 */
export async function writeShims() {
  const dir = paths.shims();
  await mkdirp(dir);

  // Drop shims from a previous version of this extension that are no longer in
  // the table, for exactly the shadowing reason above.
  const wanted = new Set(SHIMS.map((s) => (isWindows() ? `${s.name}.cmd` : s.name)));
  for (const entry of await readDir(dir, true)) {
    if (!wanted.has(entry.name)) await remove(join(dir, entry.name)).catch(() => {});
  }

  for (const shim of SHIMS) {
    if (isWindows()) {
      await writeText(join(dir, `${shim.name}.cmd`), windowsShim(shim));
    } else {
      await writeText(join(dir, shim.name), posixShim(shim));
    }
  }

  // ONE chmod over the directory, not one per shim. This runs on every
  // activation, and nine sequential subprocesses - each a spawn plus a poll
  // loop across the IPC boundary - is a real share of the launch cost on macOS
  // and Linux for something a single recursive call does.
  if (!isWindows()) {
    await run("chmod", ["-R", "0755", dir], { timeoutMs: 15_000 }).catch(() => {});
  }
}

/**
 * A Windows shim.
 *
 * `EnableDelayedExpansion` is what lets the loop reassign `DIR` and read it
 * back in the same block; without it the walk reads the value the block started
 * with and loops forever. The parent test compares the fully-qualified parent
 * against the current directory, which is how the walk stops at a drive root
 * (`C:\..` resolves to `C:\`) without hardcoding what a root looks like.
 *
 * Exported so `selfcheck.test.mjs` can run the real generated script rather
 * than a copy of it: a batch walk is the kind of code that reads correct and
 * behaves otherwise.
 *
 * @param {Shim} shim @returns {string}
 */
export function windowsShim(shim) {
  const lines = [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    `set "KEY=${shim.key}"`,
    `set "EXE=${shim.exe}${shim.viaPhp ? "" : ".exe"}"`,
    'set "BIN="',
    'set "PHPBIN="',
    'set "DIR=%CD%"',
    "",
    ":walk",
    `if exist "!DIR!\\${RUNTIME_FILE}" (`,
    `  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("!DIR!\\${RUNTIME_FILE}") do (`,
    '    if /i "%%A"=="!KEY!" set "BIN=%%B"',
    '    if /i "%%A"=="PHP_BIN" set "PHPBIN=%%B"',
    "  )",
    ")",
    "if defined BIN goto resolved",
    'for %%I in ("!DIR!\\..") do set "UP=%%~fI"',
    'if /i "!UP!"=="!DIR!" goto fallback',
    'set "DIR=!UP!"',
    "goto walk",
    "",
    ":fallback",
    `if exist "%~dp0..\\global.env" (`,
    `  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0..\\global.env") do (`,
    '    if /i "%%A"=="!KEY!" if not defined BIN set "BIN=%%B"',
    '    if /i "%%A"=="PHP_BIN" if not defined PHPBIN set "PHPBIN=%%B"',
    "  )",
    ")",
    "",
    ":resolved",
    "if not defined BIN (",
    `  echo tedi.devenv: no ${shim.key} is configured. Open the Dev Environment pane to install one.1>&2`,
    "  exit /b 127",
    ")",
  ];

  if (shim.viaPhp) {
    lines.push(
      "if not defined PHPBIN (",
      "  echo tedi.devenv: composer needs a PHP runtime, and none is configured.1>&2",
      "  exit /b 127",
      ")",
      `"!PHPBIN!\\php.exe" "!BIN!\\${shim.exe}" %*`,
    );
  } else {
    lines.push('"!BIN!\\!EXE!" %*');
  }
  lines.push("exit /b !errorlevel!", "");
  return lines.join("\r\n");
}

/**
 * A POSIX shim.
 *
 * `exec` replaces the shell rather than wrapping it, so signals and the exit
 * code pass through untouched: a Ctrl+C during `composer install` reaches
 * composer, not a wrapper that would leave it orphaned.
 *
 * Exported for the same reason as `windowsShim`.
 *
 * @param {Shim} shim @returns {string}
 */
export function posixShim(shim) {
  /**
   * Read one key out of the runtime file into `varName`, first hit wins.
   *
   * Written as an `if` rather than an `&&` chain on purpose: under `set -e` a
   * failing `&&` chain is a trap, and this script must never exit before it has
   * had a chance to report a useful message.
   *
   * @param {string} key
   * @param {string} varName
   * @returns {string}
   */
  const read = (key, varName) =>
    [
      `    val=$(sed -n 's/^${key}=//p' "$dir/${RUNTIME_FILE}" 2>/dev/null | head -n 1)`,
      `    if [ -n "$val" ] && [ -z "$${varName}" ]; then ${varName}=$val; fi`,
    ].join("\n");

  return [
    "#!/bin/sh",
    "# Generated by tedi.devenv. Do not edit; it is rewritten on every change.",
    `KEY_BIN=""`,
    `PHP_BIN_R=""`,
    "dir=$PWD",
    "while :; do",
    `  if [ -f "$dir/${RUNTIME_FILE}" ]; then`,
    read(shim.key, "KEY_BIN"),
    read("PHP_BIN", "PHP_BIN_R"),
    "  fi",
    '  [ -n "$KEY_BIN" ] && break',
    '  [ "$dir" = "/" ] && break',
    '  parent=$(dirname "$dir")',
    '  [ "$parent" = "$dir" ] && break',
    "  dir=$parent",
    "done",
    "",
    'if [ -z "$KEY_BIN" ] || [ -z "$PHP_BIN_R" ]; then',
    '  g="$(dirname "$0")/../global.env"',
    '  if [ -f "$g" ]; then',
    `    [ -z "$KEY_BIN" ] && KEY_BIN=$(sed -n 's/^${shim.key}=//p' "$g" | head -n 1)`,
    `    [ -z "$PHP_BIN_R" ] && PHP_BIN_R=$(sed -n 's/^PHP_BIN=//p' "$g" | head -n 1)`,
    "  fi",
    "fi",
    "",
    'if [ -z "$KEY_BIN" ]; then',
    `  echo "tedi.devenv: no ${shim.key} is configured. Open the Dev Environment pane to install one." >&2`,
    "  exit 127",
    "fi",
    ...(shim.viaPhp
      ? [
          'if [ -z "$PHP_BIN_R" ]; then',
          '  echo "tedi.devenv: composer needs a PHP runtime, and none is configured." >&2',
          "  exit 127",
          "fi",
          `exec "$PHP_BIN_R/php" "$KEY_BIN/${shim.exe}" "$@"`,
        ]
      : [`exec "$KEY_BIN/${shim.exe}" "$@"`]),
    "",
  ].join("\n");
}

/**
 * Render a `.tedi-runtime` / `global.env` body.
 *
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function renderEnvFile(vars) {
  const lines = ["# Generated by tedi.devenv. Edit the project in TEDI instead."];
  for (const [key, value] of Object.entries(vars)) {
    if (value) lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/** The shim directory, which is what goes on TEDI's Additional PATH.
 *  @returns {string} */
export function shimDir() {
  return paths.shims();
}
