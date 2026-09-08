// The settings that have nowhere better to live.
//
// This pane is where the environment is operated, so a setting belongs to the
// thing it changes: the root folder is the first setup step, which web server
// serves is "Use this" on its own row, and the ports and the HTTPS switch are
// the fields beside them. Splitting those between here and TEDI's Settings
// would have meant two places to look for one decision, and the second one
// cannot show you whether the port is currently bound.
//
// What is left is the two that describe every project rather than any one
// component. They are a DIALOG off the header rather than a section at the
// bottom: a pane you scroll past the runtimes, the services and every project
// to reach is a pane whose last screenful is furniture, and these are changed
// about twice a year.

import { h, row, muted, modal, button, checkbox, input } from "./el.js";
import { writeSetting } from "../manager/config.js";
import { publish } from "../web/publish.js";
import { paths } from "../core/paths.js";
import { config, ctx } from "../runtime.js";

/**
 * Open the settings dialog.
 *
 * Every field commits on its own, the way the rows in the pane do - there is no
 * Save, because there is nothing to cancel back to. The button just closes it.
 *
 * @param {() => void} refresh
 * @returns {void}
 */
export function openSettings(refresh) {
  // Each field republishes, so re-rendering the dialog in place would rebuild
  // the input the user is still standing in. It closes instead: one change is
  // what this dialog is opened for.
  const dialog = modal({
    title: "Settings",
    description: `This environment lives in ${paths.root()}.`,
    body: h("div", { style: "display:flex;flex-direction:column;gap:2px" }, [
      suffixRow(refresh),
      hostsRow(refresh),
    ]),
    footer: h("div", { style: "display:flex;justify-content:flex-end" }, [
      button("Done", () => dialog.close(), { variant: "primary" }),
    ]),
    width: "min(30rem,100%)",
  });
}

/**
 * The suffix every project's domain gets.
 *
 * Changing it renames every generated virtual host, so it republishes: the
 * alternative is a list of project URLs that describe a `.test` the server no
 * longer answers to.
 *
 * @param {() => void} refresh @returns {HTMLElement}
 */
function suffixRow(refresh) {
  const field = input(
    config.domainSuffix,
    async (value) => {
      // `setConfig` strips a leading dot and anything that is not a hostname
      // character, so what is stored is always usable; showing the cleaned
      // value back is what the repaint is for.
      const next = value.trim().replace(/^\.+/, "");
      if (!next) {
        ctx?.ui.toast("A domain suffix cannot be empty.", { variant: "error" });
        refresh();
        return;
      }
      await writeSetting("domainSuffix", next);
      await publish().catch(() => {});
      refresh();
    },
    "test",
  );
  field.style.width = "120px";
  field.setAttribute("aria-label", "Domain suffix");

  return row([
    label(
      "Domain suffix",
      `Every project is served at name.${config.domainSuffix || "test"} unless it sets its own.`,
    ),
    h("div", { style: "flex:1" }),
    field,
  ]);
}

/**
 * Whether the hosts file is written at all.
 *
 * Off is a real choice, not a way to break things: people running dnsmasq, a
 * wildcard resolver or their own hosts management want the vhosts and the
 * certificates without a second thing editing that file under an administrator
 * prompt. The block is delimited and only ever rewritten between its markers,
 * so turning this off leaves whatever is already there alone.
 *
 * @param {() => void} refresh @returns {HTMLElement}
 */
function hostsRow(refresh) {
  const on = config.manageHosts;
  const box = checkbox(on);
  box.addEventListener("click", async () => {
    await writeSetting("manageHosts", !on);
    if (!on) await publish().catch(() => {});
    refresh();
  });

  return row([
    label(
      "Write the hosts file",
      on
        ? "Adding a project points its domain at 127.0.0.1, under one administrator prompt."
        : "Off: the virtual hosts and certificates are still written, but the domains are yours to resolve.",
    ),
    h("div", { style: "flex:1" }),
    box,
  ]);
}

/** The same two-line left column every row in this pane uses.
 *  @param {string} title @param {string} note @returns {HTMLElement} */
function label(title, note) {
  return h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
    h("span", { text: title, style: "font-size:12px;font-weight:600;line-height:1.35" }),
    muted(note),
  ]);
}
