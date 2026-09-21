// The Backups dialog: what has been backed up, and putting one back.
//
// A dialog rather than a section on the dashboard, and that is the only layout
// decision here worth stating. The list grows by one every time somebody
// presses Back up, it is read on the day something went wrong, and a section
// that pushes Projects down a screen on a day nothing went wrong is a section
// in the way. Everything about backups is behind one button on the Projects
// header, next to the action that creates them.

import {
  h,
  row,
  muted,
  button,
  modal,
  confirm,
  dropdown,
  pill,
  skeleton,
  section,
  busyLine,
} from "./el.js";
import { listBackups, restoreBackup, pruneBackups } from "../manager/backup.js";
import { setKeepBackups } from "../manager/config.js";
import { paths, join, samePath, dirname } from "../core/paths.js";
import { openFolder } from "../core/proc.js";
import { remove } from "../core/fsx.js";
import { addProject } from "../project/projects.js";
import { publish } from "../web/publish.js";
import { config, state, ctx } from "../runtime.js";

/** How many copies of one project to keep. `0` is every one of them. */
const KEEP_CHOICES = [
  { value: "3", label: "Keep 3" },
  { value: "5", label: "Keep 5" },
  { value: "10", label: "Keep 10" },
  { value: "0", label: "Keep all" },
];

/**
 * Open it.
 *
 * @param {() => void} refresh  Repaint the dashboard behind the dialog.
 * @returns {void}
 */
export function openBackups(refresh) {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:4px" }, [skeleton()]);

  const dialog = modal({
    title: "Backups",
    description: `Every zip in ${paths.backups()}, newest first.`,
    body,
    footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
      button("Open folder", () => void openFolder(paths.backups()), { icon: "lucide:FolderOpen" }),
      button("Done", () => dialog.close(), { variant: "primary" }),
    ]),
    width: "min(34rem,100%)",
  });

  const reload = async () => {
    const backups = await listBackups();
    if (backups.length === 0) {
      body.replaceChildren(
        muted("Nothing here yet. Back up is in a project's menu, behind the three dots."),
      );
      return;
    }
    body.replaceChildren(
      section(
        "Archives",
        backups.map((backup) => backupRow(backup, reload, refresh, dialog)),
        keepPicker(reload),
      ),
    );
  };
  void reload();
}

/**
 * The retention control.
 *
 * It lives beside the list rather than in Settings because it is a rule about
 * these files, read while looking at them: "Keep 5" next to eleven of them says
 * what the next backup will do in a way a settings card never does. Changing it
 * prunes immediately, so the number and the list cannot disagree.
 *
 * @param {() => Promise<void>} reload @returns {HTMLElement}
 */
function keepPicker(reload) {
  return dropdown(
    KEEP_CHOICES,
    String(config.keepBackups),
    async (value) => {
      await setKeepBackups(Number(value));
      for (const project of new Set(state.projects.map((p) => p.name))) {
        await pruneBackups(project, config.keepBackups);
      }
      await reload();
    },
    { width: "104px" },
  );
}

/**
 * One archive.
 *
 * @param {Awaited<ReturnType<typeof listBackups>>[number]} backup
 * @param {() => Promise<void>} reload
 * @param {() => void} refresh
 * @param {{ close: () => void }} dialog
 * @returns {HTMLElement}
 */
function backupRow(backup, reload, refresh, dialog) {
  const busy = busyLine();
  const line = row([
    h("div", { style: "display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-width:0" }, [
      h("span", {
        text: backup.project,
        title: backup.path,
        style:
          "font-size:12px;font-weight:600;line-height:1;overflow:hidden;" +
          "text-overflow:ellipsis;white-space:nowrap",
      }),
      muted(`${when(backup.mtime)} · ${size(backup.size)}`),
    ]),
    h("div", { style: "display:flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0" }, [
      pill(known(backup.project) ? "project" : "orphan", {
        title: known(backup.project)
          ? "This project is registered, so it restores where it already lives."
          : `No project by this name. It restores into ${paths.www()} and is served from there.`,
      }),
      button(
        "Restore",
        async () => {
          const into = restoreInto(backup.project);
          const ok = await confirm({
            title: `Restore ${backup.project}?`,
            description:
              `Files are written over ${join(into, backup.project)}. Anything the backup ` +
              "carries replaces what is there; files added since it was taken stay. If the " +
              "backup holds a database dump, it is imported and REPLACES that database.",
            confirmLabel: "Restore",
            icon: "lucide:RotateCcw",
          });
          if (!ok) return;
          try {
            const res = await restoreBackup(backup, {
              into,
              onStep: (text) => busy.set(text),
            });
            busy.set("");
            await serveRestored(backup.project, res.dir);
            refresh();
            ctx?.ui.toast(
              res.database
                ? `${backup.project} restored, with ${res.database}.`
                : `${backup.project} restored. No database dump was in the backup.`,
              { variant: "success" },
            );
            dialog.close();
          } catch (err) {
            busy.set("");
            ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
          }
        },
        { icon: "lucide:RotateCcw", title: `Put ${backup.name} back` },
      ),
      button(
        "",
        async () => {
          const ok = await confirm({
            title: `Delete ${backup.name}?`,
            description: "The zip goes. The project and its database are untouched.",
          });
          if (!ok) return;
          await remove(backup.path);
          await reload();
        },
        { icon: "lucide:Trash2", variant: "danger", title: "Delete this archive" },
      ),
    ]),
  ]);

  // The bar goes UNDER its own row, the way a service row carries its install
  // progress: a restore unpacks thousands of files and then waits on a database
  // client, and inside a row there is no width for a bar that means anything.
  return h("div", { style: "display:flex;flex-direction:column;min-width:0" }, [line, busy.el]);
}

/** Is a project by this name registered? @param {string} name @returns {boolean} */
function known(name) {
  return state.projects.some((p) => p.name === name);
}

/** Where a restore of this project should land: beside the registered project
 *  if there is one, so a checkout outside `www` is restored where it lives.
 *  @param {string} name @returns {string} */
function restoreInto(name) {
  const project = state.projects.find((p) => p.name === name);
  return project ? dirname(project.path) : paths.www();
}

/**
 * Make sure what was just restored is actually served.
 *
 * A backup of a project that has since been removed restores a folder nothing
 * points at: no virtual host, no certificate, no hosts entry. Registering it
 * here is the difference between "the files are back" and "the site is back",
 * and it is skipped when the project is already known, where `publish` would be
 * rewriting configuration that is already correct.
 *
 * @param {string} name @param {string} dir @returns {Promise<void>}
 */
async function serveRestored(name, dir) {
  if (state.projects.some((p) => p.name === name || samePath(p.path, dir))) return;
  await addProject(dir);
  await publish();
}

/** `20-09-2026 14:32`, the same day-month-year the version picker uses.
 *  @param {number} mtime @returns {string} */
function when(mtime) {
  const d = new Date(mtime);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Bytes as the unit a person would say. @param {number} bytes @returns {string} */
function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
