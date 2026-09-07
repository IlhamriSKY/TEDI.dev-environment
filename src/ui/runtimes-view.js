// The Runtimes section: the runtimes and the managed tools.
//
// The picker deliberately lists what is INSTALLED first and offers a separate
// "install another" control, rather than one combined dropdown of every version
// that has ever existed. Those are two different actions with very different
// costs - switching is instant, installing is a download - and a single control
// that sometimes takes 200ms and sometimes takes four minutes trains people to
// be afraid of it.

import { h, row, pill, muted, button, dropdown, section, mark, modal } from "./el.js";
import { openPhpConfig } from "./php-view.js";
import { openPackagers } from "./packagers-view.js";
import { markFor } from "./marks.js";
import { providers, provider } from "../registry/index.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion, setActiveVersion } from "../manager/config.js";
import { install, uninstall } from "../manager/install.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { installable } from "../manager/defaults.js";
import { installEverything } from "./install-all.js";
import { state, ctx } from "../runtime.js";

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
        muted(busy ?? (installed.length ? `${installed.length} installed` : "not installed")),
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

  return row([left, middle, right]);
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
  state.busy.set(p.id, "Checking available versions");
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

    await install(p, picked, (msg, pct) => {
      state.busy.set(p.id, pct === undefined ? msg : `${msg} ${pct}%`);
      refresh();
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

    const items = list.slice(0, 60).map((v) =>
      h(
        "button",
        {
          style:
            "display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 10px;" +
            "border:0;border-radius:999px;background:transparent;color:var(--foreground);" +
            "font-size:11.5px;cursor:pointer",
          on: {
            click: () => {
              finish(v.version);
              dialog.close();
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
          h("span", { text: v.version, style: "font-family:ui-monospace,monospace;flex:1" }),
          v.channel === "lts" ? pill("LTS") : null,
          v.recommended ? pill("recommended") : null,
          have.has(v.version) ? muted("installed") : null,
        ],
      ),
    );

    dialog = modal({
      title: h("span", { style: "display:flex;align-items:center;gap:8px" }, [
        mark(logo, 16),
        h("strong", { text: `Install ${p.label}`, style: "font-size:13px;font-weight:500" }),
      ]),
      body: h(
        "div",
        { style: "overflow:auto;display:flex;flex-direction:column;gap:1px;max-height:46vh" },
        items,
      ),
      // Escape and the backdrop must resolve too, or the caller waits on a
      // dialog that is no longer on screen.
      onClose: () => finish(null),
    });
  });
}
