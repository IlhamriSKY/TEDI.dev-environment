// The Services section: the web server and the databases.
//
// A service row shows the one thing that actually matters when something is
// wrong - its state, and if it failed, WHY - rather than hiding the error
// behind a red dot the user has to hunt for in a log file. The error string
// from `start()` is put on screen verbatim, because "Port 80 is already in use
// by something else" is a sentence a person can act on and "failed to start"
// is not.

import { h, row, pill, muted, button, dot, section, mark } from "./el.js";
import { markFor } from "./marks.js";
import { provider } from "../registry/index.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import { SERVICE_IDS, start, stop, restart, runningPhpPools } from "../manager/services.js";
import { defaultPortFor } from "../web/ports.js";
import { state, config, ctx } from "../runtime.js";

/**
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
export function servicesView(refresh) {
  const rows = SERVICE_IDS
    // Only the web server the user chose. Showing both invites starting two
    // servers that would then fight over port 80.
    .filter((id) => (id === "nginx" || id === "apache" ? id === config.webServer : true))
    .map((id) => serviceRow(id, refresh));

  const pools = runningPhpPools();
  const aside = muted(pools.length ? `PHP FastCGI: ${pools.join(", ")}` : "No PHP worker running");

  return section("Services", rows, aside);
}

/**
 * @param {string} id @param {() => void} refresh
 * @returns {HTMLElement}
 */
function serviceRow(id, refresh) {
  const p = provider(id);
  const status = state.services.get(id);
  const installed = installedOf(id);
  const version = status?.version ?? activeVersion(id) ?? installed[0]?.version ?? null;
  const running = status?.state === "running";
  const starting = status?.state === "starting";
  const failed = status?.state === "error";
  const logo = markFor(id);

  const stateLabel = running ? "running" : starting ? "starting" : failed ? "failed" : "stopped";

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;min-width:170px;flex:none" },
    [
      mark(logo),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        h("span", {
          text: p?.label ?? id,
          style: "font-size:12px;font-weight:600;line-height:1.35",
        }),
        h("span", { style: "display:flex;align-items:center;gap:5px" }, [
          dot(running ? "ok" : failed ? "error" : starting ? "warn" : "idle"),
          muted(installed.length ? stateLabel : "not installed"),
        ]),
      ]),
    ],
  );

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap" },
    [
      version ? pill(version) : null,
      pill(`:${status?.port ?? defaultPortFor(id)}`),
      failed && status?.error
        ? h("span", {
            text: status.error,
            style: "color:var(--destructive);font-size:11px;line-height:1.4",
          })
        : null,
    ],
  );

  const disabled = installed.length === 0;
  const right = h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
    running
      ? button("Stop", async () => {
          await stop(id);
          refresh();
        })
      : button(
          "Start",
          async () => {
            const s = await start(id);
            if (s.state === "error" && s.error) ctx?.ui.toast(s.error, { variant: "error" });
            refresh();
          },
          { variant: "primary", disabled },
        ),
    running
      ? button("Restart", async () => {
          await restart(id);
          refresh();
        })
      : null,
  ]);

  return row([left, middle, right]);
}
