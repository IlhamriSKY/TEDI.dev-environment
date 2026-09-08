// PHP configuration: php.ini, Xdebug and extensions, for ONE version.
//
// This used to be an accordion sitting on the dashboard. It is a dialog now,
// opened from the PHP row, for a reason that is structural rather than
// cosmetic: every control in here is scoped to a single install - its own
// php.ini, its own extension directory, its own FastCGI pool - and a panel that
// lives permanently under a version dropdown invites exactly the mistake of
// editing whichever version happened to be selected. A dialog you open FROM a
// version cannot be ambiguous about which one it is editing.
//
// It also gets the dashboard back: the settings grid, the Xdebug row, the
// extension chips and a php.ini editor were four blocks that pushed the two
// things a user actually watches - what is running, and which projects exist -
// off the bottom of a short pane.

import { h, row, muted, pill, button, dropdown, input, icon, mark, modal } from "./el.js";
import { markFor } from "./marks.js";
import { installedOf } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import {
  COMMON_SETTINGS,
  readSettings,
  applySettings,
  iniPathFor,
  readRaw,
  writeRaw,
} from "../manager/phpini.js";
import {
  status as xdebugStatus,
  MODES,
  install as installXdebug,
  setMode,
  setEnabled,
} from "../manager/xdebug.js";
import { extensionsBlock } from "./php-ext-view.js";
import { ctx } from "../runtime.js";

/**
 * Configure one PHP install.
 *
 * @param {string} version         Which install to edit.
 * @param {() => void} refreshPane Repaint the dashboard behind the dialog.
 * @returns {void}
 */
export function openPhpConfig(version, refreshPane) {
  const installed = installedOf("php");
  let current = installed.some((v) => v.version === version)
    ? version
    : (activeVersion("php") ?? installed[0]?.version);
  if (!current) return;

  const body = h("div", {
    style:
      "display:flex;flex-direction:column;gap:14px;overflow:auto;min-height:0;padding-right:2px",
  });

  const picker = dropdown(
    installed.map((v) => ({
      value: v.version,
      label: `PHP ${v.version}`,
      hint: v.origin === "system" ? "system" : undefined,
    })),
    current,
    (value) => {
      current = value;
      void draw();
    },
    { full: true },
  );

  /** Rebuild the dialog body, and repaint the pane behind it: a version switch
   *  or an extension toggle changes what the dashboard shows too. */
  const draw = async () => {
    const version = /** @type {string} */ (current);
    // Placeholder first. Every block below reads a file or shells out to
    // `php -m`, and blanking the dialog for half a second on each redraw reads
    // as the thing having crashed.
    const blocks = [
      systemNotice(version),
      await settingsBlock(version, draw),
      await xdebugBlock(version, draw),
      group("Extensions", [await extensionsBlock(version, draw)]),
      group("Advanced", [await rawRow(version, draw)]),
    ];
    body.replaceChildren(...blocks.filter(Boolean).map((b) => /** @type {Node} */ (b)));
    refreshPane();
  };

  modal({
    title: h("span", { style: "display:flex;align-items:center;gap:8px" }, [
      mark(markFor("php"), 17),
      h("strong", {
        text: "PHP configuration",
        style: "font-size:15px;font-weight:500;line-height:1",
      }),
    ]),
    body: h("div", { style: "display:flex;flex-direction:column;gap:12px;min-height:0" }, [
      picker,
      body,
    ]),
    width: "min(720px,100%)",
  });

  void draw();
}

/**
 * Editing a SYSTEM runtime writes into the install the user's own package
 * manager, installer or stack put there. That is usually exactly what
 * they want, and it is also the one action here that reaches outside this
 * extension's own tree, so it is stated before the controls rather than
 * discovered afterwards.
 *
 * @param {string} version @returns {HTMLElement | null}
 */
function systemNotice(version) {
  const info = installedOf("php").find((v) => v.version === version);
  if (info?.origin !== "system") return null;
  return h(
    "div",
    {
      style:
        "display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:var(--radius, 6px);" +
        "border:1px solid color-mix(in oklab,var(--tedi-icon-working,#facc15) 45%,transparent);" +
        "background:color-mix(in oklab,var(--tedi-icon-working,#facc15) 8%,transparent)",
    },
    [
      icon("lucide:TriangleAlert", "var(--tedi-icon-working, #facc15)"),
      muted("This PHP was installed outside TEDI. Changes here edit that install's own php.ini."),
    ],
  );
}

/** A labelled group inside the dialog.
 *  @param {string} title @param {(Node|null)[]} children @returns {HTMLElement} */
function group(title, children) {
  return h("div", { style: "display:flex;flex-direction:column;gap:7px" }, [
    h("span", {
      text: title,
      style:
        "font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;" +
        "color:var(--muted-foreground)",
    }),
    ...children,
  ]);
}

/**
 * The handful of directives people actually change.
 *
 * Committed on blur rather than per keystroke: each commit rewrites php.ini and
 * recycles the FastCGI pool, and doing that on every character typed into
 * `memory_limit` would restart PHP four times while someone types "512M".
 *
 * @param {string} version @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
async function settingsBlock(version, refresh) {
  const current = await readSettings(version);

  const fields = COMMON_SETTINGS.map((setting) => {
    const field = input(
      current[setting.key] ?? "",
      async (value) => {
        const trimmed = value.trim();
        if (trimmed === (current[setting.key] ?? "")) return;
        try {
          await applySettings(version, { [setting.key]: trimmed });
          ctx?.ui.toast(`${setting.key} = ${trimmed}`, { variant: "success" });
          refresh();
        } catch (err) {
          ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
        }
      },
      setting.hint,
    );

    return h("label", { style: "display:flex;flex-direction:column;gap:3px;min-width:0" }, [
      h("span", {
        text: setting.label,
        title: setting.key,
        style: "font-size:11px;font-weight:500;color:var(--muted-foreground)",
      }),
      field,
    ]);
  });

  return group("Settings", [
    h(
      "div",
      { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:9px" },
      fields,
    ),
  ]);
}

/**
 * The whole php.ini, behind one button.
 *
 * A text box holding a two-thousand-line file is a way to break a runtime, not
 * a feature to lead with, so it is the last row and it costs a click. It exists
 * because the settings grid can only expose directives it knows about, and PHP
 * has hundreds. Nothing is read until the button is pressed.
 *
 * @param {string} version @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
async function rawRow(version, refresh) {
  const info = await iniPathFor(version);
  return row([
    icon("lucide:FileCog", "var(--muted-foreground)"),
    h("div", { style: "display:flex;flex-direction:column;gap:0;flex:1;min-width:0" }, [
      h("span", { text: "php.ini", style: "font-size:12px;font-weight:600" }),
      muted(
        info
          ? info.exists
            ? info.path
            : `${info.path} (created on first change)`
          : "No ini path for this install.",
      ),
    ]),
    button("Edit", () => void openRawEditor(version, refresh), { icon: "lucide:PenLine" }),
  ]);
}

/**
 * The raw php.ini, in the host's own editor.
 *
 * `ctx.ui.codeEditor` is the same CodeMirror bundle the editor pane runs, so
 * this is not a lookalike: same gutter, same folding, same theme, same font
 * setting, and `ini` colouring from the same legacy mode the file tree resolves
 * for a php.ini. Find and replace comes with it.
 *
 * This file previously used a `<textarea>` plus a find bar written here, at a
 * time when `codeEditor` shipped without `searchKeymap` and no extension could
 * add one from outside. That was a gap in the HOST, and it was fixed there
 * rather than worked around here, which is why the local editor and its find
 * bar are both gone.
 *
 * @param {string} version @param {() => void} refresh
 * @returns {Promise<void>}
 */
async function openRawEditor(version, refresh) {
  /** @type {string | null} */
  let content;
  try {
    content = await readRaw(version);
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
    return;
  }

  // The editor sizes itself to its container (`&` is `height: 100%`), so the
  // container is the thing that needs a height. A `min-height` alone would
  // collapse it to nothing.
  const host = h("div", {
    style:
      "height:min(56vh,460px);min-height:0;overflow:hidden;" +
      "border:1px solid var(--border);background:var(--background)",
  });

  /** @type {import("../../tedi.d.ts").CodeEditorHandle | null} */
  let editor = null;

  const save = button(
    "Save php.ini",
    async () => {
      if (!editor) return;
      try {
        await writeRaw(version, editor.getValue());
        ctx?.ui.toast("php.ini saved; the FastCGI worker was restarted.", { variant: "success" });
        close();
        refresh();
      } catch (err) {
        ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
      }
    },
    { variant: "primary" },
  );
  save.style.flex = "1";
  save.style.height = "30px";

  const { close } = modal({
    title: `php.ini · PHP ${version}`,
    description:
      "Ctrl+F to find and replace. Saved exactly as typed - a syntax error here stops PHP from starting.",
    body: host,
    footer: h("div", { style: "display:flex;gap:8px" }, [save]),
    width: "min(880px,100%)",
    // The host mounts a CodeMirror view; it has to be told when the dialog
    // goes, or every open leaks one.
    onClose: () => editor?.dispose(),
  });

  // Mounted AFTER the dialog is in the document: CodeMirror measures on
  // construction, and one built inside a detached node comes up with a zero
  // viewport and no visible line numbers.
  editor = ctx?.ui.codeEditor(host, { language: "ini", value: content ?? "" }) ?? null;
  editor?.focus();
}

/**
 * Xdebug, in the three states that matter: absent, present but off, and on.
 *
 * The mode picker is the important control. Xdebug 3 does nothing at all unless
 * `xdebug.mode` says otherwise, so an installed-and-enabled Xdebug with no mode
 * is the single most common "I installed it and nothing happened".
 *
 * @param {string} version @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
async function xdebugBlock(version, refresh) {
  const st = await xdebugStatus(version);

  if (st.blocked) {
    // The extensions block right below states the same reason in full, so this
    // says only what is different: whether Xdebug happens to be there already.
    return group("Debugging", [
      row([
        icon("lucide:Bug", "var(--muted-foreground)"),
        h("span", { text: "Xdebug", style: "font-size:12px;font-weight:600;min-width:70px" }),
        muted(st.installed ? "loaded by this PHP" : "not available in this PHP"),
      ]),
    ]);
  }

  if (!st.installed) {
    return group("Debugging", [
      row([
        icon("lucide:Bug", "var(--muted-foreground)"),
        h("span", { text: "Xdebug", style: "font-size:12px;font-weight:600;min-width:70px" }),
        muted("Not installed. Step debugging, better var_dump, and coverage."),
        h("div", { style: "flex:1" }),
        button(
          "Install Xdebug",
          async () => {
            try {
              await installXdebug(version);
              ctx?.ui.toast("Xdebug installed and configured for step debugging.", {
                variant: "success",
              });
            } catch (err) {
              ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
            }
            refresh();
          },
          { variant: "primary", icon: "lucide:Download" },
        ),
      ]),
    ]);
  }

  return group("Debugging", [
    row([
      icon("lucide:Bug", "#5c8ab5"),
      h("span", { text: "Xdebug", style: "font-size:12px;font-weight:600;min-width:70px" }),
      dropdown(
        MODES.map((m) => ({ value: m.value, label: m.label })),
        st.mode ?? "off",
        async (mode) => {
          await setMode(version, mode);
          ctx?.ui.toast(`Xdebug mode: ${mode}`, { variant: "success" });
          refresh();
        },
        { width: "150px" },
      ),
      pill(`port ${st.port}`),
      muted(MODES.find((m) => m.value === (st.mode ?? "off"))?.hint ?? ""),
      h("div", { style: "flex:1" }),
      button(st.enabled ? "Disable" : "Enable", async () => {
        await setEnabled(version, !st.enabled);
        refresh();
      }),
    ]),
  ]);
}
