// Package managers for one Node install: npm, pnpm, Yarn and Bun.
//
// Opened from the Node row rather than living on the dashboard, for the same
// reason the PHP configuration moved: this list is a property of a SPECIFIC
// Node. Corepack enables pnpm and Yarn against one version's shims, so the
// answer to "is pnpm available" is different per Node, and a permanent panel
// under a dropdown makes that look like one global fact.
//
// Three of these are not installed by this extension and the dialog says so
// plainly, because "where did this come from" is a fair question when a tool
// appears on your PATH. npm arrives inside Node, pnpm and Yarn are switched on
// through Corepack, and Bun is whatever you installed yourself.

import { h, row, muted, pill, button, status, mark, modal, dropdown } from "./el.js";
import { markFor } from "./marks.js";
import { survey, enablePackager } from "../manager/packagers.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import { ctx } from "../runtime.js";

/**
 * @param {string | null} nodeVersion  Which Node to survey; null means the default.
 * @param {() => void} refreshPane
 * @returns {void}
 */
export function openPackagers(nodeVersion, refreshPane) {
  const installed = installedOf("node");
  let current =
    nodeVersion && installed.some((v) => v.version === nodeVersion)
      ? nodeVersion
      : (activeVersion("node") ?? installed[0]?.version ?? null);

  const body = h("div", {
    style: "display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0",
  });

  const picker = dropdown(
    installed.map((v) => ({
      value: v.version,
      label: `Node ${v.version}`,
      hint: v.origin === "system" ? "system" : undefined,
    })),
    current,
    (value) => {
      current = value;
      void draw();
    },
    { full: true },
  );

  const draw = async () => {
    const rows = await survey(current);
    body.replaceChildren(...rows.map((p) => packagerRow(p, current, draw)));
    refreshPane();
  };

  modal({
    title: h("span", { style: "display:flex;align-items:center;gap:8px" }, [
      mark(markFor("node"), 17),
      h("strong", {
        text: "Package managers",
        style: "font-size:15px;font-weight:500;line-height:1",
      }),
    ]),
    description:
      "Corepack enables pnpm and Yarn per Node version, so this list belongs to one install.",
    body: h("div", { style: "display:flex;flex-direction:column;gap:12px;min-height:0" }, [
      picker,
      body,
    ]),
    width: "min(560px,100%)",
  });

  void draw();
}

/**
 * @param {import("../manager/packagers.js").PackagerStatus} p
 * @param {string | null} nodeVersion
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function packagerRow(p, nodeVersion, refresh) {
  return row([
    mark(markFor(p.id)),
    status(p.available ? "ok" : "idle"),
    h("span", { text: p.label, style: "font-size:12px;font-weight:600;min-width:58px" }),
    p.version ? pill(p.version) : null,
    muted(originLabel(p)),
    h("div", { style: "flex:1" }),
    p.canEnable
      ? button(
          "Enable",
          async () => {
            try {
              await enablePackager(p.id, nodeVersion);
              ctx?.ui.toast(`${p.label} enabled for Node ${nodeVersion ?? "(default)"}.`, {
                variant: "success",
              });
            } catch (err) {
              ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
            }
            refresh();
          },
          { variant: "primary" },
        )
      : null,
  ]);
}

/**
 * Where this package manager came from, in words rather than a jargon tag.
 * @param {import("../manager/packagers.js").PackagerStatus} p
 * @returns {string}
 */
function originLabel(p) {
  if (!p.available) {
    return p.origin === "corepack"
      ? "Not enabled. Corepack can turn it on for this Node."
      : "Not found on this machine.";
  }
  switch (p.origin) {
    case "bundled":
      return "ships with Node";
    case "corepack":
      return "enabled through Corepack";
    default:
      return "your own install, found on PATH";
  }
}
