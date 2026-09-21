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
import { dirname, basename } from "./paths.js";

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

/**
 * Build one archive OUT of a directory.
 *
 * The mirror of `plan`, with one trap that reading has and writing does not:
 * GNU tar cannot WRITE a zip and does not say so. `tar -a -cf out.zip dir`
 * exits 0 on GNU tar and leaves a TAR file with a `.zip` name, which every unzip
 * tool then refuses - a corrupt backup that reported success. So no attempt
 * here is allowed to reach a bare `tar` on a platform where PATH may hand back
 * GNU tar, which is Windows (Git Bash, MSYS) and Linux (always).
 *
 * The directory's own NAME becomes the single top-level entry, so extracting
 * gives back a folder rather than spraying a project over the download
 * directory. Every attempt therefore runs with the PARENT as cwd and names the
 * folder relatively, which also keeps a drive letter out of the arguments.
 *
 * @param {string} name       Folder to pack, relative to its parent.
 * @param {string} out        Absolute path of the `.zip` to write.
 * @param {string[]} [exclude] Names dropped anywhere in the tree, e.g. `node_modules`.
 * @returns {[string, string[]][]}
 */
export function packPlan(name, out, exclude = []) {
  // libarchive matches a pattern with no slash against any path COMPONENT, so
  // a bare `node_modules` drops the folder wherever it sits. `zip` matches the
  // whole path, so it gets a glob.
  const bsdtar = [...exclude.map((e) => `--exclude=${e}`), "-a", "-c", "-f", out, name];
  const zip = ["-r", "-q", out, name, ...exclude.flatMap((e) => ["-x", `${name}/${e}/*`])];

  if (isWindows()) {
    return [
      [systemTar(), bsdtar],
      // Compress-Archive is the guaranteed floor rather than a good option: it
      // is slow, it refuses files over 2 GB, and it has no exclusion syntax at
      // all, so a fallback backup is the WHOLE folder. Reached only on a
      // Windows without System32\tar.exe, which is pre-1803.
      [
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -LiteralPath '${name.replace(/'/g, "''")}' ` +
            `-DestinationPath '${out.replace(/'/g, "''")}' -Force`,
        ],
      ],
    ];
  }
  // macOS ships bsdtar as the only tar, so `-a` picks the zip format from the
  // suffix there exactly as it does on Windows.
  if (isMac()) return [["tar", bsdtar]];
  return [
    ["zip", zip],
    // Some distributions ship libarchive's tar under its own name. If neither
    // is there the backup fails loudly, which is the only honest answer: a
    // silent tar-in-a-zip is the bug this chain exists to avoid.
    ["bsdtar", bsdtar],
  ];
}

/**
 * Which directory to run the archiver IN, and what to call the thing it packs.
 *
 * Split through `paths.js` rather than with a regex here. A hand-written
 * separator class that says `/` where it means `\` or `/` is invisible on a
 * Mac and silently wrong on Windows: `dirname` then returns the whole path
 * unchanged, `mkdirp` creates the ARCHIVE as a directory, and the archiver
 * writes nothing while reporting success. That shipped once.
 *
 * Exported for the self-check, which is where Windows paths get exercised on a
 * machine that may not have one.
 *
 * @param {string} dir Absolute directory to pack.
 * @returns {{ parent: string, name: string }}
 */
export function packTarget(dir) {
  return { parent: dirname(dir), name: basename(dir) };
}

/**
 * Pack `dir` into the zip at `out`, creating its parent directory.
 *
 * @param {string} dir Absolute directory to pack.
 * @param {string} out Absolute `.zip` path to write.
 * @param {{ exclude?: string[], timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function pack(dir, out, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const { parent, name } = packTarget(dir);
  await mkdirp(dirname(out));

  /** @type {Error | null} */
  let lastErr = null;
  for (const [program, args] of packPlan(name, out, opts.exclude)) {
    try {
      const res = await run(program, args, { timeoutMs, cwd: parent });
      if (res.code === 0) return;
      const tail = res.out.trim().split(/\r?\n/).slice(-3).join(" ");
      lastErr = new Error(`${program} exited ${res.code}${tail ? `: ${tail}` : ""}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(`Could not write ${out}. (${lastErr?.message ?? "no archiver"})`);
}
