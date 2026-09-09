// The Runtimes section: the runtimes and the managed tools.
//
// The picker deliberately lists what is INSTALLED first and offers a separate
// "install another" control, rather than one combined dropdown of every version
// that has ever existed. Those are two different actions with very different
// costs - switching is instant, installing is a download - and a single control
// that sometimes takes 200ms and sometimes takes four minutes trains people to
// be afraid of it.

import { h, row, muted, button, dropdown, section, mark, progress, confirm, status } from "./el.js";
import { openPhpConfig } from "./php-view.js";
import { openPackagers } from "./packagers-view.js";
import { markFor } from "./marks.js";
import { providers } from "../registry/index.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion, setActiveVersion } from "../manager/config.js";
import { uninstall } from "../manager/install.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { installable } from "../manager/defaults.js";
import { installEverything } from "./install-all.js";
import { openInstaller } from "./version-picker.js";
import { state, loudBusy } from "../runtime.js";

/** @typedef {import("../registry/index.js").Provider} Provider */

/**
 * @param {() => void} refresh  Re-render and re-scan.
 * @returns {HTMLElement}
 */
export function runtimesView(refresh) {
  // The runtimes, and only the runtimes: PHP and Node.
  //
  // Composer and mkcert were listed here too, on the reasoning that a tool
  // behaves identically from this row - a version you install, switch and
  // remove. True, and not the point: nobody switches them. Composer is one phar
  // run by whichever PHP the project resolved, and mkcert is a single binary
  // that manages a machine-wide CA. Both are installed by "Install everything"
  // and neither has a decision attached, so a row with a version dropdown and a
  // Remove button was two controls for questions nobody asks, sitting above the
  // two rows that matter.
  //
  // They are still managed, still installed, still counted by the button below.
  const rows = providers()
    .filter((p) => p.kind === "runtime")
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
  // See `services-view`: a version check belongs to its button, not to the
  // component, and that includes the rows under Install everything.
  const loud = loudBusy(p.id);
  const logo = markFor(p.id);

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:min(170px,100%)" },
    [
      mark(logo),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        h("span", { text: p.label, style: "font-size:12px;font-weight:600;line-height:1.35" }),
        // The glyph every other row in this pane carries. Runtimes was the one
        // row type without it, which meant a PHP mid-download and a PHP sitting
        // there said the same thing in the same place with only the words
        // differing - and the words are what you read last.
        h("span", { style: "display:flex;align-items:center;gap:5px" }, [
          status(loud ? "working" : installed.length ? "ok" : "idle"),
          muted(
            loud
              ? `${loud.text}${loud.pct === undefined ? "" : ` ${loud.pct}%`}`
              : installed.length
                ? `${installed.length} installed`
                : "not installed",
          ),
        ]),
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
    { style: "display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;flex-wrap:wrap" },
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

  const right = h(
    "div",
    { style: "display:flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0;flex-wrap:wrap" },
    [
      button("Install", () => void openInstaller(p, refresh), {
        icon: "lucide:Download",
        disabled: Boolean(busy),
        spin: busy?.quiet,
        title: busy?.quiet ? busy.text : `Install another ${p.label} version`,
      }),
      installed.some((v) => v.origin === "download" && v.version === active)
        ? button(
            "Remove",
            async () => {
              if (!active) return;
              const ok = await confirm({
                title: `Remove ${p.label} ${active}?`,
                description:
                  `The installed files are deleted. Anything pinned to ${active} falls back to ` +
                  `the next version, and getting it back is another download.`,
              });
              if (!ok) return;
              await uninstall(p, active);
              await setActiveVersion(p.id, null);
              await applyRuntimeChange();
              refresh();
            },
            { variant: "danger", title: `Remove ${p.label} ${active}` },
          )
        : null,
    ],
  );

  const line = row([left, middle, right]);
  // Same shape the setup checklist uses: the bar belongs to the row doing the
  // work, so nothing has to say which component it is measuring. A `quiet` step
  // has no transfer behind it and says so on the Install button instead.
  if (!loud) return line;
  return h("div", { style: "display:flex;flex-direction:column;min-width:0" }, [
    line,
    progress(loud.pct),
  ]);
}
