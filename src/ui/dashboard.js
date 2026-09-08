// The dashboard pane.
//
// `registerPanelRenderer` hands over a container and expects a cleanup
// function. Everything below builds plain DOM into it and re-renders wholesale
// on change: the panel is a few dozen nodes, a full rebuild is under a
// millisecond, and a diffing layer here would be more code than the entire UI.
//
// The Setup checklist at the top is the part that earns its place. Three things
// have to be true before any of this works - there is a folder to install into,
// the components are installed, and the shims are on TEDI's terminal PATH - and
// none of them is visible from anywhere else. Each is shown with its current
// state and the one control that fixes it, and until all three hold the rest of
// the panel is not drawn at all.

import { h, button, muted, section, row, pill, icon, status, progress } from "./el.js";
import { runtimesView } from "./runtimes-view.js";
import { servicesView } from "./services-view.js";
import { projectsView } from "./projects-view.js";
import { settingsView } from "./settings-view.js";
import { state, config, ctx } from "../runtime.js";
import { paths, layoutDirs } from "../core/paths.js";
import { ensureDirs, isDir } from "../core/fsx.js";
import { openFolder } from "../core/proc.js";
import { shimDir, writeShims } from "../project/shims.js";
import { scanInstalled, installedOf } from "../manager/versions.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { writeSetting, setSkipTerminalPath } from "../manager/config.js";
import { CROSS_PLATFORM } from "../manager/defaults.js";
import { installEverything } from "./install-all.js";
import { provider } from "../registry/index.js";
import { refreshStatuses } from "../manager/services.js";
import { httpsStatus } from "../web/certs.js";
import { needsRootToBind } from "../web/ports.js";
import { pathOnTerminal, pathInstruction, registerTerminalPath, canRegisterPath } from "./setup.js";

/**
 * Mount the dashboard into `container`.
 *
 * @param {HTMLElement} container
 * @returns {() => void} cleanup
 */
export function mountDashboard(container) {
  let disposed = false;

  const root = h("div", {
    style:
      "display:flex;flex-direction:column;gap:13px;padding:11px 13px;height:100%;overflow:auto;" +
      "background:var(--background);color:var(--foreground);" +
      "font-family:ui-sans-serif,system-ui,sans-serif",
  });
  container.append(root);

  // Every paint gets a token. The async sections below append when they
  // resolve, and a repaint that lands while one is in flight would otherwise
  // append it AFTER the new paint had already cleared the root - one duplicated
  // section per overlapping repaint, growing forever while the poll runs.
  let generation = 0;

  const render = () => {
    if (disposed) return;
    const token = ++generation;
    void paint(root, render, () => !disposed && token === generation);
  };

  state.views.add(render);
  render();

  // A first scan, so the panel is accurate rather than merely fast.
  void (async () => {
    await scanInstalled();
    await refreshStatuses();
    render();
  })();

  return () => {
    disposed = true;
    state.views.delete(render);
    root.remove();
  };
}

/**
 * @param {HTMLElement} root
 * @param {() => void} refresh
 * @param {() => boolean} current  False once a newer paint has superseded this one.
 * @returns {Promise<void>}
 */
async function paint(root, refresh, current) {
  // The setup checks read the hosts file and spawn `which mkcert`, a few
  // hundred milliseconds, and the gate below depends on the answer - so the
  // FIRST paint of a repaint keeps whatever is already on screen rather than
  // blanking the pane four times a minute while the poll runs.
  if (root.childElementCount === 0) root.append(muted("Checking this environment…"));

  const steps = await setupSteps(refresh);
  if (!current()) return;
  const blocked = steps.filter((s) => !s.note && !s.optional && !s.done);

  // Nothing else is drawn until setup is finished. Disabling every control
  // instead would leave a panel full of buttons that explain, one at a time,
  // that they cannot work yet; a single screen that says what is left is both
  // shorter to read and shorter to write.
  if (blocked.length > 0) {
    root.replaceChildren(header(false), setupCard(steps, blocked));
    return;
  }

  root.replaceChildren(
    header(true),
    section("Setup", steps.map(stepRow)),
    runtimesView(refresh),
    servicesView(refresh),
  );

  // Projects reads every project's config to resolve its runtime, so it is
  // appended when it resolves rather than holding the whole panel blank.
  const projects = await projectsView(refresh);
  if (!current()) return;
  root.append(projects, settingsView(refresh));
}

/**
 * The first-run screen: what is left, in order, with the button that does it.
 *
 * @param {Step[]} steps @param {Step[]} blocked @returns {HTMLElement}
 */
function setupCard(steps, blocked) {
  const done = steps.filter((s) => !s.note && s.done).length;
  const total = steps.filter((s) => !s.note).length;

  return h("div", { style: "display:flex;flex-direction:column;gap:10px" }, [
    h("div", { style: "display:flex;flex-direction:column;gap:3px" }, [
      h("strong", { text: "Finish setting up", style: "font-size:13px;font-weight:600" }),
      muted(
        `${done} of ${total} done. Runtimes, services and projects unlock once the required steps are complete.`,
      ),
    ]),
    // What went wrong at startup, if anything did. This is nearly always a root
    // folder the OS will not accept, and the step that fixes it is right below.
    state.startupError
      ? h(
          "div",
          {
            style:
              "display:flex;align-items:center;gap:7px;padding:7px 10px;" +
              "border:1px solid color-mix(in oklab,var(--destructive) 45%,transparent);" +
              "background:color-mix(in oklab,var(--destructive) 8%,transparent)",
          },
          [
            icon("lucide:TriangleAlert", "var(--destructive)"),
            muted(`This environment could not be prepared: ${state.startupError}`),
          ],
        )
      : null,
    ...steps.map(stepRow),
    muted(
      blocked.length === 1
        ? `Waiting on: ${blocked[0].title}.`
        : `Waiting on: ${blocked.map((s) => s.title).join(", ")}.`,
    ),
  ]);
}

/**
 * @typedef {object} Step
 * @property {string} title
 * @property {string} detail
 * @property {boolean} done
 * @property {string} icon
 * @property {boolean} [note]  A warning to read, not a step to finish: it never
 *                             blocks the panel and is never counted.
 * @property {boolean} [optional]  Still a step, still counted, but the panel
 *   opens without it. For a step whose answer is legitimately "no thanks".
 * @property {Node} [aside]    The control that completes it.
 * @property {Node} [tag]
 * @property {Node} [bar]      Progress, drawn flush under the row.
 */

/**
 * One setup step, in the same row the rest of the panel uses.
 *
 * A status glyph and an icon, exactly like a service row or a project row - not
 * a numbered badge. The panel already had a vocabulary for "here is a thing and
 * its state"; a checklist that invents its own is one more shape to learn for
 * no information gained.
 *
 * @param {Step} step @returns {HTMLElement}
 */
function stepRow(step) {
  const line = row([
    status(step.note ? "warn" : step.done ? "ok" : "idle"),
    icon(step.icon, step.done ? "var(--primary)" : "var(--muted-foreground)"),
    h("div", { style: "display:flex;flex-direction:column;gap:1px;flex:1;min-width:0" }, [
      h("span", { style: "display:flex;align-items:center;gap:6px" }, [
        h("span", { text: step.title, style: "font-size:12px;font-weight:600" }),
      ]),
      muted(step.detail),
    ]),
    step.tag ?? null,
    step.aside ?? null,
  ]);
  if (!step.bar) return line;
  // Flush under its own row rather than in a status area of its own, so which
  // step is working is answered by WHERE the bar is and needs no label.
  return h("div", { style: "display:flex;flex-direction:column;min-width:0" }, [line, step.bar]);
}

/**
 * The pane's own line: what this environment is, and where.
 *
 * No buttons. "Start all" and "Stop all" sit in the Services section now,
 * because that is what they act on - a header control that starts five
 * processes two sections down is one whose effect you have to remember rather
 * than see.
 *
 * "Apply changes" is gone rather than moved. It republished the vhosts, the
 * certificates and the hosts file by hand, and every path that changes what
 * those describe already does it: adding, removing, enabling or disabling a
 * project publishes, changing a port publishes, and starting a web server
 * regenerates its config first. What is left for it to fix is a hosts file
 * somebody edited themselves, which is not a button on a dashboard.
 *
 * @param {boolean} ready @returns {HTMLElement}
 */
function header(ready) {
  return h(
    "div",
    { style: "display:flex;align-items:center;justify-content:space-between;gap:10px" },
    [
      h("div", { style: "display:flex;flex-direction:column;gap:1px" }, [
        h("strong", { text: "Dev Environment", style: "font-size:13.5px" }),
        muted(
          ready
            ? `${config.webServer} · *.${config.domainSuffix} · ${paths.root()}`
            : "Not set up yet",
        ),
      ]),
      // Nothing on the right. "Start all" and "Stop all" moved into the
      // Services section, beside the rows they act on, and "Apply changes"
      // is gone entirely - see `header`'s note.
      null,
    ],
  );
}

/**
 * The one setup answer that costs a subprocess.
 *
 * `httpsStatus()` shells out to `mkcert -CAROOT`, and the panel repaints on
 * every user action as well as on a changed poll - so without this, starting a
 * service or toggling a project each spawned a process to re-answer a question
 * nothing had changed. During "install everything" it was far worse: progress
 * reports a new percentage up to a hundred times per component.
 *
 * Held in two cases, and both are safe because the answer cannot change while
 * they hold:
 *
 *   - while an install is running, because a download does not touch the trust
 *     store;
 *   - once the CA is TRUSTED, because trust is monotonic - nothing here and
 *     nothing in mkcert untrusts a CA - so the positive answer is final for the
 *     session. A negative one is always re-asked, which is what makes the
 *     "Trust certificate" button take effect on the very next paint.
 *
 * The terminal-PATH answer is deliberately NOT cached with it. It is cheap on
 * any host that has `ctx.terminal` (an in-memory list, no process), and it
 * changes the moment the user presses Register - so freezing it alongside would
 * leave that button doing nothing visible.
 *
 * @type {Awaited<ReturnType<typeof httpsStatus>> | null}
 */
let httpsProbe = null;

/**
 * The setup checklist.
 *
 * Three steps, all inside this extension's reach: pick a folder, press a
 * button, and decide about the terminal PATH. Nothing here can strand a user.
 *
 * Only the first two GATE the panel. Registering the shim directory is a real
 * step with a real button, but a user who already has a php on their PATH and
 * something running against it has a good reason to leave it exactly where it
 * is, and everything else here - the dashboard, the virtual hosts, HTTPS, the
 * databases - works without it. A checklist that refuses to open until you
 * agree to change your PATH is asking for consent it does not need.
 *
 * Trusting the local CA and writing the hosts file used to be steps four and
 * five. They are not steps any more, and that is the point: the CA is installed
 * as part of the install (mkcert is in the set, so the tool is right there and
 * the administrator prompt is one the user already expects), and the hosts file
 * is written whenever the set of projects changes. Both were things a user had
 * to know to press before their site would load, which is exactly the knowledge
 * a tool like this exists to remove.
 *
 * The root folder is required even though `paths.root()` has a fallback. A
 * silent default is what puts a user's runtimes, sites and databases somewhere
 * they did not choose and cannot find, and moving the setting afterwards moves
 * nothing - the files stay where they were written.
 *
 * @param {() => void} refresh
 * @returns {Promise<Step[]>}
 */
async function setupSteps(refresh) {
  // "Chosen" is the folder EXISTING, not the setting being non-empty. A path
  // the operating system rejects still stores fine, and a step that only
  // checked the string reported itself done while nothing had been created.
  const configured = Boolean(config.rootDir?.trim());
  const chosen = configured && (await isDir(paths.root()));
  const missing = CROSS_PLATFORM.filter(
    (id) => !installedOf(id).some((r) => r.origin === "download"),
  );

  // Whatever the installer is doing right now. `state.busy` is keyed by
  // component id and only one install runs at a time, so the first entry is the
  // one in flight. While the gate is up this is the ONLY progress on screen,
  // because the Runtimes rows that normally carry it are behind the gate.
  const [busyId, busyState] = [...state.busy.entries()][0] ?? [];
  const busy = busyState
    ? [
        `${provider(busyId ?? "")?.label ?? busyId}: ${busyState.text}`,
        busyState.pct === undefined ? "" : ` ${busyState.pct}%`,
        busyState.total ? ` · ${busyState.step} of ${busyState.total}` : "",
      ].join("")
    : "";

  const shims = shimDir();
  const onPath = await pathOnTerminal(shims);
  if (!httpsProbe || (!busyState && httpsProbe.trusted !== true)) {
    httpsProbe = await httpsStatus();
  }
  const https = httpsProbe;
  const names = CROSS_PLATFORM.map((id) => provider(id)?.label ?? id).join(", ");
  const pathSkipped = config.skipTerminalPath === true;

  // Is the panel still showing ONLY this checklist?
  //
  // It matters because the checklist carries the install progress, and it is
  // the right place for it exactly while nothing else is on screen. The moment
  // the gate drops, Runtimes and Services appear and each row carries its own
  // bar - so leaving one here too showed the same download twice, on the row
  // that is NOT the one being worked on. Installing another PHP would light up
  // "Install everything", a step that was already finished.
  //
  // Derived from the same two facts `paint()` derives `blocked` from, rather
  // than passed in, so the two cannot disagree about when the gate is up.
  const gated = !chosen || missing.length > 0;

  /** @type {Step[]} */
  const steps = [
    {
      title: "Root folder",
      icon: "lucide:FolderTree",
      done: chosen,
      detail: chosen
        ? "Holds runtimes, www (your projects), databases, certificates and logs."
        : configured
          ? `${paths.root()} could not be created. Pick another folder.`
          : "One folder for the runtimes, www (your projects), databases and certificates, so the root is the whole environment and there is one path to back up or move.",
      tag: chosen ? pill(paths.root()) : undefined,
      aside: h("div", { style: "display:flex;gap:5px" }, [
        chosen
          ? button("Open", () => openFolder(paths.root()), {
              icon: "lucide:FolderOpen",
              title: "Show this folder on disk",
            })
          : null,
        button(chosen ? "Change" : "Choose folder", () => void chooseRoot(refresh), {
          icon: "lucide:FolderOpen",
          variant: chosen ? "default" : "primary",
        }),
      ]),
    },

    {
      title: "Install everything",
      icon: "lucide:PackagePlus",
      // Gated on the cross-platform four rather than on every component:
      // requiring nginx would lock the panel forever on a Linux box where no
      // nginx download exists.
      // Deliberately NOT gated on the certificate authority as well. Trusting
      // it needs an administrator prompt the user can decline, and a declined
      // prompt must not lock the panel forever - so a missing CA is an action
      // on this row rather than a step of its own or a reason to stay blocked.
      done: chosen && missing.length === 0,
      detail:
        gated && busy
          ? busy
          : !chosen
            ? "Choose the root folder first - this is where everything gets installed."
            : missing.length !== 0
              ? `Downloads the current stable ${names}, plus every server and database this platform has a build for, and trusts the local certificate authority so https works.`
              : https.trusted
                ? `${names} installed, and the local certificate authority is trusted.`
                : // `reason` is a finished sentence, so it is used as one rather
                  // than spliced into a clause - that produced "not been trusted
                  // yet., so https will warn".
                  `${names} installed. ${(https.reason ?? "The local certificate authority is not trusted.").replace(/\.?$/, ".")} Sites will load over https with a browser warning until it is.`,
      // Only while this checklist is the whole panel. See `gated`.
      bar: gated && busyState ? progress(busyState.pct) : undefined,
      aside:
        gated && busy
          ? undefined
          : chosen && missing.length > 0
            ? button("Install", () => void installEverything(refresh), {
                variant: "primary",
                icon: "lucide:Download",
              })
            : chosen && !https.trusted && https.possible
              ? button("Trust certificate", () => void installEverything(refresh), {
                  variant: "primary",
                  icon: "lucide:ShieldCheck",
                  title: "Installs the local certificate authority into this machine's trust store",
                })
              : undefined,
    },

    {
      title: "Terminal PATH",
      icon: "lucide:SquareTerminal",
      done: onPath,
      // Never blocks. Once declined it stops being counted as outstanding too,
      // because the answer was given - repeating the question on every launch
      // is how a checklist turns into nagging.
      optional: !onPath && !pathSkipped,
      note: !onPath && pathSkipped,
      detail: onPath
        ? `TEDI terminals run the php, node and composer from this environment. Change it any time in ${pathInstruction()}.`
        : pathSkipped
          ? `Left alone, so your terminals keep resolving the php, node and composer they already find. Everything else here works without it - only the terminal is unaffected. Register whenever you want this environment's runtimes on the PATH.`
          : canRegisterPath()
            ? `Puts this environment first on TEDI's terminal PATH, so php, node, npm and composer in a terminal are the versions above rather than whatever your system finds first. Any folder holding a competing one is switched OFF, not deleted - you can turn it back on in ${pathInstruction()}. Leave it alone if something on this machine is already running against your own PHP or Node.`
            : `Registers this environment with TEDI's terminals, so php, node, npm and composer resolve to the versions above. Paste this folder into ${pathInstruction()} → Add folder, then reopen your terminals.`,
      tag: pill(shims),
      aside: onPath
        ? undefined
        : h("div", { style: "display:flex;gap:5px" }, [
            canRegisterPath()
              ? button("Register", () => void registerPath(refresh), {
                  icon: "lucide:PlugZap",
                  variant: "primary",
                })
              : // Older host with no `ctx.terminal`: the paste is still the answer.
                button(
                  "Copy path",
                  async () => {
                    await navigator.clipboard.writeText(shims).catch(() => {});
                    ctx?.ui.toast(`Shim folder copied. Paste it into ${pathInstruction()}.`, {
                      variant: "info",
                    });
                  },
                  { icon: "lucide:Copy", variant: "primary" },
                ),
            pathSkipped
              ? null
              : button(
                  "Not now",
                  async () => {
                    await setSkipTerminalPath(true);
                    refresh();
                  },
                  {
                    title:
                      "Leave your terminal PATH exactly as it is. This row stays here, so you can register it later.",
                  },
                ),
          ]),
    },
  ];

  // Ports below 1024 are root-only on macOS and Linux, and a web server that
  // cannot bind fails with a permission error in a log file rather than
  // anywhere the user is looking. Say it BEFORE they press Start. Not a step:
  // there is nothing to press, and it does not block anything.
  if (needsRootToBind(config.httpPort) || needsRootToBind(config.httpsPort)) {
    steps.push({
      title: "Privileged ports",
      icon: "lucide:TriangleAlert",
      done: false,
      note: true,
      detail:
        `Ports ${config.httpPort} and ${config.httpsPort} are below 1024, which only root may bind on this platform. ` +
        "Either run TEDI with elevated rights, or set the ports above 1024 on the web server row.",
    });
  }

  return steps;
}

/**
 * Register the shim folder on the terminal PATH.
 *
 * Names what it switched off rather than doing it quietly: the user is about to
 * find that the php their terminals used to resolve is no longer the one they
 * get, and they should read that here rather than discover it.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function registerPath(refresh) {
  const res = await registerTerminalPath(shimDir());
  if (!res.ok) {
    ctx?.ui.toast(res.error ?? "The terminal PATH could not be updated.", { variant: "error" });
  } else {
    // Registering is the undo for "Not now", so the decision is cleared with it
    // rather than left behind to describe a state that no longer holds.
    await setSkipTerminalPath(false);
    ctx?.ui.toast(
      res.disabled.length === 0
        ? "This environment is now first on the terminal PATH. Reopen your terminals."
        : `This environment is now first on the terminal PATH, and ${res.disabled.length} conflicting folder${res.disabled.length === 1 ? " was" : "s were"} switched off: ${res.disabled.join(", ")}. Reopen your terminals.`,
      { variant: "success" },
    );
  }
  refresh();
}

/**
 * Pick where the environment lives.
 *
 * A native folder picker, not a typed path. Typing an absolute path is how a
 * stray character ends up in a Windows root - and one did, which made every
 * later write fail with `os error 123`.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function chooseRoot(refresh) {
  const picked = await ctx?.ui.pickFolder({
    title: "Choose the Dev Environment folder",
    defaultPath: config.rootDir?.trim() || undefined,
  });
  if (!picked) return;

  const previous = config.rootDir;
  try {
    // Written before the directories are made because `layoutDirs()` reads it,
    // and put BACK if they cannot be made. Leaving a root the OS rejected in
    // the settings is worse than not changing it: every later write goes to a
    // directory that does not exist, and the panel has no way to say why.
    await writeSetting("rootDir", picked.replace(/[\\/]+$/, ""));
    await ensureDirs(layoutDirs());
    await writeShims();
    await applyRuntimeChange();
    state.startupError = null;
    ctx?.ui.toast(`Environment root is now ${paths.root()}`, { variant: "success" });
  } catch (err) {
    await writeSetting("rootDir", previous);
    ctx?.ui.toast(
      `Could not use that folder: ${err instanceof Error ? err.message : String(err)}`,
      {
        variant: "error",
      },
    );
  }
  refresh();
}
