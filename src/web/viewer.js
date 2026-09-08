// Handing a database over to SQL Explorer.
//
// The connection details already reach it: `manager/handoff.js` publishes them
// to `~/.tedi/dev-environment.json`, which is the only channel there is, since
// the host namespaces settings, events and secrets under whoever is calling.
// What was missing was the last step - actually getting there - which needed
// `ctx.tabs.openExtensionTab({ extensionId })`, new in TEDI 0.4.48.
//
// Both halves are feature-detected rather than assumed, because most of this is
// optional: the extension may not be installed, and the host may be older.
// Neither is an error, so neither says anything - the button is simply absent.

import { ctx } from "../runtime.js";
import { dirname, join } from "../core/paths.js";
import { isDir } from "../core/fsx.js";

/** SQL Explorer's ids. Hardcoded because a handoff names its partner: the file
 *  format in `manager/handoff.js` is already shaped to that extension's own
 *  connection record. */
const VIEWER_ID = "tedi.sql-explorer";
const VIEWER_PANEL = "sql-explorer";

/** Answered once at activation. A row renders synchronously and there are six
 *  of them, so the alternative is a directory probe per paint for an answer
 *  that cannot change while the app is running: installing or removing an
 *  extension reloads the host. */
let present = false;

/**
 * Look for SQL Explorer. Called once, from `activate`.
 *
 * Every extension lives in its own directory beside ours, so a sibling of
 * `ctx.installPath` is the answer. Deliberately not a check for "enabled": a
 * disabled extension registers no panel, `openExtensionTab` returns null for
 * it, and that is worth reporting when the button is pressed rather than hiding
 * the button for a reason the user cannot see.
 *
 * @returns {Promise<void>}
 */
export async function probeViewer() {
  // `ctx.has`, not `typeof`: `openExtensionTab` has existed for many releases
  // and it is the `extensionId` OPTION that is new. An older host accepts the
  // object, ignores the field it does not know, and opens OUR panel under SQL
  // Explorer's panel id - an empty tab, from a button that looked like it
  // worked. That silent-wrong-answer shape is exactly what the feature list is
  // for.
  if (!ctx?.has?.("openExtensionTab.extensionId")) {
    present = false;
    return;
  }
  const root = dirname(String(ctx?.installPath ?? ""));
  present = Boolean(root) && (await isDir(join(root, VIEWER_ID)));
}

/** Can a database be handed over? @returns {boolean} */
export function viewerReady() {
  return present;
}

/**
 * Open SQL Explorer.
 *
 * The connection is already in its list: it reads the handoff file when it
 * activates and again when its panel mounts, so opening the panel IS the
 * handover. Returns what went wrong, or null.
 *
 * @returns {string | null}
 */
export function openViewer() {
  const opened = ctx?.tabs?.openExtensionTab?.({
    extensionId: VIEWER_ID,
    panelId: VIEWER_PANEL,
    title: "SQL Explorer",
    icon: "lucide:Database",
    reuseKey: VIEWER_PANEL,
  });
  return opened === null || opened === undefined
    ? "SQL Explorer is installed but not enabled. Turn it on in Settings, Extensions."
    : null;
}
