// Dev Environment - entry point.
//
// Wiring only. Every decision lives in the module that owns it; this file
// starts things in the right order and takes them down in the reverse one.
//
// Activation is deliberately CHEAP: it reads configuration, scans the install
// tree and registers the panel, and touches the network for nothing. A slow
// activate is charged to every launch of TEDI whether or not the user opens
// this pane, and `bootAll` runs extensions in parallel, so the whole boot is as
// slow as its slowest member.

import { setCtx, state, clearTimer, repaint, statusSignature, warn } from "./runtime.js";
import { loadConfig } from "./manager/config.js";
import { ensureDirs } from "./core/fsx.js";
import { layoutDirs } from "./core/paths.js";
import { scanInstalled } from "./manager/versions.js";
import { sweepDownloads } from "./manager/install.js";
import { refreshStatuses, startAll, stopAll } from "./manager/services.js";
import { loadProjects, refreshAllRuntimes } from "./project/projects.js";
import { writeShims } from "./project/shims.js";
import { writeGlobalEnv } from "./manager/apply.js";
import { seedDefaults } from "./manager/defaults.js";
import { mountDashboard } from "./ui/dashboard.js";
import { clearIconCache } from "./ui/el.js";

/** @typedef {import("../tedi").ExtensionContext} ExtensionContext */

const PANEL_ID = "devenv";
const STATUS_ITEM = "devenv";

/** How often the pane refreshes service state while it is open. Services do not
 *  change on their own very often; this exists to notice a crash, not to
 *  animate anything. */
const POLL_MS = 4000;

/** @param {ExtensionContext} context */
export async function activate(context) {
  setCtx(context);
  state.active = true;

  await loadConfig();
  await loadProjects();

  // REGISTERED BEFORE ANY FILESYSTEM WORK, and the filesystem work is not
  // allowed to throw past this point.
  //
  // Everything below touches the environment root, and the root is a string the
  // user typed. One that the OS rejects - a stray tab in a pasted Windows path
  // is enough, `os error 123` - made `writeShims()` throw, which failed
  // `activate()`, which meant no panel was registered at all: the extension
  // showed "did not provide its panel" and the only screen that could have
  // fixed the setting was the one that no longer existed. A bad setting must
  // never be able to lock the user out of the settings.
  context.registerPanelRenderer(PANEL_ID, (container) => mountDashboard(container));

  // The shims are rewritten on every activation rather than only on first run:
  // they are generated code, and an extension update that changes how they
  // resolve must reach a machine that already has the old ones.
  try {
    // Was inside `loadConfig`; it belongs here, after the panel exists.
    await ensureDirs(layoutDirs());
    await writeShims();
    await scanInstalled();
    // Anything installed but never chosen gets a default now, so the dropdowns
    // and the shims always agree about which version is active.
    await seedDefaults();
    await writeGlobalEnv();
    await refreshAllRuntimes();
  } catch (err) {
    // Surfaced on the setup screen rather than swallowed, because the panel is
    // about to render a checklist and "root folder" is the step that fixes it.
    state.startupError = err instanceof Error ? err.message : String(err);
  }

  // Leftovers from an install interrupted by a crash or a quit.
  void sweepDownloads().catch(() => {});

  const open = () => {
    context.tabs.openExtensionPane({
      panelId: PANEL_ID,
      title: "Dev Environment",
      icon: "lucide:Server",
      reuseKey: PANEL_ID,
    });
  };
  state.onOpen = open;

  context.registerCommandHandler("tedi.devenv.open", open);
  context.registerCommandHandler("tedi.devenv.startAll", () => void startAll());
  context.registerCommandHandler("tedi.devenv.stopAll", () => void stopAll());

  context.statusBar.setItem({
    id: STATUS_ITEM,
    icon: "lucide:Server",
    tooltip: "Dev Environment",
    onClick: open,
  });

  // Poll only while something is mounted. An extension that keeps a timer
  // running against a pane nobody has open is a background cost the user cannot
  // see and did not ask for.
  //
  // And repaint only when the poll actually found a CHANGE. Repainting on every
  // tick rebuilt the whole panel four times a minute - visible as a flicker, and
  // it re-read php.ini and re-ran `php -m` each time for nothing.
  let lastSignature = "";
  state.timer = setInterval(() => {
    if (!state.active || state.views.size === 0) return;
    void (async () => {
      await refreshStatuses();
      const signature = statusSignature();
      if (signature === lastSignature) return;
      lastSignature = signature;
      repaint();
    })();
  }, POLL_MS);

  context.addDisposer(() => clearTimer());
}

export async function deactivate() {
  // Latch first: every loop and every late async callback checks this, and one
  // that fires after teardown would act on a `ctx` that is gone.
  state.active = false;
  clearTimer();

  // Stop what we started. A PHP worker or a MySQL left running after the
  // extension is disabled is a process the user has no UI to stop.
  await stopAll().catch((err) => warn("could not stop every service", err));

  // The terminal PATH is deliberately NOT unregistered here.
  //
  // It was, briefly, on the reasoning that a disabled extension should not keep
  // its shims first on the PATH. That is wrong, because `deactivate` also runs
  // on app SHUTDOWN and an extension cannot tell the two apart: quitting TEDI
  // silently tore down the user's setup, re-enabled the folders it had switched
  // off, and the next launch opened on the setup gate again asking them to
  // register a PATH they had already registered.
  //
  // The entry is user configuration, like the root folder: it survives a
  // restart. Turning it off is a deliberate act, and Settings -> Terminal ->
  // Additional PATH already offers exactly that - a switch and a delete on a row
  // labelled with the extension that added it.

  state.views.clear();
  state.onOpen = null;
  // Each cached icon is a live React root the host mounted for us. Dropping the
  // cache here means a reload starts from an empty one rather than holding
  // nodes that belong to a torn-down context.
  clearIconCache();
  setCtx(null);
}
