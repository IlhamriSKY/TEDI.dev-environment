// The Services section: the web server and the databases.
//
// A service row shows the one thing that actually matters when something is
// wrong - its state, and if it failed, WHY - rather than hiding the error
// behind a red dot the user has to hunt for in a log file. The error string
// from `start()` is put on screen verbatim, because "Port 80 is already in use
// by something else" is a sentence a person can act on and "failed to start"
// is not.

import {
  h,
  row,
  pill,
  muted,
  button,
  status,
  section,
  mark,
  progress,
  input,
  dropdown,
  checkbox,
} from "./el.js";
import { markFor } from "./marks.js";
import { provider } from "../registry/index.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion, setActiveVersion } from "../manager/config.js";
import {
  SERVICE_IDS,
  IN_PROCESS,
  start,
  stop,
  restart,
  startAll,
  stopAll,
  runningPhpPools,
} from "../manager/services.js";
import { listJobs, runningCount } from "../manager/cron.js";
import { plannedPort, defaultPortFor, isWebServer } from "../web/ports.js";
import { setServicePort, writeSetting } from "../manager/config.js";
import { publishHandoff } from "../manager/handoff.js";
import { publish } from "../web/publish.js";
import { openCron } from "./cron-view.js";
import { openInstaller } from "./version-picker.js";
import { applyRuntimeChange } from "../manager/apply.js";
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
  // The run controls live HERE now, not in the pane header. They act on this
  // section and nothing else, and a header button that starts five processes
  // two sections away is a button whose effect you have to remember rather than
  // see.
  const aside = h("div", { style: "display:flex;align-items:center;gap:6px" }, [
    muted(pools.length ? `PHP FastCGI: ${pools.join(", ")}` : "No PHP worker running"),
    button(
      "Start all",
      async () => {
        await startAll();
        refresh();
      },
      { variant: "success", icon: "lucide:Play" },
    ),
    button(
      "Stop all",
      async () => {
        await stopAll();
        refresh();
      },
      { variant: "danger", icon: "lucide:Square" },
    ),
  ]);

  return section("Services", rows, aside);
}

/**
 * Which installed version this service runs.
 *
 * The same control the runtime rows have, for the same reason: switching is
 * instant and installing is a download, so they are two controls rather than
 * one that sometimes takes four minutes. Switching a web server's version also
 * decides which install its generated config points at, which is why that case
 * republishes.
 *
 * @param {string} id
 * @param {import("../runtime.js").InstalledVersion[]} installed
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function versionPicker(id, installed, refresh) {
  if (installed.length === 0) return muted("not installed");
  const active = activeVersion(id) ?? installed[0]?.version ?? null;
  return dropdown(
    installed.map((v) => ({
      value: v.version,
      label: v.version,
      hint: v.origin === "system" ? "system" : undefined,
    })),
    active,
    async (version) => {
      await setActiveVersion(id, version);
      await applyRuntimeChange();
      if (isWebServer(id)) await publish().catch(() => {});
      refresh();
    },
    { width: "112px" },
  );
}

/**
 * Point the project URLs at this web server.
 *
 * If the other one is up this hands over, rather than leaving the URLs
 * describing a server that is not the one answering: `start` stops the other,
 * so "use this" means it.
 *
 * @param {string} id @param {() => void} refresh @returns {Promise<void>}
 */
async function useWebServer(id, refresh) {
  const other = id === "nginx" ? "apache" : "nginx";
  const wasRunning = state.services.get(other)?.state === "running";
  await writeSetting("webServer", id);
  await publish().catch(() => {});
  if (wasRunning) {
    const s = await start(id);
    if (s.state === "error" && s.error) ctx?.ui.toast(s.error, { variant: "error" });
  }
  refresh();
}

/**
 * The ports this service binds.
 *
 * A web server has TWO, and the second can be switched off. Plenty of local
 * work never touches HTTPS, and a certificate per project plus a CA trusted
 * into the machine's store is a real cost for something unused. The switch is
 * `autoHttps`, so turning it off
 * drops the SSL block from every vhost and stops issuing certificates.
 *
 * @param {string} id
 * @param {import("../runtime.js").ServiceStatus | undefined} st
 * @param {boolean} live
 * @param {() => void} refresh
 * @returns {(HTMLElement | null)[]}
 */
function portControls(id, st, live, refresh) {
  if (!isWebServer(id)) return [portControl(id, st, live, refresh)];

  const https = config.autoHttps;
  const box = checkbox(https);
  box.addEventListener("click", async () => {
    await writeSetting("autoHttps", !https);
    await publish().catch(() => {});
    refresh();
  });

  return [
    labelled("http", portControl(id, st, live, refresh)),
    // The tick is the switch, and the field beside it exists only while it is
    // on: a port for a protocol that is off would be a number with nothing
    // behind it.
    h(
      "label",
      {
        style: "display:inline-flex;align-items:center;gap:5px;cursor:pointer",
        title: https
          ? "Serving HTTPS too, with a certificate per project from the local CA."
          : "HTTPS is off: no certificates are issued and the vhosts carry no SSL block.",
      },
      [box, muted("https"), https ? httpsPortField(live, refresh) : muted("off")],
    ),
  ];
}

/** @param {string} text @param {HTMLElement} control @returns {HTMLElement} */
function labelled(text, control) {
  return h("span", { style: "display:inline-flex;align-items:center;gap:5px" }, [
    muted(text),
    control,
  ]);
}

/** The HTTPS port, a setting exactly like the HTTP one.
 *  @param {boolean} live @param {() => void} refresh @returns {HTMLElement} */
function httpsPortField(live, refresh) {
  if (live) return pill(":" + config.httpsPort, { title: "The HTTPS port it is bound to" });
  const field = input(
    String(config.httpsPort),
    async (value) => {
      const next = Number(value.trim());
      if (!Number.isInteger(next) || next < 1 || next > 65535) {
        ctx?.ui.toast(value.trim() + " is not a port. Use 1 to 65535.", { variant: "error" });
        refresh();
        return;
      }
      await writeSetting("httpsPort", next);
      await publish().catch(() => {});
      refresh();
    },
    "443",
  );
  field.style.width = "64px";
  field.style.textAlign = "center";
  field.setAttribute("aria-label", "HTTPS port");
  return field;
}

/**
 * The port, as a pill while it is bound and a field while it is not.
 *
 * A web server writes `httpPort`, the real setting, because that number is in
 * every project URL and there has to be exactly one of it. Everything else
 * writes a per-service pin in `config.json`, which also tells `choosePort`
 * never to move it: a port somebody typed was typed because something is
 * pointing at it.
 *
 * Blank clears the pin and goes back to the conventional default, which is a
 * way back that costs no second control.
 *
 * @param {string} id
 * @param {import("../runtime.js").ServiceStatus | undefined} st
 * @param {boolean} live  Running or starting: the port is a fact, not a request.
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function portControl(id, st, live, refresh) {
  const planned = plannedPort(id);
  if (live) return pill(`:${st?.port ?? planned}`, { title: "The port it is bound to" });

  const field = input(
    String(planned),
    async (value) => {
      const text = value.trim();
      const next = text === "" ? null : Number(text);
      if (next !== null && (!Number.isInteger(next) || next < 1 || next > 65535)) {
        ctx?.ui.toast(`${text} is not a port. Use 1 to 65535, or leave it blank for the default.`, {
          variant: "error",
        });
        refresh();
        return;
      }
      if (isWebServer(id)) await writeSetting("httpPort", next ?? 80);
      else await setServicePort(id, next);
      // A generated vhost carries the web server's port in its `listen` lines,
      // so a port change is a republish and not just a stored number.
      await publish().catch(() => {});
      // And a database's port is in the connection another extension was
      // handed, so that is a republish too.
      await publishHandoff();
      refresh();
    },
    String(defaultPortFor(id)),
  );
  field.style.width = "72px";
  field.style.textAlign = "center";
  field.setAttribute("aria-label", `Port for ${id}`);
  return field;
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
  // Downloading right now. Servers and databases have no row in Runtimes - that
  // section is runtimes and tools - so this is the only row that can carry
  // their progress, and without it "Install everything" pulling nginx showed
  // nothing anywhere once the setup gate was down.
  const busy = state.busy.get(id);
  // An in-process service has nothing on disk, so it counts as always present:
  // the version pill, the "not installed" caption and the disabled Start button
  // are all questions about a binary it does not have.
  const inProcess = IN_PROCESS.has(id);
  const installed = installedOf(id);
  const present = inProcess || installed.length > 0;
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
          status(
            busy ? "working" : running ? "ok" : failed ? "error" : starting ? "working" : "idle",
          ),
          muted(
            busy
              ? `${busy.text}${busy.pct === undefined ? "" : ` ${busy.pct}%`}`
              : present
                ? stateLabel
                : "not installed",
          ),
        ]),
      ]),
    ],
  );

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap" },
    [
      // Every service is a versioned download like PHP and Node, so it gets the
      // same control: switch what is installed, install another. Only the
      // scheduler has no version, because it is a timer in this extension.
      inProcess ? null : versionPicker(id, installed, refresh),
      // A port, for the things that bind one - and while the service is
      // stopped, the port is a FIELD rather than a label. Changing it is the
      // common reason someone opens this pane: something on the machine already
      // has 3306, or 80. A running service keeps a pill, because that number is
      // a fact about a bound socket and not a request. The scheduler binds
      // nothing, and a pill reading `:8000` beside it would be an invented fact.
      ...(inProcess ? [] : portControls(id, st, running || starting, refresh)),
      // What the scheduler is actually carrying, which is the only thing about
      // it worth a glance: how many jobs, and whether any is running now.
      inProcess ? pill(jobSummary()) : null,
      // Which web server the projects' URLs point at, and therefore which one
      // "Start all" brings up. Only worth saying when the other is installed
      // too, because only then is a choice being made.
      isWebServer(id) && installedOf(id === "nginx" ? "apache" : "nginx").length > 0
        ? id === config.webServer
          ? pill("default", {
              icon: "lucide:CircleCheck",
              title: "Your project URLs point at this one, and Start all brings it up.",
            })
          : button("Use this", () => void useWebServer(id, refresh), {
              title:
                "Point the project URLs at this server. Only one runs at a time, so a running default is handed over.",
            })
        : null,
      failed && st?.error
        ? h("span", {
            text: st.error,
            style: "color:var(--destructive);font-size:11px;line-height:1.4",
          })
        : null,
    ],
  );

  // Nothing to press while its own archive is still coming down.
  const disabled = !present || Boolean(busy);
  const right = h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
    // The scheduler's contents open FROM its row, like php.ini opens from the
    // PHP row: a list you go and work on rather than a state you watch, and one
    // that does not belong under the two things this pane exists to show.
    inProcess
      ? null
      : button("Install", () => p && void openInstaller(p, refresh), {
          icon: "lucide:Download",
          disabled: Boolean(busy),
          spin: busy?.quiet,
          title: busy?.quiet ? busy.text : "Install another " + (p?.label ?? id) + " version",
        }),
    inProcess
      ? button("Jobs", () => openCron(refresh), {
          icon: "lucide:CalendarClock",
          title: "Add, edit and run the scheduled jobs",
        })
      : null,
    running
      ? button(
          "Stop",
          async () => {
            await stop(id);
            refresh();
          },
          { variant: "danger", icon: "lucide:Square" },
        )
      : button(
          "Start",
          async () => {
            const s = await start(id);
            if (s.state === "error" && s.error) ctx?.ui.toast(s.error, { variant: "error" });
            refresh();
          },
          { variant: "success", icon: "lucide:Play", disabled },
        ),
    running
      ? button(
          "Restart",
          async () => {
            await restart(id);
            refresh();
          },
          // Amber: it stops the thing before it starts it, which is neither of
          // the other two answers.
          { variant: "warn", icon: "lucide:RotateCw" },
        )
      : null,
  ]);

  const line = row([left, middle, right]);
  // Same shape the setup checklist and the runtime rows use: the bar belongs to
  // the row doing the work, so nothing has to say which one it is measuring. A
  // `quiet` step has no transfer behind it and spins the Install icon instead.
  if (!busy || busy.quiet) return line;
  return h("div", { style: "display:flex;flex-direction:column;min-width:0" }, [
    line,
    progress(busy.pct),
  ]);
}
