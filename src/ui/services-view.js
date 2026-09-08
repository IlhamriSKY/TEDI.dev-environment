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
  modal,
  confirm,
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
import {
  setServicePort,
  writeSetting,
  startsWithAll,
  setStartsWithAll,
} from "../manager/config.js";
import { publishHandoff } from "../manager/handoff.js";
import { freePort } from "../web/portowner.js";
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
      // Same reason as every other publish in this view: see `useWebServer`.
      if (isWebServer(id)) await publish({ hosts: false }).catch(() => {});
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
  // `hosts: false`. Which server serves is not something the hosts file
  // records - it holds project domains pointed at 127.0.0.1, and both servers
  // answer on the same address. Publishing WITH the sync meant switching from
  // Apache to nginx could raise an administrator prompt, which is a frightening
  // thing to be asked for ticking a box.
  await publish({ hosts: false }).catch(() => {});
  if (wasRunning) {
    const s = await start(id);
    if (s.state === "error" && s.error) ctx?.ui.toast(s.error, { variant: "error" });
  }
  refresh();
}

/**
 * Whether "Start all" includes this service.
 *
 * MySQL and PostgreSQL run side by side perfectly happily, which is exactly why
 * this is needed: "Start all" started every database that was installed, so
 * anyone who had tried both ended up with a second one running and holding its
 * port every time they pressed it. Absent means yes, so nothing changes for an
 * environment that never touches this.
 *
 * @param {string} id @param {() => void} refresh @returns {HTMLElement}
 */
function rowTick(id, refresh) {
  const web = isWebServer(id);
  // A web server's tick is which one, not whether: nginx and apache cannot both
  // hold port 80, so ticking one unticks the other and there is no state where
  // neither is chosen. Everything else is an independent yes or no.
  const on = web ? id === config.webServer : startsWithAll(id);

  const box = checkbox(on);
  box.addEventListener("click", async () => {
    // Already the default. Unticking it would leave no web server at all, which
    // is not a state the projects can be served from.
    if (web && on) return;
    if (web) await useWebServer(id, refresh);
    else {
      await setStartsWithAll(id, !on);
      refresh();
    }
  });

  const title = web
    ? on
      ? "The project URLs point here, and Start all brings this one up. Tick the other to switch."
      : "Point the project URLs at this server and start it instead. Only one runs at a time, so a running default is handed over."
    : on
      ? "Start all brings this up. Untick to leave it out."
      : "Start all skips this. Its own Start button still works.";

  // Wrapped rather than titled directly: `h` is what routes a `title` through
  // the pane's own tooltip, and `checkbox` builds its node itself.
  return h(
    "label",
    {
      title,
      style: `display:inline-flex;align-items:center;flex:none;cursor:${web && on ? "default" : "pointer"}`,
      attrs: { "aria-label": web ? `Serve with ${id}` : `Start all includes ${id}` },
    },
    [box],
  );
}

/**
 * Stop whatever is holding the port, then start this service.
 *
 * Behind a confirmation naming the process and its pid, because it ends
 * somebody's program - possibly one they meant to be running. The button only
 * exists when the OS told us what that program is, so the dialog can always say
 * what is about to be stopped.
 *
 * @param {string} id
 * @param {{ port: number, pid: number, name: string }} conflict
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function freeButton(id, conflict, refresh) {
  return button(
    `Stop ${conflict.name}`,
    async () => {
      const ok = await confirm({
        title: `Stop ${conflict.name}?`,
        description:
          `Process ${conflict.pid} is listening on port ${conflict.port}. Stopping it frees the ` +
          `port so ${provider(id)?.label ?? id} can bind, and ends whatever that program was doing.`,
        confirmLabel: "Stop it",
        icon: "lucide:CircleStop",
      });
      if (!ok) return;
      const res = await freePort(conflict, conflict.port);
      if (!res.ok) {
        ctx?.ui.toast(res.message ?? `Port ${conflict.port} is still in use.`, {
          variant: "error",
        });
        refresh();
        return;
      }
      // Freed it because this service wanted it, so try again rather than
      // making the user press Start as a second step.
      const s = await start(id);
      if (s.state === "error" && s.error) ctx?.ui.toast(s.error, { variant: "error" });
      refresh();
    },
    {
      variant: "danger",
      icon: "lucide:CircleStop",
      title: `Stop pid ${conflict.pid} and start ${provider(id)?.label ?? id} on port ${conflict.port}`,
    },
  );
}

/**
 * The port, or ports, as read-only facts.
 *
 * A pill once something is bound, because then the number describes a socket;
 * muted text before that, because then it is only what will be tried. Both are
 * the same width of information, which is the point - the row does not change
 * shape when a service starts.
 *
 * @param {string} id
 * @param {import("../runtime.js").ServiceStatus | undefined} st
 * @param {boolean} live
 * @returns {HTMLElement[]}
 */
function portPills(id, st, live) {
  const shown = (/** @type {number} */ n, /** @type {string} */ title) =>
    live
      ? pill(`:${n}`, { title })
      : h("span", { text: `:${n}`, title, style: "font-size:11px;color:var(--muted-foreground)" });

  if (!isWebServer(id)) {
    return [
      shown(st?.port ?? plannedPort(id), live ? "The port it is bound to" : "The port it will try"),
    ];
  }
  const out = [shown(config.httpPort, "HTTP")];
  if (config.autoHttps) out.push(shown(config.httpsPort, "HTTPS, with a certificate per project"));
  else out.push(muted("no https"));
  return out;
}

/**
 * Everything about this service that is a setting rather than a state.
 *
 * A dialog because it is a FORM: a web server has three fields and a switch,
 * and having them inline meant every service row carried a form whether or not
 * anyone was filling it in. Each field commits on its own like the rest of the
 * pane, so there is no Save and nothing to cancel back to.
 *
 * @param {string} id @returns {void}
 */
function openServiceSettings(id) {
  const p = provider(id);
  const live = ["running", "starting"].includes(state.services.get(id)?.state ?? "");
  // Each commit republishes and re-renders the pane behind the dialog, which
  // would rebuild the field the user is standing in. It closes instead.
  /** @type {{ close: () => void }} */
  let dialog;
  const done = () => dialog.close();

  const rows = isWebServer(id)
    ? [
        settingRow(
          "HTTP port",
          "Where the project URLs point. 80 is the default, and binding it needs administrator rights on some systems.",
          live ? pill(`:${config.httpPort}`) : webPortField("httpPort", 80, done),
        ),
        settingRow(
          "HTTPS",
          config.autoHttps
            ? "Every project also gets a certificate from the local CA, and its vhost carries an SSL block."
            : "Off: no certificates are issued and no vhost carries an SSL block. Plenty of local work never needs it.",
          httpsSwitch(done),
        ),
        config.autoHttps
          ? settingRow(
              "HTTPS port",
              "443 is the default.",
              live ? pill(`:${config.httpsPort}`) : webPortField("httpsPort", 443, done),
            )
          : null,
      ]
    : [
        settingRow(
          "Port",
          `Blank uses ${defaultPortFor(id)}. A port you type is never moved out from under you: if something else has it, this says so rather than landing on the next one along.`,
          live
            ? pill(`:${state.services.get(id)?.port ?? plannedPort(id)}`)
            : servicePortField(id, done),
        ),
      ];

  dialog = modal({
    title: `${p?.label ?? id} settings`,
    description: live
      ? "Running, so its ports are shown as bound rather than offered for editing. Stop it to change them."
      : undefined,
    body: h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rows),
    footer: h("div", { style: "display:flex;justify-content:flex-end" }, [
      button("Done", () => dialog.close(), { variant: "primary" }),
    ]),
    width: "min(30rem,100%)",
  });
}

/** One labelled setting, the shape the Settings dialog uses.
 *  @param {string} title @param {string} note @param {Node | null} control
 *  @returns {HTMLElement} */
function settingRow(title, note, control) {
  return row([
    h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
      h("span", { text: title, style: "font-size:12px;font-weight:600;line-height:1.35" }),
      muted(note),
    ]),
    h("div", { style: "flex:1" }),
    control,
  ]);
}

/** The HTTPS switch. Off means no certificate is issued at all, which is why it
 *  republishes rather than only storing a flag.
 *  @param {() => void} done @returns {HTMLElement} */
function httpsSwitch(done) {
  const on = config.autoHttps;
  const box = checkbox(on);
  box.setAttribute("aria-label", "Serve HTTPS");
  box.addEventListener("click", async () => {
    await writeSetting("autoHttps", !on);
    // No domain changes when HTTPS goes off; only the vhosts do.
    await publish({ hosts: false }).catch(() => {});
    done();
  });
  return box;
}

/** A web server port, which is a real setting because it appears in every
 *  project URL.
 *  @param {"httpPort" | "httpsPort"} key @param {number} fallback
 *  @param {() => void} done @returns {HTMLElement} */
function webPortField(key, fallback, done) {
  return portField(String(config[key]), String(fallback), async (next) => {
    await writeSetting(key, next ?? fallback);
    // A port lives in the vhost, never in the hosts file.
    await publish({ hosts: false }).catch(() => {});
    done();
  });
}

/** A database or cache port, stored per service rather than as a setting.
 *  @param {string} id @param {() => void} done @returns {HTMLElement} */
function servicePortField(id, done) {
  return portField(String(plannedPort(id)), String(defaultPortFor(id)), async (next) => {
    await setServicePort(id, next);
    await publishHandoff();
    done();
  });
}

/**
 * A port input that refuses anything that is not one.
 *
 * `null` for blank, which every caller reads as "the conventional default" -
 * so clearing the field is how you undo a pin, rather than having to remember
 * what the number used to be.
 *
 * @param {string} value @param {string} placeholder
 * @param {(next: number | null) => Promise<void>} commit
 * @returns {HTMLElement}
 */
function portField(value, placeholder, commit) {
  const field = input(
    value,
    async (raw) => {
      const text = raw.trim();
      const next = text === "" ? null : Number(text);
      if (next !== null && (!Number.isInteger(next) || next < 1 || next > 65535)) {
        ctx?.ui.toast(`${text} is not a port. Use 1 to 65535, or leave it blank for the default.`, {
          variant: "error",
        });
        return;
      }
      await commit(next);
    },
    placeholder,
  );
  field.style.width = "104px";
  field.style.textAlign = "center";
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
      // One tick per row, meaning the same thing everywhere: this is what
      // "Start all" brings up. On a web server it is exclusive, because the
      // ticked one is also the one the project URLs point at.
      rowTick(id, refresh),
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
      // The port as a FACT, not a field. Three inputs sat here - http, a
      // tick, https - which is a form, and a form belongs in a dialog rather
      // than wedged between a version dropdown and a Start button on every one
      // of six rows. The number is still worth a glance, so it stays; changing
      // it is behind the gear. The scheduler binds nothing, and a pill reading
      // `:8000` beside it would be an invented fact.
      ...(inProcess ? [] : portPills(id, st, running || starting)),
      // What the scheduler is actually carrying, which is the only thing about
      // it worth a glance: how many jobs, and whether any is running now.
      inProcess ? pill(jobSummary()) : null,
      // The tick on the left says which web server serves; a second control
      // saying the same thing was one to keep in agreement for nothing.

      failed && st?.error
        ? h("span", {
            text: st.error,
            style: "color:var(--destructive);font-size:11px;line-height:1.4",
          })
        : null,
      // The one error with an action behind it. Offered only when the OS
      // actually named the process: "stop whatever has port 80" is not
      // something anyone should be asked to press blind.
      st?.conflict ? freeButton(id, st.conflict, refresh) : null,
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
      : button("", () => openServiceSettings(id), {
          icon: "lucide:Settings2",
          title: `Port${isWebServer(id) ? "s and HTTPS" : ""} for ${p?.label ?? id}`,
        }),
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
          {
            variant: "success",
            icon: "lucide:Play",
            disabled: disabled || starting,
            spin: starting,
          },
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
