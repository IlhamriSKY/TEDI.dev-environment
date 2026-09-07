// Downloading, and reading remote metadata.
//
// `http_stream` exists on the host, but it streams into the WEBVIEW over IPC,
// which is the wrong shape here: a PostgreSQL archive is a few hundred
// megabytes and would cross the IPC boundary as text before being written back
// out. So transfers go to disk directly through a downloader process, exactly
// as `tedi.browser` fetches Chrome.
//
// `curl` is the first choice and is present by default on Windows 10 1803+,
// every macOS, and nearly every Linux. `wget` covers the minimal distributions
// that ship one and not the other, and PowerShell is the last resort on
// Windows. A machine with none of the three cannot install anything, and says
// so plainly rather than failing per-download.

import { isWindows, state } from "../runtime.js";
import { run, which } from "./proc.js";
import { paths } from "./paths.js";
import { readDir, readText, mkdirp, remove } from "./fsx.js";

/** Downloader chosen once per session; probing costs a subprocess each time.
 *  @type {"curl" | "wget" | "powershell" | null} */
let downloader = null;

/** @returns {Promise<"curl" | "wget" | "powershell">} */
async function pickDownloader() {
  if (downloader) return downloader;
  if (await which("curl")) return (downloader = "curl");
  if (await which("wget")) return (downloader = "wget");
  if (isWindows() && (await which("powershell"))) return (downloader = "powershell");
  throw new Error(
    "No downloader found. Install curl (or wget) and reopen the Dev Environment pane.",
  );
}

/**
 * Fetch a URL to a file, replacing whatever is there.
 *
 * @param {string} url
 * @param {string} dest Absolute destination path.
 * @param {{ onProgress?: (pct: number) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function download(url, dest, opts = {}) {
  const { onProgress, timeoutMs = 45 * 60_000 } = opts;
  const tool = await pickDownloader();
  const parent = dest.replace(/[\\/][^\\/]*$/, "");
  if (parent && parent !== dest) await mkdirp(parent);

  /** curl's `-#` meter prints `\r####   45.2%`, so the percentage is stated
   *  outright instead of having to be inferred from hash marks. wget's is
   *  `... 45% ...`. One regex reads both. */
  let lastPct = -1;
  /** @param {string} chunk */
  const scan = (chunk) => {
    if (!onProgress) return;
    const hits = chunk.match(/(\d{1,3}(?:\.\d+)?)%/g);
    if (!hits?.length) return;
    const pct = Math.min(100, Math.round(parseFloat(hits[hits.length - 1])));
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress(pct);
    }
  };

  /** @type {[string, string[]]} */
  let cmd;
  if (tool === "curl") {
    // --fail so an HTML 404 page is an error rather than a saved file that
    // later fails to extract with a baffling message. -L follows the redirects
    // every one of these projects serves downloads through.
    cmd = ["curl", ["-L", "--fail", "--create-dirs", "-#", "-o", dest, url]];
  } else if (tool === "wget") {
    cmd = ["wget", ["--progress=dot:mega", "-O", dest, url]];
  } else {
    cmd = [
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${dest.replace(/'/g, "''")}' -UseBasicParsing`,
      ],
    ];
  }

  const res = await run(cmd[0], cmd[1], { timeoutMs, onOutput: scan });
  if (res.code !== 0) {
    const tail = res.out.trim().split(/\r?\n/).slice(-4).join(" ");
    throw new Error(
      `Download failed (${tool} exited ${res.code}): ${url}${tail ? ` - ${tail}` : ""}`,
    );
  }
  onProgress?.(100);
}

/**
 * Fetch text, through a temp file rather than into memory over IPC.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function fetchText(url, opts = {}) {
  const tmp = `${paths.cache()}${isWindows() ? "\\" : "/"}fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await download(url, tmp, { timeoutMs: opts.timeoutMs ?? 60_000 });
  const text = await readText(tmp);
  // Best-effort cleanup; a leftover temp file in our own cache is harmless and
  // swept on the next start.
  await remove(tmp).catch(() => {});
  if (text === null) throw new Error(`Downloaded content was not readable text: ${url}`);
  return text;
}

/**
 * Fetch JSON with an on-disk cache.
 *
 * Version indexes change a few times a week at most, and every dashboard render
 * would otherwise hit the network. `ttlMs` of 0 forces a refresh; a failed
 * refresh falls back to the stale copy, because an offline machine should still
 * be able to see what it already has installed.
 *
 * @template T
 * @param {string} key   Cache filename, no extension.
 * @param {string} url
 * @param {{ ttlMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function fetchJson(key, url, opts = {}) {
  const ttlMs = opts.ttlMs ?? 6 * 60 * 60_000;
  const sep = isWindows() ? "\\" : "/";
  const file = `${paths.cache()}${sep}${key}.json`;

  if (ttlMs > 0) {
    const entries = await readDir(paths.cache(), true);
    const hit = entries.find((e) => e.name === `${key}.json`);
    if (hit && hit.mtime > 0 && Date.now() - hit.mtime < ttlMs) {
      const cached = await readText(file);
      if (cached) {
        try {
          return /** @type {T} */ (JSON.parse(cached));
        } catch {
          // Fall through and refetch; a corrupt cache is not worth reporting.
        }
      }
    }
  }

  try {
    await download(url, file, { timeoutMs: 60_000 });
    const text = await readText(file);
    if (text === null) throw new Error("empty response");
    return /** @type {T} */ (JSON.parse(text));
  } catch (err) {
    const stale = await readText(file);
    if (stale) {
      try {
        return /** @type {T} */ (JSON.parse(stale));
      } catch {
        /* fall through to the real error */
      }
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Does this URL exist? A HEAD request, used to confirm a templated download URL
 * before offering the version behind it, so the UI never lists a build that
 * 404s when clicked.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function urlExists(url) {
  if (!state.active) return false;
  const tool = await pickDownloader().catch(() => null);
  if (tool === "curl") {
    const res = await run("curl", ["-L", "--silent", "--head", "--fail", "-o", devNull(), url], {
      timeoutMs: 20_000,
    });
    return res.code === 0;
  }
  if (tool === "wget") {
    const res = await run("wget", ["--spider", "-q", url], { timeoutMs: 20_000 });
    return res.code === 0;
  }
  return false;
}

/** The platform's bit bucket. */
function devNull() {
  return isWindows() ? "NUL" : "/dev/null";
}
