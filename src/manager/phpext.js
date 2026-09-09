// PHP extensions.
//
// On Windows this is a real manager: php.net publishes a PECL build matrix
// where every DLL is named for the exact PHP branch, thread-safety, compiler
// and architecture it was built against. Loading a DLL built for the wrong one
// does not fail gracefully - it crashes the process - so compatibility is not a
// warning here, it is the filter. An extension is only ever OFFERED if a
// matching build exists for the PHP that would load it.
//
// The matching reads the directory listing rather than constructing a filename,
// because the compiler tag (vs16, vs17, vc15) is a property of the build and is
// not derivable from any version number we hold. So we ask which files exist
// and pick the one whose branch, thread-safety and architecture line up.
//
// On macOS and Linux there is no equivalent: a downloaded static PHP has its
// extensions compiled in and cannot load more, and a system PHP needs `pecl`
// plus a compiler. Both are reported plainly instead of half-supported.

import { fetchText, download } from "../core/net.js";
import { extract } from "../core/archive.js";
import { paths, join } from "../core/paths.js";
import { readDir, readText, writeText, mkdirp, remove, exists, move } from "../core/fsx.js";
import { run } from "../core/proc.js";
import { isWindows, exeSuffix } from "../runtime.js";
import { resolveVersion } from "./versions.js";
import { majorMinor } from "../registry/util.js";
import { phpExtDir, supportsRuntimeExtensions } from "../registry/php.js";
import { ensureIni, iniPathFor } from "./phpini.js";

const PECL = "https://windows.php.net/downloads/pecl/releases";

/** php.net publishes no ARM64 Windows PHP, so every DLL we can use is x64. */
const WIN_ARCH = "x64";

/**
 * @typedef {object} ExtensionInfo
 * @property {string} name
 * @property {boolean} enabled     Declared in php.ini and not commented out.
 * @property {boolean} present     A DLL exists in the extension directory.
 * @property {boolean} builtin     Compiled in; can be neither added nor removed.
 */

/**
 * Can extensions be managed for this PHP at all?
 * @param {string} version
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function manageable(version) {
  const row = resolveVersion("php", version);
  if (!row) return { ok: false, reason: "That PHP version is not installed." };
  if (row.origin === "system") {
    return {
      ok: false,
      reason:
        "This is the PHP your package manager installed. Add extensions with `pecl install` or the package manager, and TEDI will see them.",
    };
  }
  // Asked of the provider rather than re-derived from the platform: whether a
  // build can load an extension at run time is a property of how it was
  // compiled, and the provider is what knows that.
  if (!supportsRuntimeExtensions()) {
    return {
      ok: false,
      reason:
        "Downloaded PHP on macOS and Linux is a static build: its extensions are compiled in and cannot be added at runtime. php.ini settings still apply.",
    };
  }
  return { ok: true };
}

/**
 * Every extension name PECL publishes a Windows build for.
 * Cached for a day: the list changes when someone publishes a new extension,
 * which nobody is waiting on.
 *
 * @returns {Promise<string[]>}
 */
export async function availableExtensions() {
  if (!isWindows()) return [];
  const html = await fetchText(`${PECL}/`, { timeoutMs: 40_000 });
  const names = new Set(
    [...html.matchAll(/<a href="([a-z0-9_-]+)\/"/gi)].map((m) => m[1].toLowerCase()),
  );
  names.delete("..");
  return [...names].sort();
}

/**
 * Builds of one extension that fit the given PHP.
 *
 * @param {string} name @param {string} phpVersion
 * @returns {Promise<{ version: string, file: string, url: string }[]>}
 */
async function buildsFor(name, phpVersion) {
  if (!isWindows()) return [];
  const branch = majorMinor(phpVersion);

  const index = await fetchText(`${PECL}/${name}/`, { timeoutMs: 30_000 });
  const versions = [...index.matchAll(/<a href="([0-9][^"/]*)\/"/g)].map((m) => m[1]);

  /** @type {{ version: string, file: string, url: string }[]} */
  const out = [];
  // Newest first, and stop after a handful: each candidate is a page fetch, and
  // a user picking an extension wants the current build, not all forty.
  for (const version of versions.sort((a, b) => (a < b ? 1 : -1)).slice(0, 10)) {
    const page = await fetchText(`${PECL}/${name}/${version}/`, { timeoutMs: 30_000 }).catch(
      () => "",
    );
    const files = new Set([...page.matchAll(/php_[A-Za-z0-9_-]+-[^"<]*?\.zip/g)].map((m) => m[0]));
    // NTS, because that is the build this extension installs and the one the
    // FastCGI worker loads. A thread-safe DLL in an NTS PHP crashes on load.
    const hit = [...files].find(
      (f) => f.includes(`-${branch}-nts-`) && f.endsWith(`-${WIN_ARCH}.zip`),
    );
    if (hit) out.push({ version, file: hit, url: `${PECL}/${name}/${version}/${hit}` });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Download an extension into the PHP install's `ext/` directory and enable it.
 *
 * @param {string} name @param {string} phpVersion @param {string} [extVersion]
 * @returns {Promise<void>}
 */
export async function installExtension(name, phpVersion, extVersion) {
  const check = await manageable(phpVersion);
  if (!check.ok) throw new Error(check.reason ?? "Extensions cannot be managed for this PHP.");

  const builds = await buildsFor(name, phpVersion);
  if (builds.length === 0) {
    throw new Error(
      `No ${name} build exists for PHP ${majorMinor(phpVersion)} (non-thread-safe, ${WIN_ARCH}).`,
    );
  }
  const build = extVersion ? builds.find((b) => b.version === extVersion) : builds[0];
  if (!build) throw new Error(`${name} ${extVersion} has no build for this PHP.`);

  const row = resolveVersion("php", phpVersion);
  if (!row) throw new Error(`PHP ${phpVersion} is not installed.`);

  const archive = join(paths.downloads(), build.file);
  const staging = join(paths.downloads(), `ext-${name}-${Date.now()}`);
  try {
    await download(build.url, archive);
    await mkdirp(staging);
    await extract(archive, staging);

    // The zip holds the DLL plus documentation; only DLLs belong in ext/.
    const extDir = phpExtDir(phpVersion);
    await mkdirp(extDir);
    let copied = 0;
    for (const entry of await readDir(staging, true)) {
      if (entry.kind !== "file" || !/\.dll$/i.test(entry.name)) continue;
      await move(join(staging, entry.name), join(extDir, entry.name));
      copied++;
    }
    if (copied === 0) throw new Error(`The ${name} archive contained no DLL.`);

    await enable(name, phpVersion, true);
  } finally {
    await remove(archive).catch(() => {});
    await remove(staging).catch(() => {});
  }
}

/**
 * Turn an extension on or off in php.ini.
 *
 * Xdebug and OPcache are Zend extensions and must be declared with
 * `zend_extension`; loading either through a plain `extension=` line makes PHP
 * start with the extension silently absent. That distinction is the single most
 * common reason a correctly installed Xdebug appears not to work.
 *
 * @param {string} name @param {string} phpVersion @param {boolean} on
 * @returns {Promise<void>}
 */
export async function enable(name, phpVersion, on) {
  await ensureIni(phpVersion);
  const info = await iniPathFor(phpVersion);
  if (!info) throw new Error(`PHP ${phpVersion} is not installed.`);

  const directive = isZendExtension(name) ? "zend_extension" : "extension";
  let content = (await readText(info.path)) ?? "";
  // Drop every existing declaration of this extension, commented or not, in
  // either form, so toggling can never leave two contradictory lines behind.
  //
  // The name is escaped before it reaches the pattern. It arrives from a remote
  // directory listing, and an unescaped `.` or `+` there would quietly match
  // and delete a NEIGHBOURING extension's line - a corrupted php.ini whose
  // cause would be invisible.
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^[ \\t]*;?[ \\t]*(?:zend_)?extension[ \\t]*=[ \\t]*["']?(?:php_)?${safe}(?:\\.dll)?["']?[ \\t]*$\\n?`,
    "gim",
  );
  content = content.replace(re, "");
  if (on) content = `${content.replace(/\s*$/, "")}\n${directive}=${name}\n`;
  await writeText(info.path, content.replace(/\n{3,}/g, "\n\n"));
}

/** Extensions that must be loaded as Zend extensions.
 *  @param {string} name @returns {boolean} */
function isZendExtension(name) {
  return ["xdebug", "opcache", "ioncube_loader"].includes(name.toLowerCase());
}

/**
 * Extensions compiled into the binary, asked of the binary itself.
 *
 * `php -m` is the only authoritative source for this, and it is what makes a
 * static build legible: on macOS and Linux this is the ENTIRE extension list,
 * and without it the UI would show an empty page for a PHP that in fact has
 * thirty extensions.
 *
 * @param {string} version @returns {Promise<string[]>}
 */
async function builtinExtensions(version) {
  const row = resolveVersion("php", version);
  if (!row) return [];
  const res = await run(join(row.binDir, `php${exeSuffix()}`), ["-m"], { timeoutMs: 15_000 }).catch(
    () => null,
  );
  if (!res || res.code !== 0) return [];
  /** @type {string[]} */
  const names = [];
  for (const raw of res.out.split(/\r?\n/)) {
    const line = raw.trim();
    // Section headers ("[PHP Modules]") and blanks are not extensions.
    if (!line || line.startsWith("[")) continue;
    names.push(line.toLowerCase());
  }
  return names;
}

/**
 * What a fresh php.ini turns on, in the waves they were added in.
 *
 * Wave one is the database drivers. PHP ships these compiled but commented out,
 * so a brand-new environment could not connect to the MySQL and PostgreSQL it
 * had just installed - and the error a project gets for a missing driver
 * ("could not find driver") names nothing you can act on.
 *
 * Wave two is what a PHP application cannot boot without, and it is here
 * because the drivers alone are not a usable PHP. **Composer itself cannot
 * run** without `openssl`: there is no https to packagist, so
 * `composer create-project` fails before it downloads anything. Laravel,
 * Symfony and WordPress all need `mbstring` at run time, and the error names an
 * internal function nobody can act on either - `Call to undefined function
 * Illuminate\Encryption\openssl_cipher_iv_length()`. `curl`, `fileinfo` and
 * `zip` are the next three that any real project asks for. Every one of these
 * DLLs is already inside the php.net zip we unpacked, so this is a line in a
 * file, not a download.
 *
 * It is still not a general opinion about a good php.ini: it is what the
 * environment has to have for the things it installs to work at all.
 *
 * WAVES, not one list, because seeding is a one-off per wave. An environment
 * that predates a wave gets that wave once; a user who then switches something
 * off has decided. Appending to an existing wave would turn their choice back
 * on at the next launch, which is the one thing this must never do.
 */
export const DEFAULT_WAVES = [
  ["mysqli", "pdo_mysql", "pgsql", "pdo_pgsql"],
  ["openssl", "mbstring", "curl", "fileinfo", "zip"],
];

/** An environment seeded through this many waves needs nothing doing to it. */
export const SEED_GENERATION = DEFAULT_WAVES.length;

/**
 * The extensions an environment at this generation has not been offered yet.
 *
 * @param {number} generation @returns {string[]}
 */
export function pendingDefaults(generation) {
  return DEFAULT_WAVES.slice(generation).flat();
}

/**
 * Turn those on, for the ones this build actually ships.
 *
 * Called with the full list when a php.ini is first created, and with just the
 * unseeded waves for an environment that predates them. Never with a wave twice:
 * a user who switches one off has decided, and an environment that re-enabled it
 * on the next launch would be arguing with them.
 *
 * @param {string} version
 * @param {string[]} [names] Defaults to every wave.
 * @returns {Promise<string[]>} What was enabled.
 */
export async function enableDefaults(version, names = DEFAULT_WAVES.flat()) {
  const rows = await listExtensions(version);
  /** @type {string[]} */
  const turnedOn = [];
  for (const name of names) {
    const row = rows.find((r) => r.name.toLowerCase() === name);
    // Absent on a static build, and already on for a build that compiles them
    // in - both are "nothing to do" rather than something to report.
    if (!row || row.builtin || row.enabled || !row.present) continue;
    await enable(row.name, version, true).catch(() => {});
    turnedOn.push(row.name);
  }
  return turnedOn;
}

/**
 * What is installed and what is on, for one PHP version.
 *
 * `present` comes from the extension directory and `enabled` from php.ini, and
 * they are reported separately on purpose: a DLL that is present but off is one
 * click away, while an extension enabled with no DLL behind it is exactly why
 * PHP is printing a startup warning on every command.
 *
 * @param {string} version
 * @returns {Promise<ExtensionInfo[]>}
 */
export async function listExtensions(version) {
  const row = resolveVersion("php", version);
  if (!row) return [];

  const info = await iniPathFor(version);
  const ini = info ? ((await readText(info.path)) ?? "") : "";
  /** @type {Set<string>} */
  const enabled = new Set();
  for (const m of ini.matchAll(
    /^[ \t]*(?:zend_)?extension[ \t]*=[ \t]*["']?(?:php_)?([A-Za-z0-9_]+)/gm,
  )) {
    enabled.add(m[1].toLowerCase());
  }

  /** @type {Map<string, ExtensionInfo>} */
  const rows = new Map();

  // LOADABLE FIRST, and a file on disk wins over anything `php -m` says.
  //
  // `php -m` lists compiled-in and dynamically-loaded extensions in one
  // undifferentiated list - there is no flag separating them - so treating its
  // output as "builtin" and skipping any matching file had a nasty consequence:
  // the moment you enabled an extension, `extension=curl` went into php.ini,
  // `php -m` started reporting curl, the next scan called it compiled-in, and
  // the row LEFT the toggleable list. It could never be switched off again, and
  // the count went 32 -> 31 while still reading "0 on", so the click looked
  // like it had done nothing at all.
  //
  // A `.dll`/`.so` in the extension directory is the real discriminator: that
  // file exists only for something loaded dynamically.
  const extDir = phpExtDir(version);
  if (await exists(extDir)) {
    for (const entry of await readDir(extDir, false)) {
      const m = entry.name.match(/^(?:php_)?([A-Za-z0-9_]+)\.(?:dll|so)$/i);
      if (!m) continue;
      const name = m[1].toLowerCase();
      rows.set(name, { name, present: true, enabled: enabled.has(name), builtin: false });
    }
  }

  // Whatever `php -m` reports and no file backs is genuinely compiled in.
  for (const name of await builtinExtensions(version)) {
    if (rows.has(name)) continue;
    rows.set(name, { name, present: true, enabled: true, builtin: true });
  }

  // Enabled with no file behind it: still listed, so the startup warning has a
  // visible cause instead of an invisible one.
  for (const name of enabled) {
    if (!rows.has(name)) rows.set(name, { name, present: false, enabled: true, builtin: false });
  }

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
