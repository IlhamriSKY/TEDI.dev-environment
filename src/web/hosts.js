// The system hosts file.
//
// Every domain this extension serves needs to resolve to 127.0.0.1, and the
// hosts file is the only mechanism that behaves identically on Windows, macOS
// and Linux. A local DNS server would give wildcards, but it needs port 53 and
// a system resolver change that differs per platform and, on Linux, per
// distribution. That is a lot of fragility to buy a feature most people do not
// need.
//
// Two rules make this safe to automate:
//
//   1. We only ever touch lines between our own markers. A user's own entries,
//      and anything another tool wrote, are read, preserved, and written back
//      byte for byte.
//   2. Changes are batched. One apply, one elevation prompt, however many
//      projects changed. A prompt per project is how people learn to click
//      through prompts without reading them.

import { hostsFile } from "../core/paths.js";
import { readText } from "../core/fsx.js";
import { elevate } from "../core/elevate.js";
import { isWindows, warn } from "../runtime.js";

const BEGIN = "# >>> tedi.devenv >>>";
const END = "# <<< tedi.devenv <<<";

/**
 * Read the hosts file, split into the part we do not own and the domains we do.
 *
 * @returns {Promise<{ before: string, after: string, domains: string[], readable: boolean }>}
 */
async function readHosts() {
  const raw = await readText(hostsFile());
  if (raw === null) return { before: "", after: "", domains: [], readable: false };

  const start = raw.indexOf(BEGIN);
  const end = raw.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    return { before: raw.replace(/\s*$/, ""), after: "", domains: [], readable: true };
  }

  const block = raw.slice(start + BEGIN.length, end);
  /** @type {string[]} */
  const domains = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // `127.0.0.1  a.test b.test` is legal, so take every name after the address.
    const parts = trimmed.split(/\s+/).slice(1);
    for (const name of parts) if (name && !name.startsWith("#")) domains.push(name);
  }

  return {
    before: raw.slice(0, start).replace(/\s*$/, ""),
    after: raw.slice(end + END.length).replace(/^\s*/, ""),
    domains,
    readable: true,
  };
}

/**
 * Render the whole file with our block replaced by `wanted`.
 *
 * Pure, and exported so it can be checked without touching a real hosts file:
 * this is the function whose failure mode is destroying a system file, so it
 * must be testable in isolation.
 *
 * @param {{ before: string, after: string }} parts
 * @param {string[]} wanted
 * @param {string} eol
 * @returns {string}
 */
export function renderHosts(parts, wanted, eol) {
  if (wanted.length === 0) {
    // Nothing of ours left: drop the block entirely rather than leaving an
    // empty pair of markers behind.
    const body = [parts.before, parts.after].filter(Boolean).join(eol + eol);
    return body.replace(/\s*$/, "") + eol;
  }
  const lines = [
    BEGIN,
    "# Managed by the TEDI Dev Environment extension. Edit projects in TEDI.",
    ...wanted.map((d) => `127.0.0.1\t${d}`),
    // IPv6, because a browser given a name that resolves to both may prefer ::1
    // and would otherwise get connection-refused on a machine where the server
    // is listening on IPv4 only.
    ...wanted.map((d) => `::1\t${d}`),
    END,
  ];
  const body = [parts.before, lines.join(eol), parts.after].filter(Boolean).join(eol + eol);
  return body.replace(/\s*$/, "") + eol;
}

/**
 * Make the hosts file list exactly `wanted`, under one elevation prompt.
 *
 * @param {string[]} wanted
 * @returns {Promise<{ ok: boolean, changed: boolean, message?: string }>}
 */
export async function applyHosts(wanted) {
  // ONE read, and it is the one every decision below is made from.
  //
  // This read the file TWICE - once to diff, once to render - and checked
  // `readable` only on the first. A second read that failed returned empty
  // `before` and `after`, which render as a hosts file containing nothing but
  // our block, and the user's own entries were gone. Every later publish then
  // worked from that truncated file, so the damage compounded quietly.
  const parts = await readHosts();
  if (!parts.readable) {
    return { ok: false, changed: false, message: "The hosts file could not be read." };
  }

  const have = new Set(parts.domains);
  const want = new Set(wanted);
  const inSync = wanted.every((d) => have.has(d)) && parts.domains.every((d) => want.has(d));
  if (inSync) return { ok: true, changed: false };

  const eol = isWindows() ? "\r\n" : "\n";
  const content = renderHosts(parts, wanted, eol);

  const refusal = wouldLose(parts, content);
  if (refusal) {
    warn("refusing to write the hosts file:", refusal);
    return { ok: false, changed: false, message: refusal };
  }

  const result = await elevate(writeScript(content), {
    description: "TEDI Dev Environment needs to update your hosts file",
  });
  if (!result.ok) {
    return { ok: false, changed: false, message: result.message };
  }
  return { ok: true, changed: true };
}

/**
 * Why this content must not be written, or `null`.
 *
 * The last line of defence on the one file here whose failure mode is breaking
 * name resolution for a whole machine. Everything above can be correct and this
 * still earns its place: the elevated writer replaces the file wholesale, so
 * anything wrong upstream arrives as deletion.
 *
 * Blank is refused outright. A hosts file with no bytes in it is never what
 * anyone meant - it is what a lone newline becomes after a PowerShell
 * here-string, which is exactly how this file reached zero bytes - and if there
 * is genuinely nothing left to write, leaving the previous file alone is the
 * better answer than emptying it.
 *
 * @param {{ before: string, after: string }} parts
 * @param {string} content
 * Exported for the self-check: it is the guard whose absence emptied a real
 * machine's hosts file, so it is the one thing here worth pinning.
 *
 * @returns {string | null}
 */
export function wouldLose(parts, content) {
  if (!content.trim()) return "it would leave the hosts file empty";
  if (parts.before && !content.includes(parts.before)) {
    return "it would drop the lines above this extension's block";
  }
  if (parts.after && !content.includes(parts.after)) {
    return "it would drop the lines below this extension's block";
  }
  return null;
}

/**
 * The elevated commands that replace the hosts file with `content`.
 *
 * The content is passed as a here-document / here-string rather than through
 * argv: a hosts file is a few kilobytes and command-line length limits on
 * Windows are real. Both forms are quoted so nothing in the content is
 * interpreted - a domain cannot contain a quote, but the surrounding file might
 * contain anything a user has written over the years, and it is being carried
 * through verbatim.
 *
 * @param {string} content
 * @returns {string[]}
 */
function writeScript(content) {
  const target = hostsFile();
  if (isWindows()) {
    // A single-quoted PowerShell here-string is literal; the only sequence that
    // can end it is a newline followed by '@, so escaping ' is not enough on its
    // own and the delimiter is what matters.
    const safe = content.replace(/\r?\n'@/g, "\n' @");
    return [
      `$content = @'\r\n${safe}\r\n'@`,
      // Back up once per apply, so a mistake is recoverable without us having
      // to be right the first time.
      `if (Test-Path -LiteralPath '${target}') { Copy-Item -LiteralPath '${target}' -Destination '${target}.tedi-backup' -Force }`,
      `Set-Content -LiteralPath '${target}' -Value $content -Encoding ASCII -NoNewline`,
    ];
  }
  const marker = "TEDI_DEVENV_HOSTS_EOF";
  return [
    `cp "${target}" "${target}.tedi-backup" 2>/dev/null || true`,
    `cat > "${target}" <<'${marker}'`,
    content.replace(/\s*$/, ""),
    marker,
    `chmod 644 "${target}"`,
  ];
}

/** The marker pair, exported so the dashboard can show the user what block it
 *  is talking about. */
export const MARKERS = { BEGIN, END };
