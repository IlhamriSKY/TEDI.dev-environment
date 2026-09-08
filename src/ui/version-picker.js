// Installing another version of anything managed.
//
// Extracted from `runtimes-view` when the SERVICE rows gained the same control.
// Nginx, MySQL and the rest are versioned downloads exactly like PHP and Node,
// and the only reason they could not be installed from their own row was that
// the picker lived in the other view. Two copies of a modal that resolves a
// version list, filters it and reports what happened is how the two drift.

import { h, pill, muted, mark, modal, textInput, SPIN_MS } from "./el.js";
import { sleep } from "../core/proc.js";
import { markFor } from "./marks.js";
import { isPrerelease } from "../registry/util.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion, setActiveVersion } from "../manager/config.js";
import { install } from "../manager/install.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { ctx, throttle, setBusy } from "../runtime.js";

/** @typedef {import("../registry/index.js").Provider} Provider */

/**
 * Ask which version to install, then install it.
 *
 * The list is fetched on demand rather than at render: it is a network call per
 * provider, and doing all of them on every repaint would put the dashboard on
 * the network several times a second.
 *
 * @param {Provider} p @param {() => void} refresh
 * @returns {Promise<void>}
 */
export async function openInstaller(p, refresh) {
  // Throttled, because `curl` reports a new percentage up to a hundred times
  // per transfer and each one repaints the whole panel. The `finally` below
  // repaints unconditionally, so the frame that lands at 100% is never the one
  // that gets dropped.
  const tick = throttle(refresh);
  // `quiet`, so the row does NOT grow an indeterminate progress bar for this.
  // A sweeping bar is the shape of a download; this is one metadata request
  // that usually takes a few hundred milliseconds, and the honest signal for it
  // is the button you just pressed still working.
  setBusy(p.id, { text: "Checking available versions", quiet: true });
  refresh();
  const started = Date.now();
  try {
    const list = await p.versions();
    // A version list is cached, so the second time it answers in a few tens of
    // milliseconds - and a spinner that appears and vanishes inside one frame
    // reads as a glitch, not as work. Held for one full turn of the icon so
    // pressing Install always looks the same whether or not the list was
    // already on disk.
    const left = SPIN_MS - (Date.now() - started);
    if (left > 0) await sleep(left);
    if (list.length === 0) {
      ctx?.ui.toast(
        p.packageHint
          ? `No ${p.label} download exists for this platform. Install it with: ${p.packageHint}`
          : `No ${p.label} versions are available right now.`,
        { variant: "warning" },
      );
      return;
    }
    setBusy(p.id, null);
    refresh();

    const picked = await pickVersion(p, list);
    if (!picked) return;

    await install(p, picked, (text, pct) => {
      setBusy(p.id, { text, ...(pct === undefined ? {} : { pct }) });
      tick();
    });
    // Rescan BEFORE choosing a default: `setActiveVersion` records a version
    // that `resolveVersion` has to be able to find, and it reads the scan.
    await applyRuntimeChange();
    if (!activeVersion(p.id)) {
      await setActiveVersion(p.id, picked);
      await applyRuntimeChange();
    }
    ctx?.ui.toast(`${p.label} ${picked} installed.`, { variant: "success" });
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  } finally {
    setBusy(p.id, null);
    refresh();
  }
}

/**
 * A modal version picker.
 *
 * Built by hand rather than with `prompt()`: a webview `prompt` is blocking and
 * ugly, and the list needs to show which release is LTS and which is already
 * installed, neither of which fits in a text prompt.
 *
 * @param {Provider} p
 * @param {import("../registry/index.js").VersionInfo[]} list
 * @returns {Promise<string | null>}
 */
function pickVersion(p, list) {
  return new Promise((resolve) => {
    const have = new Set(installedOf(p.id).map((v) => v.version));
    const logo = markFor(p.id);
    let settled = false;
    /** @param {string | null} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    /** @type {{ close: () => void }} */
    let dialog;

    const results = h("div", {
      style: "overflow:auto;display:flex;flex-direction:column;gap:1px;max-height:46vh",
    });

    const field = textInput(`Search ${list.length} version${list.length === 1 ? "" : "s"}`);

    /**
     * Redraw the list for what is typed.
     *
     * The cap is applied AFTER filtering, which is the whole point of the
     * search: the list used to be sliced to the newest 60 and nothing else was
     * reachable, so a project pinned to an older release could be listed by its
     * own index and still impossible to pick here. Node alone publishes several
     * hundred.
     */
    const draw = () => {
      const q = field.value.trim().toLowerCase();
      const hits = (q ? list.filter((v) => v.version.toLowerCase().includes(q)) : list).slice(
        0,
        60,
      );
      results.replaceChildren(
        ...hits.map((v) => versionRow(v, have.has(v.version), finish, () => dialog.close())),
      );
      if (hits.length === 0) results.append(muted("No version matches that."));
    };

    field.addEventListener("input", draw);
    draw();

    dialog = modal({
      title: h("span", { style: "display:flex;align-items:center;gap:8px" }, [
        mark(logo, 16),
        h("strong", { text: `Install ${p.label}`, style: "font-size:13px;font-weight:500" }),
      ]),
      body: h("div", { style: "display:flex;flex-direction:column;gap:9px;min-height:0" }, [
        field,
        results,
      ]),
      // Escape and the backdrop must resolve too, or the caller waits on a
      // dialog that is no longer on screen.
      onClose: () => finish(null),
    });
    field.focus();
  });
}

/**
 * The release date as day-month-year.
 *
 * Upstreams state it ISO, which sorts well and reads as a foreign format in a
 * list nobody is sorting by hand. Reformatted from the STRING rather than
 * through `Date`, because parsing a bare `2024-04-24` gives midnight UTC and
 * anyone west of it would see the day before.
 *
 * @param {string} released @returns {string}
 */
export function releaseDate(released) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(released));
  return iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : String(released).slice(0, 10);
}

/**
 * What a version is, in badges.
 *
 * Four facts, and each is a glyph AND a word: which one you already have, which
 * one this project recommends, which are long-term support, and which are
 * finished releases rather than release candidates. The last is the one the
 * list could not say before - a prerelease sorted below its own release and
 * then sat in the picker looking identical to it.
 *
 * Colour is used only where it means something. Installed is green because it
 * answers "do I need to do anything"; a prerelease is amber because it is the
 * one choice with a consequence; stable and LTS are muted, because they are the
 * normal case and a list where every row shouts says nothing.
 *
 * @param {import("../registry/index.js").VersionInfo} v
 * @param {boolean} installed
 * @param {(value: string) => void} finish
 * @param {() => void} close
 * @returns {HTMLElement}
 */
function versionRow(v, installed, finish, close) {
  const pre = isPrerelease(v.version);
  return h(
    "button",
    {
      style:
        "display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:6px 10px;" +
        "border:0;border-radius:999px;background:transparent;color:var(--foreground);" +
        "font-size:11.5px;cursor:pointer",
      on: {
        click: () => {
          finish(v.version);
          close();
        },
        mouseenter: (ev) => {
          /** @type {HTMLElement} */ (ev.currentTarget).style.background = "var(--accent)";
        },
        mouseleave: (ev) => {
          /** @type {HTMLElement} */ (ev.currentTarget).style.background = "transparent";
        },
      },
    },
    [
      h("span", {
        text: v.version,
        style: "font-family:ui-monospace,monospace;flex:1;min-width:0",
      }),
      installed
        ? pill("Installed", {
            icon: "lucide:HardDrive",
            colour: "var(--tedi-icon-idle, #34d399)",
            title: "Already downloaded into this environment",
          })
        : null,
      v.recommended
        ? pill("Recommended", {
            icon: "lucide:Star",
            colour: "var(--primary)",
            title: "What this project itself calls current",
          })
        : null,
      v.channel === "lts"
        ? pill("LTS", { icon: "lucide:ShieldCheck", title: "Long-term support release" })
        : null,
      pre
        ? pill("Prerelease", {
            icon: "lucide:FlaskConical",
            colour: "var(--tedi-icon-working, #facc15)",
            title: "A release candidate or beta, not a finished release",
          })
        : pill("Stable", { icon: "lucide:CircleCheck", title: "A finished release" }),
      // The date the project itself states, when it states one. Two versions a
      // year apart is the thing a bare number cannot tell you.
      v.released ? muted(releaseDate(v.released)) : null,
    ],
  );
}
