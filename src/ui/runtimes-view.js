// The Runtimes section: the runtimes and the managed tools.
//
// The picker deliberately lists what is INSTALLED first and offers a separate
// "install another" control, rather than one combined dropdown of every version
// that has ever existed. Those are two different actions with very different
// costs - switching is instant, installing is a download - and a single control
// that sometimes takes 200ms and sometimes takes four minutes trains people to
// be afraid of it.

import {
  h,
  row,
  pill,
  muted,
  button,
  dropdown,
  section,
  mark,
  modal,
  progress,
  textInput,
} from "./el.js";
import { openPhpConfig } from "./php-view.js";
import { openPackagers } from "./packagers-view.js";
import { markFor } from "./marks.js";
import { providers } from "../registry/index.js";
import { isPrerelease } from "../registry/util.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion, setActiveVersion } from "../manager/config.js";
import { install, uninstall } from "../manager/install.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { installable } from "../manager/defaults.js";
import { installEverything } from "./install-all.js";
import { state, ctx, throttle } from "../runtime.js";

/** @typedef {import("../registry/index.js").Provider} Provider */

/**
 * @param {() => void} refresh  Re-render and re-scan.
 * @returns {HTMLElement}
 */
export function runtimesView(refresh) {
  // Every runtime, and every managed TOOL. Composer and mkcert are tools rather
  // than runtimes, but from here they behave identically: a version you install,
  // switch and remove. Listing one and hiding the other made the "install
  // recommended" count disagree with the rows on screen.
  const rows = providers()
    .filter((p) => p.kind === "runtime" || p.kind === "tool")
    .map((p) => runtimeRow(p, refresh));

  // Offered only while something is genuinely missing. A permanent "install
  // everything" button on a finished environment is a trap, not an affordance.
  // Counted over EVERY provider, not just the cross-platform four: by the time
  // this section renders the setup gate has already installed those, and what
  // is left to offer is the servers and databases.
  const missing = installable().filter(
    (p) => !installedOf(p.id).some((r) => r.origin === "download"),
  );
  const aside = missing.length
    ? button(`Install everything (${missing.length})`, () => void installEverything(refresh), {
        variant: "primary",
        icon: "lucide:Download",
        title: `Installs the current stable release of ${missing.map((p) => p.label).join(", ")}. Anything with no build for this platform is reported, not retried.`,
      })
    : muted("Everything available here is installed");

  return section("Runtimes", rows, aside);
}

/**
 * One runtime, on one line.
 *
 * The version control is a dropdown even when only one version is installed,
 * because "system" IS a choice the moment a second one appears and a control
 * that changes shape when a list grows is harder to find than one that does not.
 *
 * @param {Provider} p @param {() => void} refresh
 * @returns {HTMLElement}
 */
function runtimeRow(p, refresh) {
  const installed = installedOf(p.id);
  const active = activeVersion(p.id) ?? installed[0]?.version ?? null;
  const busy = state.busy.get(p.id);
  const logo = markFor(p.id);

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;min-width:170px;flex:none" },
    [
      mark(logo),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        h("span", { text: p.label, style: "font-size:12px;font-weight:600;line-height:1.35" }),
        muted(
          busy
            ? `${busy.text}${busy.pct === undefined ? "" : ` ${busy.pct}%`}`
            : installed.length
              ? `${installed.length} installed`
              : "not installed",
        ),
      ]),
    ],
  );

  // The configuration for a runtime opens FROM the version it configures, so
  // there is never a question about which install is being edited. PHP has a
  // php.ini, extensions and Xdebug; Node has its package managers, which
  // Corepack enables per version.
  const configure =
    p.id === "php"
      ? button("Configure", () => active && openPhpConfig(active, refresh), {
          icon: "lucide:Settings2",
          title: `php.ini, extensions and Xdebug for PHP ${active ?? ""}`,
        })
      : p.id === "node"
        ? button("Packages", () => active && openPackagers(active, refresh), {
            icon: "lucide:Package",
            title: `npm, pnpm, Yarn and Bun for Node ${active ?? ""}`,
          })
        : null;

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:1;min-width:0" },
    installed.length
      ? [
          dropdown(
            installed.map((v) => ({
              value: v.version,
              label: v.version,
              hint: v.origin === "system" ? "system" : undefined,
            })),
            active,
            async (version) => {
              await setActiveVersion(p.id, version);
              // Switching the default changes what every unpinned project
              // resolves to, and what a terminal with no project config gets.
              await applyRuntimeChange();
              refresh();
            },
            { full: true },
          ),
          configure,
        ]
      : [muted(p.blurb ?? "")],
  );

  const right = h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
    button("Install", () => void openInstaller(p, refresh), {
      icon: "lucide:Download",
      disabled: Boolean(busy),
      title: `Install another ${p.label} version`,
    }),
    installed.some((v) => v.origin === "download" && v.version === active)
      ? button(
          "Remove",
          async () => {
            if (!active) return;
            await uninstall(p, active);
            await setActiveVersion(p.id, null);
            await applyRuntimeChange();
            refresh();
          },
          { variant: "danger", title: `Remove ${p.label} ${active}` },
        )
      : null,
  ]);

  const line = row([left, middle, right]);
  // Same shape the setup checklist uses: the bar belongs to the row doing the
  // work, so nothing has to say which component it is measuring.
  if (!busy) return line;
  return h("div", { style: "display:flex;flex-direction:column;min-width:0" }, [
    line,
    progress(busy.pct),
  ]);
}

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
async function openInstaller(p, refresh) {
  // Throttled, because `curl` reports a new percentage up to a hundred times
  // per transfer and each one repaints the whole panel. The `finally` below
  // repaints unconditionally, so the frame that lands at 100% is never the one
  // that gets dropped.
  const tick = throttle(refresh);
  state.busy.set(p.id, { text: "Checking available versions" });
  refresh();
  try {
    const list = await p.versions();
    if (list.length === 0) {
      ctx?.ui.toast(
        p.packageHint
          ? `No ${p.label} download exists for this platform. Install it with: ${p.packageHint}`
          : `No ${p.label} versions are available right now.`,
        { variant: "warning" },
      );
      return;
    }
    state.busy.delete(p.id);
    refresh();

    const picked = await pickVersion(p, list);
    if (!picked) return;

    await install(p, picked, (text, pct) => {
      state.busy.set(p.id, { text, ...(pct === undefined ? {} : { pct }) });
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
    state.busy.delete(p.id);
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
      const hits = (q ? list.filter((v) => v.version.toLowerCase().includes(q)) : list).slice(0, 60);
      results.replaceChildren(...hits.map((v) => versionRow(v, have.has(v.version), finish, () => dialog.close())));
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
      v.released ? muted(String(v.released).slice(0, 10)) : null,
    ],
  );
}
