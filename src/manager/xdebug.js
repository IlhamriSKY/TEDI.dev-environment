// Xdebug.
//
// A thin layer over the extension manager, because Xdebug is the extension
// people actually want and the one with the most ways to be almost-working:
//
//   - it is a ZEND extension, so an `extension=xdebug` line loads nothing and
//     reports nothing (handled in phpext.js);
//   - since Xdebug 3 it does nothing at all unless `xdebug.mode` is set, and
//     the default is `develop` only if the ini says so;
//   - the client port changed from 9000 to 9003 in Xdebug 3, and 9000 collides
//     with php-fpm, which is why a debugger silently never connects.
//
// So "install Xdebug" here means install it, load it correctly, and write a
// configuration that actually debugs.

import { readText, writeText } from "../core/fsx.js";
import { installExtension, enable, listExtensions, manageable } from "./phpext.js";
import { ensureIni, iniPathFor, setDirective, getDirective } from "./phpini.js";

/** Xdebug's own default client port since version 3. Deliberately not 9000. */
const DEFAULT_PORT = 9003;

/** The modes Xdebug 3 understands, with what each is for. */
export const MODES = /** @type {const} */ ([
  { value: "off", label: "Off", hint: "Loaded but inactive, with no overhead" },
  { value: "develop", label: "Develop", hint: "Better var_dump and error messages" },
  { value: "debug", label: "Debug", hint: "Step debugging from your editor" },
  { value: "develop,debug", label: "Develop + Debug", hint: "The usual choice" },
  { value: "coverage", label: "Coverage", hint: "For code-coverage reports" },
  { value: "profile", label: "Profile", hint: "Writes cachegrind files; slow" },
]);

/**
 * @typedef {object} XdebugStatus
 * @property {boolean} installed
 * @property {boolean} enabled
 * @property {string | null} mode
 * @property {number} port
 * @property {string | null} blocked  Why it cannot be managed, if it cannot.
 */

/**
 * @param {string} phpVersion
 * @returns {Promise<XdebugStatus>}
 */
export async function status(phpVersion) {
  const check = await manageable(phpVersion);
  const rows = await listExtensions(phpVersion);
  const row = rows.find((r) => r.name === "xdebug");

  const info = await iniPathFor(phpVersion);
  const ini = info ? ((await readText(info.path)) ?? "") : "";
  const port = parseInt(getDirective(ini, "xdebug.client_port") ?? "", 10);

  return {
    installed: Boolean(row?.present),
    enabled: Boolean(row?.enabled),
    mode: getDirective(ini, "xdebug.mode"),
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    blocked: check.ok ? null : (check.reason ?? null),
  };
}

/**
 * Install Xdebug for a PHP version and configure it to actually work.
 *
 * @param {string} phpVersion
 * @param {{ mode?: string, port?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function install(phpVersion, opts = {}) {
  await installExtension("xdebug", phpVersion);
  await configure(phpVersion, {
    mode: opts.mode ?? "develop,debug",
    port: opts.port ?? DEFAULT_PORT,
  });
}

/**
 * Write Xdebug's settings.
 *
 * `start_with_request=trigger` rather than `yes` on purpose: `yes` makes every
 * single request wait for a debugger that is usually not listening, which reads
 * to a user as "my site got slow and then hung". `trigger` debugs only requests
 * that ask for it, which is what an IDE's browser extension sends.
 *
 * @param {string} phpVersion
 * @param {{ mode?: string, port?: number, discoverClientHost?: boolean }} settings
 * @returns {Promise<void>}
 */
export async function configure(phpVersion, settings) {
  await ensureIni(phpVersion);
  const info = await iniPathFor(phpVersion);
  if (!info) throw new Error(`PHP ${phpVersion} is not installed.`);

  let content = (await readText(info.path)) ?? "";
  const pairs = /** @type {[string, string][]} */ ([
    ["xdebug.mode", settings.mode ?? "develop,debug"],
    ["xdebug.client_host", "127.0.0.1"],
    ["xdebug.client_port", String(settings.port ?? DEFAULT_PORT)],
    ["xdebug.start_with_request", "trigger"],
    ["xdebug.idekey", "TEDI"],
  ]);
  for (const [key, value] of pairs) content = setDirective(content, key, value);
  await writeText(info.path, content);
}

/** Turn Xdebug on or off without uninstalling it.
 *  @param {string} phpVersion @param {boolean} on @returns {Promise<void>} */
export async function setEnabled(phpVersion, on) {
  await enable("xdebug", phpVersion, on);
}

/** Change only the mode, for the dashboard's quick switch.
 *  @param {string} phpVersion @param {string} mode @returns {Promise<void>} */
export async function setMode(phpVersion, mode) {
  await configure(phpVersion, { mode });
}
