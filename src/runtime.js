// Shared runtime state for the Dev Environment extension.
//
// esbuild preserves ESM live bindings across the bundle, so every other module
// reads `ctx` and `state` live and mutates only through the setters here. This
// is the ONE owner of that state: a second copy anywhere else is how a module
// ends up acting on a `ctx` that was already torn down.

/** @typedef {import("../tedi").ExtensionContext} ExtensionContext */

/** @type {ExtensionContext | null} */
export let ctx = null;

/** @param {ExtensionContext | null} value */
export function setCtx(value) {
  ctx = value;
}

/**
 * Global configuration, mirrored from `<root>/config.json` and the extension's
 * own settings card. Read live by everything; written only through
 * `manager/config.js` so the on-disk copy and this never disagree.
 *
 * @typedef {object} DevenvConfig
 * @property {string} rootDir           Resolved data root, absolute, no trailing slash.
 * @property {string} domainSuffix      Default suffix, no leading dot, e.g. "test".
 * @property {"nginx"|"apache"} webServer
 * @property {number} httpPort
 * @property {number} httpsPort
 * @property {boolean} autoHttps
 * @property {boolean} manageHosts
 * @property {Record<string, string>} defaults  Global active version per runtime id.
 * @property {Record<string, number>} ports  Port a service was explicitly given,
 *   per id. Absent means "the conventional default for that service".
 * @property {boolean} skipTerminalPath  The user chose to leave the terminal
 *   PATH alone. Their decision, remembered, not a step still outstanding.
 */

/** @type {DevenvConfig} */
export const config = {
  rootDir: "",
  domainSuffix: "test",
  webServer: "nginx",
  httpPort: 80,
  httpsPort: 443,
  autoHttps: true,
  manageHosts: true,
  defaults: {},
  ports: {},
  skipTerminalPath: false,
};

/** @param {Partial<DevenvConfig>} patch */
export function setConfig(patch) {
  Object.assign(config, patch);
}

/**
 * @typedef {object} InstalledVersion
 * @property {string} component  Provider id, e.g. "php".
 * @property {string} version
 * @property {string} dir        Absolute install directory.
 * @property {string} binDir     Absolute directory holding the executables.
 * @property {"download"|"system"} origin
 */

/**
 * @typedef {object} ServiceStatus
 * @property {string} id
 * @property {"stopped"|"starting"|"running"|"error"} state
 * @property {number | null} handle   `shell_bg_spawn_direct` handle while running.
 * @property {number | null} port
 * @property {string | null} error
 * @property {string | null} version
 */

/**
 * What one component is doing while it installs.
 *
 * @typedef {object} BusyState
 * @property {string} text   What is happening, e.g. "Downloading node-v24.zip".
 * @property {number} [pct]  0-100 while a transfer is running; absent for a
 *   step that has no measurable length, which is what tells the UI to leave the
 *   bar indeterminate rather than draw a confident 0%.
 * @property {number} [step]   Which component of a batch this is, 1-based.
 * @property {number} [total]  How many the batch has.
 */

/**
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} path        Absolute project root.
 * @property {string} [suffix]    Overrides the global domain suffix.
 * @property {string} [domain]    Fully overrides the computed domain.
 * @property {string} [php]       Pinned PHP version.
 * @property {string} [node]      Pinned Node version.
 * @property {string} [docRoot]   Sub-path served, relative to `path`.
 * @property {"php"|"static"|"proxy"} [kind]
 * @property {number} [proxyPort] Backend port when `kind` is "proxy".
 * @property {boolean} [https]
 * @property {boolean} [enabled]
 */

export const state = {
  /** Latched false on deactivate so late async work becomes a no-op. Every
   *  long-running loop checks this rather than assuming it still owns the app. */
  active: false,

  /** Installed versions per component id. @type {Map<string, InstalledVersion[]>} */
  installed: new Map(),

  /** Live service status per id. @type {Map<string, ServiceStatus>} */
  services: new Map(),

  /** Registered projects. @type {Project[]} */
  projects: [],

  /**
   * In-flight installs, component id -> what it is doing, so the dashboard can
   * show progress without every view polling the network itself.
   *
   * Structured rather than a pre-formatted string. It used to be
   * `"Downloading php-8.4.12-nts-Win32-vs17-x64.zip 45%"`, which a progress BAR
   * can only use by parsing its own label back apart - and a percentage read
   * out of a filename is a bug waiting for the first archive whose name
   * contains a `%`.
   *
   * @type {Map<string, BusyState>}
   */
  busy: new Map(),

  /** Mounted dashboard views. Each is a re-render callback; a mounted view is
   *  also what makes the status poll run at all. @type {Set<() => void>} */
  views: new Set(),

  /** Set by activate() so the status item and commands share one implementation
   *  without statusbar.js importing index.js and closing a cycle.
   *  @type {(() => void) | null} */
  onOpen: null,

  /** Why the environment could not be prepared at activation, if it could not.
   *  Almost always an unusable root folder. The panel still mounts and shows
   *  this on the setup screen, because the step that fixes it is on that screen.
   *  @type {string | null} */
  startupError: null,

  /** Status poll handle. @type {ReturnType<typeof setInterval> | null} */
  timer: null,

  /** Last error worth surfacing on the dashboard. @type {string | null} */
  error: null,

  /** Bumped every time a scheduled job finishes.
   *
   *  The poll repaints only when `statusSignature` changes, and a cron run
   *  changes nothing else it looks at - so a job that ran two minutes ago would
   *  keep showing its previous result until the user touched something. A
   *  counter is enough: the signature only has to DIFFER, it does not have to
   *  describe what happened. */
  cronRuns: 0,
};

/**
 * A cheap fingerprint of everything the status poll can change.
 *
 * The poll used to repaint unconditionally every four seconds, and a repaint is
 * a full `replaceChildren` plus the async sections re-resolving - which re-reads
 * php.ini, re-runs `php -m`, and re-resolves every project. The visible result
 * was a panel that flickered and jumped on a timer while nothing was happening,
 * and a window where the sections were briefly absent (an automated check caught
 * the pane mid-rebuild).
 *
 * So the poll now compares this string and repaints only on a real change.
 * Anything a user does still repaints immediately, because those paths call
 * `refresh()` directly rather than waiting for the timer.
 *
 * @returns {string}
 */
export function statusSignature() {
  const services = [...state.services.values()]
    .map((s) => `${s.id}:${s.state}:${s.port ?? ""}:${s.error ?? ""}`)
    .join("|");
  const installed = [...state.installed.entries()]
    .map(([id, rows]) => `${id}:${rows.length}`)
    .join("|");
  const busy = [...state.busy.entries()]
    .map(([id, b]) => `${id}:${b.text}:${b.pct ?? ""}`)
    .join("|");
  return `${services}#${installed}#${busy}#${state.projects.length}#${state.cronRuns}`;
}

/** Re-render every mounted view. Safe to call when none are mounted. */
export function repaint() {
  for (const view of state.views) {
    try {
      view();
    } catch (err) {
      console.error("[devenv] view repaint threw", err);
    }
  }
}

/**
 * Wrap `fn` so it runs at most once every `ms`.
 *
 * For repaint during a download. `curl` reports a new percentage up to a
 * hundred times per transfer, and each one used to rebuild the whole panel -
 * visible as a flicker, and every rebuild re-ran the setup probes behind it. The
 * caller still repaints unconditionally when the work FINISHES, so the last
 * frame is never the one that got dropped.
 *
 * @param {() => void} fn
 * @param {number} [ms]
 * @returns {() => void}
 */
export function throttle(fn, ms = 150) {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn();
  };
}

export function clearTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** `true` on Windows, where paths are backslashed and binaries end in `.exe`. */
export function isWindows() {
  return ctx?.os?.platform === "windows";
}

export function isMac() {
  return ctx?.os?.platform === "macos";
}

/** Normalised CPU architecture, as the download providers spell it. */
export function arch() {
  return ctx?.os?.arch === "aarch64" ? "arm64" : "x64";
}

/** Executable suffix for this platform. */
export function exeSuffix() {
  return isWindows() ? ".exe" : "";
}

/** Log at `warn`, never `info`: `ctx.logger.info` is dropped in release builds,
 *  so a swallowed capability failure logged at info is invisible exactly when a
 *  user is trying to report it.
 *  @param {...unknown} args */
export function warn(...args) {
  ctx?.logger?.warn?.("[devenv]", ...args);
}

/** @param {...unknown} args */
export function fail(...args) {
  ctx?.logger?.error?.("[devenv]", ...args);
}
