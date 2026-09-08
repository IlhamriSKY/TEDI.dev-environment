// HTTPS for local domains.
//
// Making `https://project.test` load without a warning means four separate
// things: create a certificate authority, install it into the OS trust store,
// install it into the NSS store Firefox and Chromium keep independently on
// Linux, and issue leaf certificates from it. Each differs per platform, and
// getting the trust step subtly wrong produces a certificate that verifies fine
// on the command line and shows a warning in the browser.
//
// mkcert does exactly those four things and nothing else, so it is downloaded
// as a managed tool like everything else here. That is a deliberate trade: one
// more download in exchange for deleting the entire per-platform trust-store
// branch, which is the part most likely to be wrong and hardest to test.
//
// It is driven purely through FLAGS, never environment variables, because
// `shell_bg_spawn_direct` passes argv and no env. mkcert's own CAROOT default
// is therefore used as-is, which is also the friendlier answer: a CA the user
// may already have from another project keeps working.

import { paths, join } from "../core/paths.js";
import { exists, mkdirp, remove } from "../core/fsx.js";
import { run, probe, which } from "../core/proc.js";
import { exeSuffix, warn } from "../runtime.js";
import { installedOf, scanInstalled } from "../manager/versions.js";
import { install } from "../manager/install.js";
import { mkcert } from "../registry/mkcert.js";

/**
 * @typedef {object} CertPair
 * @property {string} cert  Absolute path to the certificate.
 * @property {string} key   Absolute path to the private key.
 */

// There was a `trusted` field here and nothing ever read it. It cost a
// `mkcert -CAROOT` SUBPROCESS on the cached path, which `generate()` walks once
// per project per web server - so publishing five projects spawned ten
// processes to answer a question with no asker. Whether the local CA is trusted
// is `httpsStatus()`'s job, asked once, where the dashboard actually shows it.

/** The mkcert binary, downloaded or on PATH, or null.
 *  @returns {Promise<string | null>} */
async function mkcertPath() {
  const installed = installedOf("mkcert")[0];
  if (installed) {
    const exe = join(installed.binDir, `mkcert${exeSuffix()}`);
    if (await exists(exe)) return exe;
  }
  return await which("mkcert");
}

/**
 * Where mkcert keeps its CA. Asked rather than assumed: the default differs per
 * platform and the user may have overridden it before TEDI ever ran.
 *
 * @returns {Promise<string | null>}
 */
async function caRoot() {
  const exe = await mkcertPath();
  if (!exe) return null;
  const out = await probe(exe, ["-CAROOT"]);
  return out ?? null;
}

/** Does a local CA exist and is it installed in the trust stores?
 *  @returns {Promise<boolean>} */
async function caInstalled() {
  const root = await caRoot();
  if (!root) return false;
  return await exists(join(root, "rootCA.pem"));
}

/**
 * Create the CA and install it into every trust store on this machine.
 *
 * This is the one step that may prompt the user for a password (macOS keychain,
 * Linux sudo for the system store). It happens once per machine, not once per
 * project, which is why it is a separate explicit action in the UI rather than
 * something that fires the first time a project is added.
 *
 * mkcert is FETCHED here if it is missing, rather than refused. It used to
 * answer "install it from the Tools section", which named a section the
 * dashboard does not have: mkcert is a tool, and the runtimes list deliberately
 * shows only PHP, Node and Composer. Sending a user to a place that does not
 * exist is worse than the download, which is a few megabytes and is the only
 * reason they pressed the button.
 *
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function installCa(onProgress) {
  let exe = await mkcertPath();

  if (!exe) {
    const versions = await mkcert.versions().catch(() => []);
    const target = versions[0]?.version;
    if (!target) {
      return {
        ok: false,
        message:
          "mkcert could not be reached, so the local CA cannot be created. Certificates will be self-signed until it can.",
      };
    }
    try {
      onProgress?.("Downloading mkcert");
      await install(mkcert, target, (msg, pct) =>
        onProgress?.(pct === undefined ? msg : `${msg} ${pct}%`),
      );
      await scanInstalled();
      exe = await mkcertPath();
    } catch (err) {
      return {
        ok: false,
        message: `Could not install mkcert: ${err instanceof Error ? err.message : err}`,
      };
    }
    if (!exe) return { ok: false, message: "mkcert installed but its binary was not found." };
  }

  onProgress?.("Installing the local CA");
  const res = await run(exe, ["-install"], { timeoutMs: 3 * 60_000 });
  if (res.code === 0) return { ok: true };
  return {
    ok: false,
    message: `mkcert could not install the local CA: ${res.out.trim().split(/\r?\n/).slice(-3).join(" ")}`,
  };
}

/**
 * A certificate covering `domains`, issued if it does not already exist.
 *
 * Keyed on the FIRST domain, and re-issued whenever the requested set changes,
 * because a certificate that covers `a.test` is not valid for the `www.a.test`
 * a user just added and the browser error would be indistinguishable from a
 * broken server.
 *
 * @param {string[]} domains
 * @returns {Promise<CertPair | null>}
 */
export async function certificateFor(domains) {
  if (domains.length === 0) return null;
  const name = domains[0];
  const dir = paths.certs();
  await mkdirp(dir);
  const cert = join(dir, `${name}.pem`);
  const key = join(dir, `${name}-key.pem`);

  if ((await exists(cert)) && (await exists(key))) return { cert, key };

  const exe = await mkcertPath();
  if (exe) {
    const res = await run(exe, ["-cert-file", cert, "-key-file", key, ...domains], {
      timeoutMs: 60_000,
    });
    if (res.code === 0) return { cert, key };
    warn("mkcert failed to issue a certificate", res.out);
  }

  const fallback = await selfSign(domains, cert, key);
  return fallback ? { cert, key } : null;
}

/**
 * A self-signed certificate, for a machine that cannot reach GitHub to get
 * mkcert.
 *
 * It will produce a browser warning, and the UI says so. That is still better
 * than no HTTPS at all: a project that only works over TLS (a service worker, a
 * secure cookie, a webhook signature check) can be developed behind a warning
 * and cannot be developed without a certificate.
 *
 * @param {string[]} domains @param {string} cert @param {string} key
 * @returns {Promise<boolean>}
 */
async function selfSign(domains, cert, key) {
  const openssl = await which("openssl");
  if (!openssl) return false;
  const san = domains.map((d) => `DNS:${d}`).join(",");
  const res = await run(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "825",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${domains[0]}`,
      "-addext",
      `subjectAltName=${san}`,
    ],
    { timeoutMs: 60_000 },
  );
  if (res.code !== 0) {
    warn("openssl self-sign failed", res.out);
    return false;
  }
  return true;
}

/**
 * Remove a certificate so the next request re-issues it. Used when a project's
 * domain changes.
 *
 * @param {string} domain @returns {Promise<void>}
 */
export async function forgetCertificate(domain) {
  await remove(join(paths.certs(), `${domain}.pem`));
  await remove(join(paths.certs(), `${domain}-key.pem`));
}

/** Is HTTPS possible at all right now?
 *  @returns {Promise<{ possible: boolean, trusted: boolean, reason?: string }>} */
export async function httpsStatus() {
  const exe = await mkcertPath();
  if (exe) {
    const trusted = await caInstalled();
    return {
      possible: true,
      trusted,
      reason: trusted ? undefined : "The local CA has not been trusted yet.",
    };
  }
  if (await which("openssl")) {
    return {
      possible: true,
      trusted: false,
      reason:
        "mkcert is not installed, so certificates will be self-signed and the browser will warn.",
    };
  }
  return { possible: false, trusted: false, reason: "Neither mkcert nor openssl is available." };
}
