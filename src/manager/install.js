// The install lifecycle: download, unpack, unwrap, place, verify.
//
// Every install stages into a sibling directory and is renamed into place only
// once it has been verified. That is not ceremony: a half-extracted PHP left at
// the real path looks installed to `versions.js`, gets selected as a project's
// runtime, and fails at the point a user runs `composer install` rather than at
// the point the download broke. Staging means a failed install leaves the
// previous one untouched and the tree never contains a partial version.

import { paths, join } from "../core/paths.js";
import { download as fetchFile } from "../core/net.js";
import { extract, canExtract } from "../core/archive.js";
import { mkdirp, move, remove, exists, singleRoot, subdirs, readDir, isDir } from "../core/fsx.js";
import { run } from "../core/proc.js";
import { isWindows, state, warn } from "../runtime.js";
import { isSafeVersion } from "../registry/util.js";

/** @typedef {import("../registry/index.js").Provider} Provider */

/**
 * Where a component's version lives on disk.
 *
 * Derived from `kind` rather than declared per provider, so adding a provider
 * cannot put PostgreSQL under `runtimes/`. mkcert is the single exception and
 * says so itself by being a non-versioned tool.
 *
 * @param {Provider} p @param {string} version @returns {string}
 */
export function installRoot(p, version) {
  if (p.kind === "tool" && !p.multiVersion) return paths.tools();
  if (p.kind === "server") return paths.server(p.id, version);
  if (p.kind === "service") return paths.service(p.id, version);
  return paths.runtime(p.id, version);
}

/**
 * Is this download an archive we unpack, or a single file we just place?
 * Composer ships a `.phar` and mkcert a bare executable; both would fail an
 * extraction that assumed every download is a container.
 *
 * @param {string} file @returns {boolean}
 */
function isArchive(file) {
  return canExtract(file);
}

/**
 * Install one version of one component.
 *
 * @param {Provider} p
 * @param {string} version
 * @param {(msg: string, pct?: number) => void} [onProgress]
 * @returns {Promise<string>} the install root
 */
export async function install(p, version, onProgress) {
  /** @param {string} m @param {number} [pct] */
  const say = (m, pct) => {
    state.busy.set(p.id, { text: m, ...(pct === undefined ? {} : { pct }) });
    onProgress?.(m, pct);
  };

  // Checked here because this is the one path every install goes through, and
  // the version is about to become both a directory name and part of a URL.
  if (!isSafeVersion(version)) {
    throw new Error(`Refusing to install "${version}": that is not a valid version string.`);
  }

  say("Resolving download");
  const dl = await p.download(version);
  if (!dl) {
    throw new Error(
      p.packageHint
        ? `${p.label} ${version} has no prebuilt download for this platform. Install it with your package manager and it will be detected:\n  ${p.packageHint}`
        : `${p.label} ${version} has no prebuilt download for this platform.`,
    );
  }

  const target = installRoot(p, version);
  const staging = `${target}.staging-${Date.now()}`;
  const archivePath = join(paths.downloads(), dl.file);

  try {
    await mkdirp(paths.downloads());
    say(`Downloading ${dl.file}`, 0);
    await fetchFile(dl.url, archivePath, {
      onProgress: (pct) => say(`Downloading ${dl.file}`, pct),
    });

    // A bare binary or a .phar has an exact destination - the `exe` its own
    // layout names - and must NOT go through the staging-directory path.
    //
    // Two things went wrong when it did. The file kept its download name
    // (`mkcert-v1.4.4-windows-amd64.exe`), so nothing that looked for
    // `tools/mkcert.exe` ever found it: the install "succeeded", `verify` only
    // warned, and HTTPS stayed broken. And `installRoot` for a single-version
    // tool is the SHARED `tools/` directory, so `move(staging, target)` -
    // delete-then-rename - deleted that directory and every other tool in it.
    if (!isArchive(dl.file)) {
      const { exe } = await p.layout(version);
      say("Installing");
      await mkdirp(exe.replace(/[\\/][^\\/]*$/, ""));
      await move(archivePath, exe);
      await makeExecutable(p, version, target);
      say("Verifying");
      if (!(await verify(p, version))) {
        warn(`${p.id} ${version} installed but its executable did not answer`);
      }
      return exe;
    }

    await mkdirp(staging);
    say("Unpacking");
    await extract(archivePath, staging);
    await unwrap(staging, await relativeExe(p, version, target));

    // Further archives that belong in the same tree (PHP's FPM build).
    if (p.extras) {
      const extras = await p.extras(version);
      for (const extra of extras) {
        const extraPath = join(paths.downloads(), extra.file);
        say(`Downloading ${extra.file}`, 0);
        await fetchFile(extra.url, extraPath, {
          onProgress: (pct) => say(`Downloading ${extra.file}`, pct),
        });
        if (isArchive(extra.file)) {
          const sub = `${staging}-extra`;
          await mkdirp(sub);
          await extract(extraPath, sub);
          await unwrap(sub);
          await mergeInto(sub, staging);
          await remove(sub);
        } else {
          await move(extraPath, join(staging, extra.file));
        }
        await remove(extraPath);
      }
    }

    say("Installing");
    await move(staging, target);
    await makeExecutable(p, version, target);

    say("Verifying");
    const ok = await verify(p, version);
    if (!ok) {
      warn(`${p.id} ${version} installed but its executable did not answer`);
    }
    return target;
  } catch (err) {
    await remove(staging).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await remove(archivePath).catch(() => {});
    state.busy.delete(p.id);
  }
}

/**
 * Where the provider's executable sits inside its own install root.
 *
 * This is what makes unwrapping CHECKABLE rather than a guess: the provider
 * already states where the binary ends up, so the installer can look for it
 * instead of inferring a strip depth from the archive's shape.
 *
 * @param {Provider} p @param {string} version @param {string} target
 * @returns {Promise<string>} relative path, or "" when it cannot be derived
 */
async function relativeExe(p, version, target) {
  const { exe } = await p.layout(version);
  if (!exe.startsWith(target)) return "";
  return exe.slice(target.length).replace(/^[\\/]+/, "");
}

/**
 * Collapse a wrapping directory, in place.
 *
 * Nearly every archive here wraps its contents in one versioned folder whose
 * name changes between releases, so the wrapper is DETECTED rather than
 * declared. Doing it here means `layout()` can describe the useful shape
 * instead of every provider carrying a strip-depth that is wrong the next time
 * upstream renames something.
 *
 * The wrapper is now identified by WHERE THE EXECUTABLE IS, not by being the
 * only child. The old rule - one subdirectory and no files - is what a zip that
 * carries a readme beside its payload defeats, and the Apache Lounge archive
 * does exactly that: `Apache24/`, `ReadMe.txt`, `Security.txt` and a build-tag
 * file at the top level. Nothing was lifted, so the install landed at
 * `<root>/Apache24/bin/httpd.exe` while `layout()` named `<root>/bin/httpd.exe`,
 * and Apache silently never appeared as installed.
 *
 * Checking for the executable also makes this incapable of damaging an archive
 * that is ALREADY the right shape, which the old rule could: an archive holding
 * `bin/` next to a readme would have had `bin/` lifted to the root.
 *
 * @param {string} dir
 * @param {string} relExe  Where `layout()` says the binary sits, relative to
 *                         the install root. Empty when the caller has none, in
 *                         which case the single-wrapper heuristic still applies.
 * @returns {Promise<void>}
 */
async function unwrap(dir, relExe = "") {
  if (relExe) {
    // Already the shape `layout()` describes.
    if (await exists(join(dir, relExe))) return;
    for (const name of await subdirs(dir)) {
      if (await exists(join(dir, name, relExe))) return await lift(dir, name);
    }
  }
  // No executable to aim at - an extras archive, or a provider whose binary
  // arrives in a later download. Fall back to the shape rule.
  const only = await singleRoot(dir);
  if (only) await lift(dir, only);
}

/**
 * Replace `dir` with its child `name`, keeping the path.
 *
 * Rename the inner directory OUT, drop the wrapper and whatever else was beside
 * it, rename back. Moving children one by one would be slower and would
 * half-finish on error.
 *
 * @param {string} dir @param {string} name @returns {Promise<void>}
 */
async function lift(dir, name) {
  const lifted = `${dir}-lift-${Date.now()}`;
  await move(join(dir, name), lifted);
  await remove(dir);
  await move(lifted, dir);
}

/**
 * Copy every child of `from` into `to`, without replacing `to` itself.
 * Used to merge PHP's separate FPM archive into the CLI install.
 *
 * @param {string} from @param {string} to
 * @returns {Promise<void>}
 */
async function mergeInto(from, to) {
  for (const entry of await readDir(from, true)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.kind === "dir" && (await isDir(dst))) {
      await mergeInto(src, dst);
      continue;
    }
    await move(src, dst);
  }
}

/**
 * Mark the installed binaries executable.
 *
 * Zip archives do not carry POSIX mode bits reliably, and a tarball extracted
 * by a umask-restrictive shell can still land without +x. Windows needs
 * nothing. This is the same class of problem the host solves for extension
 * sidecars at install time.
 *
 * @param {Provider} p @param {string} version @param {string} target
 * @returns {Promise<void>}
 */
async function makeExecutable(p, version, target) {
  if (isWindows()) return;
  const { binDir } = await p.layout(version);
  const dirs = [binDir, join(target, "bin"), join(target, "sbin")];
  for (const dir of dirs) {
    if (!(await isDir(dir))) continue;
    await run("chmod", ["-R", "0755", dir], { timeoutMs: 60_000 }).catch(() => {});
  }
  // Single-binary tools sit at the root of their directory.
  if (p.kind === "tool") {
    const { exe } = await p.layout(version);
    await run("chmod", ["0755", exe], { timeoutMs: 20_000 }).catch(() => {});
  }
}

/**
 * Does the installed executable exist and answer?
 *
 * Existence alone is not enough: a truncated download extracts to a file of the
 * right name that cannot run. Running it is the only check that distinguishes
 * those, and a failure here is reported as a warning rather than an error
 * because some of these binaries (mysqld, postgres) legitimately refuse to
 * print a version without configuration.
 *
 * @param {Provider} p @param {string} version
 * @returns {Promise<boolean>}
 */
export async function verify(p, version) {
  const { exe } = await p.layout(version);
  if (!(await exists(exe))) return false;
  // A `.phar` is not an executable: it is a PHP archive that only runs when
  // handed to an interpreter. Trying to exec it fails on every platform, and
  // reporting that as "installed but did not answer" is a false alarm about a
  // perfectly good Composer.
  if (/\.phar$/i.test(exe)) return true;
  const res = await run(exe, p.versionArgs ?? ["--version"], { timeoutMs: 15_000 }).catch(
    () => null,
  );
  return Boolean(res && res.code === 0);
}

/**
 * Remove an installed version. Refuses nothing: the caller decides whether a
 * version is in use, because only it knows about the project pins.
 *
 * @param {Provider} p @param {string} version
 * @returns {Promise<void>}
 */
export async function uninstall(p, version) {
  const target = installRoot(p, version);
  if (p.kind === "tool" && !p.multiVersion) {
    // Non-versioned tools share `tools/`, so removing the directory would take
    // the others with it. Remove just the executable.
    const { exe } = await p.layout(version);
    await remove(exe);
    return;
  }
  await remove(target);
}

/** Delete anything left in `downloads/` from an interrupted install.
 *  @returns {Promise<void>} */
export async function sweepDownloads() {
  for (const entry of await readDir(paths.downloads(), true)) {
    await remove(join(paths.downloads(), entry.name)).catch(() => {});
  }
}
