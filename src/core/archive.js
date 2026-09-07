// Unpacking archives with whatever the platform actually ships.
//
// `tar` reads zip on Windows and macOS because both ship bsdtar, and modern tar
// auto-detects gzip/xz/bzip2 from the file itself, so `tar -xf` covers almost
// everything with one command. GNU tar on Linux does NOT read zip, which is the
// single reason this file has a fallback chain at all: `unzip` leads there, then
// bsdtar if the distribution has it, then Python, because a minimal container
// may have none of the first three.
//
// Nothing here strips a leading directory. Archives in this domain wrap their
// contents in a versioned folder whose name changes between releases
// (`php-8.3.14-Win32-vs16-x64`, `node-v22.11.0-linux-x64`), so the installer
// detects that wrapper after extracting instead of hardcoding a strip depth per
// project and breaking on the next naming change.

import { isWindows, isMac } from "../runtime.js";
import { run } from "./proc.js";
import { mkdirp } from "./fsx.js";

/**
 * Windows' own bsdtar, by absolute path.
 *
 * Named explicitly because the whole point is to bypass PATH: any `tar` found
 * there may be GNU tar, which cannot open a zip.
 *
 * The Windows directory is assumed rather than read from `%SystemRoot%`,
 * because the extension host passes argv and no environment and there is no
 * command to ask for one. A non-default Windows location therefore misses here
 * and falls through to the next attempt, which is exactly what the chain is
 * for - this is an optimisation over PATH order, not a requirement.
 *
 * @returns {string}
 */
function systemTar() {
  return "C:\\Windows\\System32\\tar.exe";
}

/** @param {string} file @returns {boolean} */
function isZip(file) {
  return /\.zip$/i.test(file);
}

/** @param {string} file @returns {boolean} */
function isTarball(file) {
  return /\.(tar(\.(gz|xz|bz2|zst))?|tgz|txz|tbz2?)$/i.test(file);
}

/**
 * Extract `archive` into `destDir`, which is created if absent.
 *
 * @param {string} archive Absolute path to the downloaded file.
 * @param {string} destDir Absolute directory to unpack into.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function extract(archive, destDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  await mkdirp(destDir);

  // GNU tar reads an `-f` argument containing a colon before the first slash as
  // a REMOTE spec (`host:path`), so `tar -xf C:\...\node.zip` fails with
  // "Cannot connect to C: resolve failed". Windows ships bsdtar as `tar.exe`
  // and copes, but a machine with Git Bash or MSYS earlier on PATH gets GNU tar
  // and every extraction breaks - which is a wrong-tar-on-PATH bug that looks
  // like a corrupt download.
  //
  // Running FROM the archive's directory and naming it by basename removes the
  // colon from the argument entirely, and works identically on both tars. The
  // `-C` destination is unaffected: only the archive name is parsed for a host.
  const dir = archive.replace(/[\\/][^\\/]*$/, "");
  const file = archive.slice(dir.length + 1) || archive;

  const attempts = plan(file, destDir);
  if (attempts.length === 0) {
    throw new Error(`Do not know how to unpack ${archive}`);
  }

  /** @type {Error | null} */
  let lastErr = null;
  for (const [program, args] of attempts) {
    try {
      const res = await run(program, args, { timeoutMs, cwd: dir });
      if (res.code === 0) return;
      const tail = res.out.trim().split(/\r?\n/).slice(-3).join(" ");
      lastErr = new Error(`${program} exited ${res.code}${tail ? `: ${tail}` : ""}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(
    `Could not unpack ${archive}. Install unzip or tar and try again. (${lastErr?.message ?? "no archiver"})`,
  );
}

/**
 * The ordered list of extraction attempts for this archive on this platform.
 *
 * Exported so the dashboard's diagnostics can show what WOULD be tried without
 * unpacking anything; pass no destination for that display form.
 *
 * @param {string} archive
 * @param {string} [destDir]
 * @returns {[string, string[]][]}
 */
export function plan(archive, destDir = "<dest>") {
  const dest = destDir;
  if (isZip(archive)) {
    if (isWindows()) {
      // "Windows ships bsdtar as tar.exe" is true of the SYSTEM one and false of
      // whatever is first on PATH: Git Bash, MSYS and Cygwin all put GNU tar
      // there, and GNU tar cannot read a zip at all ("This does not look like a
      // tar archive"). Since a developer machine very often has one of those,
      // the system binary is named outright rather than hoped for, with the
      // bare name and PowerShell behind it.
      return [
        [systemTar(), ["-xf", archive, "-C", dest]],
        ["tar", ["-xf", archive, "-C", dest]],
        [
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
          ],
        ],
      ];
    }
    if (isMac()) {
      // macOS ships bsdtar as the only tar, and unzip as well.
      return [
        ["tar", ["-xf", archive, "-C", dest]],
        ["unzip", ["-q", "-o", archive, "-d", dest]],
      ];
    }
    return [
      ["unzip", ["-q", "-o", archive, "-d", dest]],
      ["tar", ["-xf", archive, "-C", dest]],
      ["python3", ["-m", "zipfile", "-e", archive, dest]],
    ];
  }
  if (isTarball(archive)) {
    // -xf auto-detects gzip, xz, bzip2 and zstd on both GNU tar and bsdtar.
    return [["tar", ["-xf", archive, "-C", dest]]];
  }
  return [];
}

/** Which archive shapes this module can handle at all. The installer asks
 *  before downloading, so an unsupported format is reported at the point the
 *  user picks a version rather than after a 300 MB transfer.
 *  @param {string} archive @returns {boolean} */
export function canExtract(archive) {
  return isZip(archive) || isTarball(archive);
}
