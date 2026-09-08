// Global configuration.
//
// There are two sources and they answer different questions. The extension's
// SETTINGS owns the handful of values a user edits in the pane (data
// directory, domain suffix, web server, ports); `config.json` in the data root
// owns everything the extension decides for itself, chiefly which version of
// each component is currently active.
//
// They are merged into one live `config` object at activation, and the settings
// store always wins for the keys it owns. Keeping the active-version map out of
// it is deliberate: it changes whenever a user switches a runtime, and a
// settings store rewritten on every switch would fight the Settings window,
// which is a separate webview reading the same file.
//
// None of these appear in TEDI's Settings any more. `contributes.settings` drew
// a card of seven fields, four of which the pane already decides beside the
// thing they change - the root folder is the first setup step, the web server
// is "Use this" on its own row, the ports are the fields next to it - so the
// card was a second place to look for a decision, and the one that cannot show
// you whether the port is currently bound. The remaining two are a section at
// the bottom of the pane. The keys and their defaults are unchanged, so an
// environment configured through the old card keeps every value.

import { ctx, config, setConfig, warn } from "../runtime.js";
import { paths } from "../core/paths.js";
import { readJson, writeJson } from "../core/fsx.js";

/** Keys owned by the extension settings store, with their fallbacks. */
const SETTING_KEYS = /** @type {const} */ ([
  ["rootDir", ""],
  ["domainSuffix", "test"],
  ["webServer", "nginx"],
  ["httpPort", 80],
  ["httpsPort", 443],
  ["autoHttps", true],
  ["manageHosts", true],
]);

/**
 * The shape persisted in `<root>/config.json`.
 *
 * `skipTerminalPath` lives here rather than in the extension settings because it is
 * not a preference to browse and change, it is a decision already made: the
 * user was asked once whether to put this environment first on the terminal
 * PATH and said no. The card would present it as a switch someone might flip
 * without the context of the question.
 *
 * @typedef {{ defaults?: Record<string, string>, ports?: Record<string, number>,
 *             autostart?: Record<string, boolean>, driversSeeded?: boolean,
 *             skipTerminalPath?: boolean }} StoredConfig
 */

/**
 * Read one namespaced setting, falling back when it is unset or blank.
 *
 * `ctx.settings.get` resolves to `undefined` for a key the user never touched,
 * and a cleared text field gives `""`. Both mean "use the default", and a
 * caller that only checked for undefined would take an empty domain suffix and
 * generate hostnames ending in a bare dot.
 *
 * @template T
 * @param {string} key @param {T} fallback @returns {Promise<T>}
 */
async function setting(key, fallback) {
  try {
    const value = await ctx?.settings.get(key);
    if (value === undefined || value === null || value === "") return fallback;
    return /** @type {T} */ (value);
  } catch {
    return fallback;
  }
}

/**
 * Load settings and the stored config into the live `config` object, and make
 * sure the directory layout exists.
 *
 * Order matters: the root directory has to be resolved from settings BEFORE
 * `config.json` is read, because that file lives inside the root.
 *
 * @returns {Promise<void>}
 */
export async function loadConfig() {
  /** @type {Record<string, unknown>} */
  const patch = {};
  for (const [key, fallback] of SETTING_KEYS) {
    patch[key] = await setting(key, fallback);
  }
  // Ports arrive as strings from a number input that was typed into.
  patch.httpPort = toPort(patch.httpPort, 80);
  patch.httpsPort = toPort(patch.httpsPort, 443);
  patch.domainSuffix =
    String(patch.domainSuffix ?? "test")
      .replace(/^\.+/, "")
      .trim() || "test";
  setConfig(patch);

  // No `ensureDirs` here, deliberately. Creating the environment's directories
  // is filesystem work against a path the USER typed, and a path the OS rejects
  // makes it throw - which, from inside `loadConfig`, happened before the panel
  // was registered and locked the user out of the only screen that could change
  // the setting. `activate()` does it, inside a guard, after registering.

  /** @type {StoredConfig} */
  const stored = await readJson(paths.configFile(), {});
  setConfig({
    defaults: stored.defaults ?? {},
    ports: stored.ports ?? {},
    autostart: stored.autostart ?? {},
    driversSeeded: stored.driversSeeded === true,
    skipTerminalPath: stored.skipTerminalPath === true,
  });
}

/** Persist the parts of config the extension owns.
 *  @returns {Promise<void>} */
async function saveConfig() {
  /** @type {StoredConfig} */
  const stored = {
    defaults: config.defaults,
    ports: config.ports,
    autostart: config.autostart,
    driversSeeded: config.driversSeeded,
    skipTerminalPath: config.skipTerminalPath,
  };
  await writeJson(paths.configFile(), stored);
}

/**
 * What "Start all" leaves alone unless it is asked.
 *
 * Only the scheduler. It fires jobs - `php artisan queue:work`, a backup, a
 * deploy - and a scheduler that comes up because you pressed "Start all" is
 * exactly the scheduler that surprises you at 3am. Everything else is a server
 * sitting on a port waiting to be asked something, which is harmless to have
 * running.
 */
const OFF_BY_DEFAULT = new Set(["cron"]);

/**
 * Does "Start all" bring this service up?
 *
 * The stored record holds only DEPARTURES from the default, never a copy of
 * every service: storing the answer for everything at install time makes it
 * depend on WHEN a service was installed, and silently excludes anything a
 * later release adds without knowing to write it.
 *
 * @param {string} id @returns {boolean}
 */
export function startsWithAll(id) {
  const stored = config.autostart[id];
  if (stored !== undefined) return stored;
  return !OFF_BY_DEFAULT.has(id);
}

/**
 * Include or exclude a service from "Start all".
 *
 * The web servers do not come through here. Their tick is `webServer` - the one
 * that is ticked is the one the project URLs point at - and it is exclusive,
 * because two servers cannot both hold port 80.
 *
 * @param {string} id @param {boolean} on @returns {Promise<void>}
 */
export async function setStartsWithAll(id, on) {
  const next = { ...config.autostart };
  if (on === !OFF_BY_DEFAULT.has(id)) delete next[id];
  else next[id] = on;
  setConfig({ autostart: next });
  await saveConfig();
}

/** Remember that the one-off driver pass has run. @returns {Promise<void>} */
export async function markDriversSeeded() {
  setConfig({ driversSeeded: true });
  await saveConfig();
}

/**
 * Pin a service to a port, or clear the pin.
 *
 * Stored here rather than in the extension settings because it is per service,
 * and the row it belongs on is where it can also say what is bound. The web servers are the exception and
 * deliberately so: their port is `httpPort`, a real setting, because it appears
 * in every project URL - so the dashboard writes THAT rather than a second
 * number that would then have to agree with it.
 *
 * @param {string} id @param {number | null} port
 * @returns {Promise<void>}
 */
export async function setServicePort(id, port) {
  const next = { ...config.ports };
  if (port === null) delete next[id];
  else next[id] = port;
  setConfig({ ports: next });
  await saveConfig();
}

/**
 * Remember that the user chose to leave the terminal PATH alone.
 *
 * Recorded rather than merely tolerated, because the alternative is a setup
 * checklist that asks the same question on every launch. Registering later is
 * still one button on the same row, so this closes nothing off.
 *
 * @param {boolean} skip @returns {Promise<void>}
 */
export async function setSkipTerminalPath(skip) {
  setConfig({ skipTerminalPath: skip });
  await saveConfig();
}

/**
 * A port value that survived a text input.
 * @param {unknown} value @param {number} fallback @returns {number}
 */
function toPort(value, fallback) {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/**
 * The globally active version of a component, or null when none is chosen.
 * @param {string} componentId @returns {string | null}
 */
export function activeVersion(componentId) {
  return config.defaults[componentId] ?? null;
}

/**
 * Set the globally active version and persist it.
 * @param {string} componentId @param {string | null} version
 * @returns {Promise<void>}
 */
export async function setActiveVersion(componentId, version) {
  const next = { ...config.defaults };
  if (version) next[componentId] = version;
  else delete next[componentId];
  setConfig({ defaults: next });
  await saveConfig();
}

/**
 * Write a settings-card value back, and mirror it into the live config.
 *
 * The dashboard needs this for the root folder: it is a setting the Settings
 * window also owns, and a change made here has to be visible to both without
 * either being reloaded. `setConfig` is what makes the current pane agree with
 * the file it just wrote.
 *
 * @param {string} key @param {unknown} value @returns {Promise<void>}
 */
export async function writeSetting(key, value) {
  try {
    await ctx?.settings.set(key, value);
    setConfig({ [key]: value });
  } catch (err) {
    warn("could not write setting", key, err);
  }
}
