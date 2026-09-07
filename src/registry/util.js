// Helpers every provider needs, in a module that imports no provider.
//
// These used to live in `registry/index.js`, which imports all nine providers
// while each of them imported a helper back - seven import cycles. It happened
// to work, because esbuild hoists function declarations and no provider CALLS a
// helper at module scope, so nothing was read before it was defined. That is a
// property of today's code rather than of the design: one provider computing a
// default at module scope, or one `const` helper instead of a `function`, turns
// it into a temporal-dead-zone error at load time, and for an extension that
// means `activate` throws and nothing loads at all.
//
// Splitting the leaf out costs one file and removes the whole class.

import { ctx } from "../runtime.js";

/** Platform key as most projects spell it in a filename.
 *  @returns {"windows" | "macos" | "linux"} */
export function osKey() {
  const p = ctx?.os?.platform;
  if (p === "windows") return "windows";
  if (p === "macos") return "macos";
  return "linux";
}

/** GNU-style architecture, which is what tarball names use.
 *  @returns {"x86_64" | "aarch64"} */
export function gnuArch() {
  return ctx?.os?.arch === "aarch64" ? "aarch64" : "x86_64";
}

/** Short architecture, which is what most zip names use.
 *  @returns {"x64" | "arm64"} */
export function shortArch() {
  return ctx?.os?.arch === "aarch64" ? "arm64" : "x64";
}

/**
 * Sort version strings newest first, comparing numerically segment by segment
 * so `8.3.10` ranks above `8.3.9` (a lexical sort puts it below, which is how a
 * picker ends up recommending a release ten patches old).
 *
 * A trailing non-numeric suffix (`-RC1`, `-beta`) sorts BELOW the same numeric
 * version, which is what "latest stable" means to a user.
 *
 * @param {string} a @param {string} b @returns {number}
 */
export function compareVersions(a, b) {
  /** @param {string} v */
  const parse = (v) => {
    const [core, ...rest] = String(v).split(/[-+]/);
    return {
      nums: core.split(".").map((n) => parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const x = parse(a);
  const y = parse(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (y.nums[i] ?? 0) - (x.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return -1; // a is the release, b is a prerelease: a first
  if (!y.pre) return 1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Is this a version string we are willing to put in a path or a URL?
 *
 * Every version here arrives from a REMOTE index, and it is then interpolated
 * into both a download URL and an install directory. A value containing `..`,
 * a separator, or a scheme would escape the install tree or redirect the
 * download, so the shape is checked once at the choke point rather than trusted
 * because it came from a name we recognise.
 *
 * @param {string} version @returns {boolean}
 */
export function isSafeVersion(version) {
  return typeof version === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version);
}

/** `major.minor` of a version string, the key most upstream indexes use.
 *  @param {string} version @returns {string} */
export function majorMinor(version) {
  const parts = String(version).split(".");
  return `${parts[0] ?? "0"}.${parts[1] ?? "0"}`;
}
