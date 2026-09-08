// "Install everything", and the sentence that reports what happened.
//
// Its own file because two places offer it - the setup checklist and the
// Runtimes header - and neither can import the other: the dashboard already
// imports the runtimes view. A leaf module both can reach keeps one wording and
// one behaviour instead of two that drift.

import { installRecommended } from "../manager/defaults.js";
import { httpsStatus, installCa } from "../web/certs.js";
import { ctx, throttle } from "../runtime.js";

/**
 * Install the current stable release of every component this platform has a
 * build for, reporting as it goes.
 *
 * @param {() => void} refresh
 * @returns {Promise<void>}
 */
export async function installEverything(refresh) {
  ctx?.ui.toast("Installing the current stable release of every component.", { variant: "info" });
  try {
    // `installRecommended` writes progress into `state.busy` under the id it is
    // working on, so each row reports its own download. Pinning it to one id
    // here would put another component's percentage on the PHP row.
    //
    // Throttled: nine components at up to a hundred percentage points each is
    // nine hundred full repaints, which reads as a flicker rather than as
    // progress. The `finally` below repaints unconditionally, so the last frame
    // is never the dropped one.
    const res = await installRecommended(throttle(refresh));
    const parts = [];
    if (res.installed.length) parts.push(`Installed ${res.installed.join(", ")}.`);
    if (res.skipped.length) parts.push(`${res.skipped.join(", ")} were already there.`);
    // Stated, never hidden: "no build for this platform" is the single most
    // surprising thing about this extension, and silence about it reads as a
    // bug rather than as the upstream fact it is.
    if (res.unavailable.length) {
      // And what to do about it. On macOS and Linux this is the NORMAL answer
      // for the servers and databases, and a sentence that only states the
      // absence reads as a failure rather than as the upstream fact it is - the
      // detected system install works, and it is what the Services rows will
      // use.
      parts.push(
        `No download for ${res.unavailable.join(", ")} on this platform. ` +
          "Install them with your package manager and they will be detected.",
      );
    }
    if (res.failed.length)
      parts.push(res.failed.map((f) => `${f.id} failed: ${f.error}`).join(" "));

    // Trusting the local CA is part of installing, not a step of its own.
    // mkcert is in the set above, so by here the tool exists; running it now
    // costs the one administrator prompt a user already expects from an
    // install, and it is what makes `https://<project>` load without a warning.
    // As a separate checklist item it was a second prompt, later, on a screen
    // that had otherwise finished.
    const https = await httpsStatus();
    if (!https.trusted && https.possible) {
      const ca = await installCa((msg) => ctx?.ui.toast(msg, { variant: "info" }));
      parts.push(
        ca.ok
          ? "Local certificate authority trusted."
          : `Certificates will be self-signed: ${ca.message ?? "the CA was not installed"}.`,
      );
    }

    ctx?.ui.toast(parts.join(" ") || "Nothing to do.", {
      variant: res.failed.length ? "warning" : "success",
    });
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  } finally {
    refresh();
  }
}
