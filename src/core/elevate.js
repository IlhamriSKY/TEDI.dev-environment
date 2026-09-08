// Running a batch of commands with administrator rights.
//
// Two things need it: writing the system hosts file, and binding ports 80/443
// on macOS and Linux. Both are rare and both are batchable, so the contract
// here is deliberately coarse: the caller hands over a whole SCRIPT, and the
// user sees exactly one prompt no matter how many projects changed. A prompt
// per project is how a tool teaches people to click through prompts without
// reading them.
//
// The script is written to our own data directory rather than the system temp
// dir. A world-writable temp directory plus a script about to run as root is a
// local privilege-escalation shape, and on a shared machine another user could
// win the race between our write and the elevated read.

import { isWindows, isMac } from "../runtime.js";
import { run, which } from "./proc.js";
import { paths } from "./paths.js";
import { writeText, remove, mkdirp } from "./fsx.js";
import { join } from "./paths.js";

/**
 * @typedef {object} ElevateResult
 * @property {boolean} ok
 * @property {"uac" | "osascript" | "pkexec" | "none"} method
 * @property {string} [message]   Why it failed, or what the user must run.
 */

/** Where the one-shot elevated script is staged. */
function scriptPath() {
  const name = isWindows() ? "elevate.ps1" : "elevate.sh";
  return join(paths.run(), name);
}

/**
 * Run `lines` as one elevated batch.
 *
 * @param {string[]} lines  Commands, in the platform's own shell dialect.
 * @param {{ description?: string }} [opts]
 * @returns {Promise<ElevateResult>}
 */
export async function elevate(lines, opts = {}) {
  if (lines.length === 0) return { ok: true, method: "none" };
  await mkdirp(paths.run());
  const file = scriptPath();

  const result = isWindows()
    ? await elevateWindows(file, lines)
    : isMac()
      ? await elevateMac(file, lines, opts.description)
      : await elevateLinux(file, lines);

  // Removed on SUCCESS only. The script can contain the full list of domains
  // being written - not secret, but there is no reason to leave it lying around
  // once it has run.
  //
  // On failure it has to survive, because the message may be the only way
  // forward: the Linux path with no Polkit agent hands the user
  // `sudo sh <file>` and a `finally` deleted that file before they could read
  // the sentence naming it. The next `elevate()` writes the same path, so
  // nothing accumulates.
  if (result.ok) await remove(file).catch(() => {});
  return result;
}

/**
 * Windows: UAC through `Start-Process -Verb RunAs`.
 *
 * `-Wait` is what makes this synchronous; without it the call returns before
 * the hosts file has changed and the caller reports success too early. A user
 * who declines the prompt makes Start-Process throw, which surfaces as a
 * non-zero exit here rather than a silent no-op.
 *
 * @param {string} file @param {string[]} lines
 * @returns {Promise<ElevateResult>}
 */
async function elevateWindows(file, lines) {
  // `$ErrorActionPreference` so a failing line aborts the batch instead of
  // continuing and reporting success.
  const script = ["$ErrorActionPreference = 'Stop'", ...lines].join("\r\n") + "\r\n";
  await writeText(file, script);

  const inner = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `"${file}"`].join("','");

  const res = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '${inner}'; exit $p.ExitCode`,
    ],
    { timeoutMs: 5 * 60_000 },
  );

  if (res.code === 0) return { ok: true, method: "uac" };
  return {
    ok: false,
    method: "uac",
    message:
      res.out.includes("canceled") || res.out.includes("cancelled")
        ? "The administrator prompt was dismissed."
        : `The elevated step failed (exit ${res.code}).`,
  };
}

/**
 * macOS: one authorization dialog via osascript.
 *
 * The script path is embedded in an AppleScript string, so a path containing a
 * double quote or a backslash would break out of it. Our own data root is the
 * only path that ever reaches here, but escaping it costs one line and removes
 * the question entirely.
 *
 * @param {string} file @param {string[]} lines @param {string} [description]
 * @returns {Promise<ElevateResult>}
 */
async function elevateMac(file, lines, description) {
  const script = ["#!/bin/sh", "set -e", ...lines].join("\n") + "\n";
  await writeText(file, script);

  const escaped = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const prompt = (description ?? "TEDI Dev Environment needs to update your hosts file")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  const res = await run(
    "osascript",
    [
      "-e",
      `do shell script "/bin/sh \\"${escaped}\\"" with prompt "${prompt}" with administrator privileges`,
    ],
    { timeoutMs: 5 * 60_000 },
  );

  if (res.code === 0) return { ok: true, method: "osascript" };
  return {
    ok: false,
    method: "osascript",
    message: /User cancelled|-128/.test(res.out)
      ? "The administrator prompt was dismissed."
      : `The elevated step failed: ${res.out.trim().split(/\r?\n/).slice(-2).join(" ")}`,
  };
}

/**
 * Linux: `pkexec` when a Polkit agent is running, and otherwise nothing.
 *
 * There is deliberately no `sudo` fallback. `sudo` needs a TTY to read a
 * password and this process has none, so it would either hang or fail with a
 * confusing message; `sudo -n` only works for a user who already has NOPASSWD,
 * which is a minority and not one worth branching for. When pkexec is absent
 * the honest move is to hand the user the exact command, which the caller shows
 * in the dashboard.
 *
 * @param {string} file @param {string[]} lines
 * @returns {Promise<ElevateResult>}
 */
async function elevateLinux(file, lines) {
  const script = ["#!/bin/sh", "set -e", ...lines].join("\n") + "\n";
  await writeText(file, script);
  await run("chmod", ["0700", file], { timeoutMs: 10_000 }).catch(() => {});

  if (!(await which("pkexec"))) {
    return {
      ok: false,
      method: "none",
      message: `No graphical elevation agent (pkexec) is available. Run this yourself:\n  sudo sh ${file}`,
    };
  }

  const res = await run("pkexec", ["/bin/sh", file], { timeoutMs: 5 * 60_000 });
  if (res.code === 0) return { ok: true, method: "pkexec" };
  // pkexec exits 126 when the user dismisses the dialog, 127 when the agent is
  // missing. Both are "did not run", not "ran and failed".
  if (res.code === 126) {
    return { ok: false, method: "pkexec", message: "The authentication dialog was dismissed." };
  }
  return {
    ok: false,
    method: "pkexec",
    message: `The elevated step failed (exit ${res.code}). Run it yourself:\n  sudo sh ${file}`,
  };
}
