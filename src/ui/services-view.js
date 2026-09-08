// The Services section: the web server and the databases.
//
// A service row shows the one thing that actually matters when something is
// wrong - its state, and if it failed, WHY - rather than hiding the error
// behind a red dot the user has to hunt for in a log file. The error string
// from `start()` is put on screen verbatim, because "Port 80 is already in use
// by something else" is a sentence a person can act on and "failed to start"
// is not.

import { h, row, pill, muted, button, status, section, mark } from "./el.js";
import { markFor } from "./marks.js";
import { provider } from "../registry/index.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import {
  SERVICE_IDS,
  IN_PROCESS,
  start,
  stop,
  restart,
  runningPhpPools,
} from "../manager/services.js";
import { listJobs, runningCount } from "../manager/cron.js";
import { plannedPort, isWebServer } from "../web/ports.js";
import { state, config, ctx } from "../runtime.js";

/**
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
export function servicesView(refresh) {
  const rows = SERVICE_IDS
    // The chosen web server always, and the other one when it is installed.
    //
    // It used to be the chosen one only, because showing both invited starting
    // two servers that would fight over port 80. They cannot any more: the
    // second one binds a fixed offset (see `ports.serverPorts`), writes its own
    // vhost tree, and runs alongside. Hiding an installed server is the worse
    // half of that trade - a download with no row is indistinguishable from one
    // that failed.
    .filter((id) => !isWebServer(id) || id === config.webServer || installedOf(id).length > 0)
    .map((id) => serviceRow(id, refresh));

  const pools = runningPhpPools();
  const aside = muted(pools.length ? `PHP FastCGI: ${pools.join(", ")}` : "No PHP worker running");

  return section("Services", rows, aside);
}

/** Display names for services that are not registry providers. */
const LABELS = /** @type {Record<string, string>} */ ({ cron: "Cron" });

/** One line about the scheduler's contents, for its row.
 *  @returns {string} */
function jobSummary() {
  const total = listJobs().length;
  const active = runningCount();
  const jobs = `${total} job${total === 1 ? "" : "s"}`;
  return active ? `${jobs}, ${active} running` : jobs;
}

/**
 * @param {string} id @param {() => void} refresh
 * @returns {HTMLElement}
 */
function serviceRow(id, refresh) {
  const p = provider(id);
  const st = state.services.get(id);
  // An in-process service has nothing on disk, so it counts as always present:
  // the version pill, the "not installed" caption and the disabled Start button
  // are all questions about a binary it does not have.
  const inProcess = IN_PROCESS.has(id);
  const installed = installedOf(id);
  const present = inProcess || installed.length > 0;
  const version = inProcess
    ? null
    : (st?.version ?? activeVersion(id) ?? installed[0]?.version ?? null);
  const running = st?.state === "running";
  const starting = st?.state === "starting";
  const failed = st?.state === "error";
  const logo = markFor(id);

  const stateLabel = running ? "running" : starting ? "starting" : failed ? "failed" : "stopped";

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;min-width:170px;flex:none" },
    [
      mark(logo),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        h("span", {
          text: p?.label ?? LABELS[id] ?? id,
          style: "font-size:12px;font-weight:600;line-height:1.35",
        }),
        h("span", { style: "display:flex;align-items:center;gap:5px" }, [
          status(running ? "ok" : failed ? "error" : starting ? "working" : "idle"),
          muted(present ? stateLabel : "not installed"),
        ]),
      ]),
    ],
  );

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap" },
    [
      version ? pill(version) : null,
      // A port, for the things that bind one. The scheduler does not, and a
      // pill reading `:8000` beside it would be an invented fact.
      inProcess ? null : pill(`:${st?.port ?? plannedPort(id)}`),
      // What the scheduler is actually carrying, which is the only thing about
      // it worth a glance: how many jobs, and whether any is running now.
      inProcess ? pill(jobSummary()) : null,
      // Which web server the projects' URLs point at. Only worth saying when
      // there are two rows that could answer.
      isWebServer(id) && installedOf(id === "nginx" ? "apache" : "nginx").length > 0
        ? pill(id === config.webServer ? "default" : "alternate")
        : null,
      failed && st?.error
        ? h("span", {
            text: st.error,
            style: "color:var(--destructive);font-size:11px;line-height:1.4",
          })
        : null,
    ],
  );

  const disabled = !present;
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
