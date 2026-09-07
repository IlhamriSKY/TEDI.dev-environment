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

import { h, button, muted, section, row, pill, icon, dot } from "./el.js";
import { runtimesView } from "./runtimes-view.js";
import { servicesView } from "./services-view.js";
import { projectsView } from "./projects-view.js";
import { state, config, ctx } from "../runtime.js";
import { paths, layoutDirs } from "../core/paths.js";
import { ensureDirs, isDir } from "../core/fsx.js";
import { openFolder } from "../core/proc.js";
import { shimDir, writeShims } from "../project/shims.js";
import { scanInstalled, installedOf } from "../manager/versions.js";
import { applyRuntimeChange } from "../manager/apply.js";
import { writeSetting } from "../manager/config.js";
import { CROSS_PLATFORM } from "../manager/defaults.js";
import { installEverything } from "./install-all.js";
import { provider } from "../registry/index.js";
import { refreshStatuses, startAll, stopAll } from "../manager/services.js";
import { publish } from "../web/publish.js";
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
  const blocked = steps.filter((s) => !s.note && !s.done);

  // Nothing else is drawn until setup is finished. Disabling every control
  // instead would leave a panel full of buttons that explain, one at a time,
  // that they cannot work yet; a single screen that says what is left is both
  // shorter to read and shorter to write.
  if (blocked.length > 0) {
    root.replaceChildren(header(refresh, false), setupCard(steps, blocked));
    return;
  }

  root.replaceChildren(
    header(refresh, true),
    section("Setup", steps.map(stepRow)),
    runtimesView(refresh),
    servicesView(refresh),
  );

  // Projects reads every project's config to resolve its runtime, so it is
  // appended when it resolves rather than holding the whole panel blank.
  const projects = await projectsView(refresh);
  if (!current()) return;
  root.append(projects);
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
 * @property {Node} [aside]    The control that completes it.
 * @property {Node} [tag]
 */

/**
 * One setup step, in the same row the rest of the panel uses.
 *
 * A status dot and an icon, exactly like a service row or a project row - not a
 * numbered badge. The panel already had a vocabulary for "here is a thing and
 * its state"; a checklist that invents its own is one more shape to learn for
 * no information gained.
 *
 * @param {Step} step @returns {HTMLElement}
 */
function stepRow(step) {
  return row([
    dot(step.note ? "warn" : step.done ? "ok" : "idle"),
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
}

/** @param {() => void} refresh @param {boolean} ready @returns {HTMLElement} */
function header(refresh, ready) {
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
      // The run controls are not merely disabled while setup is unfinished:
      // there is nothing installed for them to start.
      ready === false
        ? null
        : h("div", { style: "display:flex;gap:6px" }, [
            button("Apply changes", () => void applyEverything(refresh), { variant: "primary" }),
            button("Start all", async () => {
              await startAll();
              refresh();
            }),
            button("Stop all", async () => {
              await stopAll();
              refresh();
            }),
          ]),
    ],
  );
}

/**
 * Republish everything by hand.
 *
 * `publish()` runs on its own whenever the set of projects changes, so this
 * button is for the cases nothing can observe: a php.ini edit that changed the
 * FastCGI pool, a port changed in Settings, a hosts file someone edited
 * themselves. It does exactly what an add does, so there is only one code path
 * that can put a site on the air.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function applyEverything(refresh) {
  try {
    const res = await publish();
    if (!res.hostsOk) {
      ctx?.ui.toast(res.hostsMessage ?? "The hosts file could not be updated.", {
        variant: "warning",
      });
    }
    ctx?.ui.toast(`Applied ${res.domains.length} host${res.domains.length === 1 ? "" : "s"}.`, {
      variant: "success",
    });
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  } finally {
    refresh();
  }
}

/**
 * The setup checklist.
 *
 * Three steps, all REQUIRED, all inside this extension's reach: pick a folder,
 * press a button, paste one path. Nothing here can strand a user.
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

  // Whatever the installer is doing right now, named. `state.busy` is keyed by
  // component id and only one install runs at a time, so the first entry is the
  // one in flight. While the gate is up this is the ONLY progress on screen,
  // because the Runtimes rows that normally carry it are behind the gate.
  const [busyId, busyText] = [...state.busy.entries()][0] ?? [];
  const busy = busyId ? `${provider(busyId)?.label ?? busyId}: ${busyText}` : "";

  const shims = shimDir();
  const onPath = await pathOnTerminal(shims);
  const names = CROSS_PLATFORM.map((id) => provider(id)?.label ?? id).join(", ");
  const https = await httpsStatus();

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
          : "One folder for the runtimes, www (your projects), databases and certificates, the way Laragon keeps everything under one root.",
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
      detail: busy
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
      aside: busy
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
      detail: onPath
        ? `TEDI terminals run the php, node and composer from this environment. Change it any time in ${pathInstruction()}.`
        : canRegisterPath()
          ? `Puts this environment first on TEDI's terminal PATH, so typing "php" runs the PHP above instead of whatever else your system finds first. Any folder holding a competing php, node or composer is switched OFF, not deleted - you can turn it back on in ${pathInstruction()}.`
          : `Registers this environment with TEDI's terminals, so typing "php" runs the PHP above. Paste this folder into ${pathInstruction()} → Add folder, then reopen your terminals.`,
      tag: pill(shims),
      aside: onPath
        ? undefined
        : canRegisterPath()
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
        "Either run TEDI with elevated rights, or set the HTTP and HTTPS ports above 1024 in Settings.",
    });
  }

  return steps;
}

/**
 * Register the shim folder on the terminal PATH.
 *
 * Names what it switched off rather than doing it quietly: the user is about to
 * find that their Laragon php is no longer what a terminal resolves, and they
 * should read that here rather than discover it.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function registerPath(refresh) {
  const res = await registerTerminalPath(shimDir());
  if (!res.ok) {
    ctx?.ui.toast(res.error ?? "The terminal PATH could not be updated.", { variant: "error" });
  } else {
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
