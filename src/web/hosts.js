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
import { isWindows } from "../runtime.js";

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
 * What is missing and what is stale, without changing anything.
 *
 * @param {string[]} wanted
 * @returns {Promise<{ missing: string[], extra: string[], inSync: boolean, readable: boolean }>}
 */
async function diffHosts(wanted) {
  const { domains, readable } = await readHosts();
  const have = new Set(domains);
  const want = new Set(wanted);
  const missing = wanted.filter((d) => !have.has(d));
  const extra = domains.filter((d) => !want.has(d));
  return { missing, extra, inSync: missing.length === 0 && extra.length === 0, readable };
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
  const diff = await diffHosts(wanted);
  if (!diff.readable) {
    return { ok: false, changed: false, message: "The hosts file could not be read." };
  }
  if (diff.inSync) return { ok: true, changed: false };

  const parts = await readHosts();
  const eol = isWindows() ? "\r\n" : "\n";
  const content = renderHosts(parts, wanted, eol);

  const result = await elevate(writeScript(content), {
    description: "TEDI Dev Environment needs to update your hosts file",
  });
  if (!result.ok) {
    return { ok: false, changed: false, message: result.message };
  }
  return { ok: true, changed: true };
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
