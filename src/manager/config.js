// Global configuration.
//
// There are two sources and they answer different questions. The extension's
// SETTINGS CARD owns the handful of values a user edits in Settings (data
// directory, domain suffix, web server, ports); `config.json` in the data root
// owns everything the extension decides for itself, chiefly which version of
// each component is currently active.
//
// They are merged into one live `config` object at activation, and the settings
// card always wins for the keys it owns. Keeping the active-version map out of
// the settings card is deliberate: it changes whenever a user switches a
// runtime, and a settings store that is rewritten on every switch would fight
// the Settings window, which is a separate webview reading the same file.

import { ctx, config, setConfig, warn } from "../runtime.js";
import { paths } from "../core/paths.js";
import { readJson, writeJson } from "../core/fsx.js";

/** Keys owned by the extension settings card, with their fallbacks. */
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
 * `skipTerminalPath` lives here rather than in the settings card because it is
 * not a preference to browse and change, it is a decision already made: the
 * user was asked once whether to put this environment first on the terminal
 * PATH and said no. The card would present it as a switch someone might flip
 * without the context of the question.
 *
 * @typedef {{ defaults?: Record<string, string>, ports?: Record<string, number>,
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
    skipTerminalPath: config.skipTerminalPath,
  };
  await writeJson(paths.configFile(), stored);
}

/**
 * Pin a service to a port, or clear the pin.
 *
 * Stored here rather than in the settings card because it is per service and
 * the card is a fixed list of fields. The web servers are the exception and
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
