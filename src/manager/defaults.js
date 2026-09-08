// Choosing a default version, and setting up a working environment in one go.
//
// Two things a user should never have to do by hand:
//
//   1. Pick a default when there is only one sensible answer. If a component
//      has installs and no default recorded, the newest DOWNLOADED one is it,
//      falling back to a detected system install. Without this the dropdown
//      shows a version while `config.defaults` is empty, and the shims fall
//      through to whatever `resolveVersion` guesses - which is the same answer
//      most of the time and a different one exactly when it matters.
//
//   2. Assemble a whole environment from nothing. "Install everything" takes
//      each component's own newest STABLE release - never a number written into
//      this file, which would be wrong within weeks.
//
// It installs everything the CURRENT platform has a build for, rather than a
// fixed list. nginx, Apache, MySQL, PostgreSQL and Redis are
// Windows-download-or-system-elsewhere (see the provider table), so a fixed
// list would promise the same set everywhere and fail on two platforms. Asking
// each provider what it actually has means the button installs five things on
// one machine and nine on another, and says which, instead of lying about
// either.

import { providers, provider } from "../registry/index.js";
import { compareVersions } from "../registry/util.js";
import { installedOf } from "./versions.js";
import { activeVersion, setActiveVersion } from "./config.js";
import { install } from "./install.js";
import { applyRuntimeChange } from "./apply.js";
import { setBusy } from "../runtime.js";

/**
 * Components with an official build for Windows, macOS and Linux alike.
 *
 * This is the set a one-click setup can honestly promise. mkcert belongs here
 * as much as the runtimes do: it is a single Go binary published for all three
 * platforms on both architectures, and it is the thing that makes
 * `https://project.test` load without a browser warning. Leaving it out meant a
 * freshly set-up environment still said "certificates will be self-signed",
 * which is a setup that is not actually finished.
 */
export const CROSS_PLATFORM = ["php", "node", "composer", "mkcert"];

/**
 * Install order: the things a project cannot run without, then the tools, then
 * the servers and databases.
 *
 * An order, not a filter - a component this list does not name still gets
 * installed, at the end. Runtimes go first because they are the slowest and the
 * ones the user is actually waiting for, so a run interrupted half way has
 * still delivered a working PHP.
 */
const ORDER = [
  "php",
  "node",
  "composer",
  "mkcert",
  "nginx",
  "apache",
  "mysql",
  "postgres",
  "redis",
];

/**
 * Every managed component, in install order.
 *
 * @returns {import("../registry/index.js").Provider[]}
 */
export function installable() {
  const rank = (/** @type {string} */ id) => {
    const at = ORDER.indexOf(id);
    return at === -1 ? ORDER.length : at;
  };
  return [...providers()].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Record a default for every component that has installs but no chosen one.
 *
 * Prefers a managed install over a detected system one: the managed copy is the
 * version this extension can configure, add extensions to and switch, and
 * silently defaulting to the system PHP would make all three appear broken.
 *
 * @returns {Promise<string[]>} the component ids that gained a default
 */
export async function seedDefaults() {
  /** @type {string[]} */
  const seeded = [];
  for (const p of providers()) {
    if (activeVersion(p.id)) continue;
    const rows = installedOf(p.id);
    if (rows.length === 0) continue;

    const downloaded = rows
      .filter((r) => r.origin === "download")
      .sort((a, b) => compareVersions(a.version, b.version));
    const pick = downloaded[0] ?? rows[0];
    await setActiveVersion(p.id, pick.version);
    seeded.push(p.id);
  }
  if (seeded.length) await applyRuntimeChange();
  return seeded;
}

/**
 * The version a component recommends for itself, as its own index states it.
 *
 * Never hardcoded here: "stable" is a moving target, and a number written into
 * this file would be wrong within weeks. `versions()` marks one entry
 * `recommended` - the newest LTS for Node, the newest release everywhere else -
 * and that is the one taken.
 *
 * @param {string} componentId
 * @returns {Promise<string | null>}
 */
async function recommendedVersion(componentId) {
  const p = provider(componentId);
  if (!p) return null;
  try {
    const list = await p.versions();
    return (list.find((v) => v.recommended) ?? list[0])?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Install everything, at each component's own newest stable release.
 *
 * Skips anything already downloaded rather than reinstalling it, so pressing
 * the button twice is safe and the second press is instant. A component with no
 * build for this platform is reported as UNAVAILABLE, not as a failure: that is
 * a fact about the upstream project rather than something that went wrong, and
 * calling it an error would make a healthy Linux setup look broken in five
 * places at once.
 *
 * One component failing never stops the rest. A MySQL scrape that breaks
 * because the download page changed must not cost the user their PHP.
 *
 * @param {(msg: string) => void} [say]
 * @returns {Promise<{ installed: string[], skipped: string[], unavailable: string[],
 *                     failed: {id: string, error: string}[] }>}
 */
export async function installRecommended(say) {
  /** @type {string[]} */ const installed = [];
  /** @type {string[]} */ const skipped = [];
  /** @type {string[]} */ const unavailable = [];
  /** @type {{id: string, error: string}[]} */ const failed = [];

  const queue = installable();
  // Only the ones that will actually be worked on count towards "3 of 9": a
  // component that is already there is skipped in a millisecond, and counting
  // it makes the bar jump before anything has been downloaded.
  const total = queue.filter((p) => !installedOf(p.id).some((r) => r.origin === "download")).length;
  let step = 0;

  for (const p of queue) {
    if (installedOf(p.id).some((r) => r.origin === "download")) {
      skipped.push(p.label);
      continue;
    }
    step++;

    try {
      setBusy(p.id, { text: "Checking versions", step, total });
      say?.(`Looking up ${p.label}`);
      const version = await recommendedVersion(p.id);
      if (!version) {
        // An empty index means this upstream publishes nothing for this OS.
        unavailable.push(p.label);
        continue;
      }
      // `install` already writes `state.busy`; this adds the batch position,
      // which only the batch knows.
      await install(p, version, (text, pct) => {
        setBusy(p.id, { text, ...(pct === undefined ? {} : { pct }), step, total });
        say?.(`${p.label}: ${text}`);
      });
      await setActiveVersion(p.id, version);
      installed.push(`${p.label} ${version}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // `install` throws exactly this when `download()` answers null, which is
      // the same "no build here" fact an empty index reports.
      if (/no prebuilt download for this platform/i.test(message)) unavailable.push(p.label);
      else failed.push({ id: p.label, error: message });
    } finally {
      setBusy(p.id, null);
    }
  }

  await applyRuntimeChange();
  return { installed, skipped, unavailable, failed };
}
