// MySQL accounts.
//
// The managed MySQL is initialised `--initialize-insecure`, which means one
// account - `root` with no password - and that is the right default for a
// loopback development database. It stops being right the moment you want a
// project to connect as the account it will use in production, or to hand a
// colleague something that is not root.
//
// Everything here goes through the `mysql` client that ships beside `mysqld`,
// because the alternative is a MySQL protocol implementation and this is a
// version manager. The SQL is passed with `--execute`, and there is a real
// argument against that which does not survive contact with this particular
// server: `CREATE USER ... IDENTIFIED BY '<password>'` is visible in the
// process list while it runs. The managed MySQL is initialised
// `--initialize-insecure`, so `root` has NO password at all, and anybody who
// can read that process list can simply connect as root and read every
// password hash there is. Hiding one statement from them buys nothing.
//
// It bought less than nothing. The SQL used to be written to a file and run
// with `--execute "source <path>"`, and `source` is a command of the mysql
// CLIENT, not SQL: the client only honours it while reading a terminal or a
// pipe. Under `--execute` it is forwarded to the server verbatim, which
// answers `ERROR 1064 ... near 'source D:/DEV ENV/...'`, so every account
// action failed. Verified against the shipped client, 26.7.0: `\\.` (its short
// form) is refused outright with "Unknown command '\\.'", `--named-commands`
// changes neither, and a Windows path additionally trips the client's own
// backslash scanner ("Unknown command '\\D'"). There is no argv-only way to
// make this client read a file - feeding it one needs stdin, which
// `shell_bg_spawn_direct` does not offer. So the file is gone rather than
// worked around.

import { run } from "../core/proc.js";
import { join } from "../core/paths.js";
import { resolveVersion } from "./versions.js";
import { activeVersion } from "./config.js";
import { plannedPort } from "../web/ports.js";
import { state, exeSuffix } from "../runtime.js";

/**
 * @typedef {object} Account
 * @property {string} user
 * @property {string} host  Where it may connect FROM. `%` is anywhere.
 */

/** Legal in a user name or a host pattern here. Deliberately narrower than
 *  MySQL allows: everything outside this is either a mistake or an attempt to
 *  smuggle quoting through, and neither belongs in a dev dashboard. */
const NAME = /^[A-Za-z0-9_.%-]{1,32}$/;

/** The `mysql` client beside the running `mysqld`, or null if none is installed.
 *  @returns {string | null} */
function client() {
  const row = resolveVersion("mysql", activeVersion("mysql"));
  return row ? join(row.binDir, `mysql${exeSuffix()}`) : null;
}

/**
 * Escape a value for a single-quoted SQL string.
 *
 * Backslash first, or escaping the quotes would then have their own backslashes
 * escaped and the string would end early. MySQL treats `\` as an escape inside
 * string literals by default, which is why both characters matter.
 *
 * Exported for the self-check: this is the one function here whose failure
 * is somebody else's SQL running.
 *
 * @param {string} value @returns {string}
 */
export function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The client arguments for one batch of SQL.
 *
 * Exported for the self-check, which exists for one reason: to fail if this is
 * ever routed back through the client's `source` command. See the note at the
 * top of this file for what that cost.
 *
 * `--batch --skip-column-names` makes the output tab-separated rows with no
 * decoration, which is what `parseAccounts` reads.
 *
 * @param {number} port @param {string} sql @returns {string[]}
 */
export function sqlArgs(port, sql) {
  return [
    "--user=root",
    "--host=127.0.0.1",
    `--port=${port}`,
    "--batch",
    "--skip-column-names",
    "--execute",
    sql,
  ];
}

/**
 * Run SQL as root and return stdout.
 *
 * Several statements at once are fine: the client splits `--execute` on `;`
 * itself, so a create-and-grant is one connection rather than two.
 *
 * @param {string} sql
 * @returns {Promise<{ ok: boolean, out: string }>}
 */
async function runSql(sql) {
  const exe = client();
  if (!exe) return { ok: false, out: "MySQL is not installed." };
  if (state.services.get("mysql")?.state !== "running") {
    return { ok: false, out: "MySQL is not running." };
  }
  const res = await run(exe, sqlArgs(plannedPort("mysql"), sql), { timeoutMs: 30_000 });
  return { ok: res.code === 0, out: res.out };
}

/**
 * Every account, minus the ones MySQL creates for itself.
 *
 * `mysql.session`, `mysql.sys` and `mysql.infoschema` are internal: they cannot
 * log in, and offering to drop one is offering to break the server.
 *
 * @returns {Promise<{ ok: boolean, accounts: Account[], error?: string }>}
 */
export async function listAccounts() {
  const res = await runSql("SELECT user, host FROM mysql.user ORDER BY user, host;");
  if (!res.ok)
    return { ok: false, accounts: [], error: res.out.trim() || "Could not list accounts." };
  return { ok: true, accounts: parseAccounts(res.out) };
}

/**
 * Rows out of `mysql --batch --skip-column-names`: one account per line, fields
 * separated by a tab.
 *
 * Exported for the self-check. Parsing is the part of this file that can be
 * wrong without anything failing - a mangled host would offer to drop an
 * account that does not exist, or hide one that does.
 *
 * @param {string} out @returns {Account[]}
 */
export function parseAccounts(out) {
  /** @type {Account[]} */
  const accounts = [];
  for (const line of out.split(/\r?\n/)) {
    const [user, host] = line.split("\t");
    if (!user || !host) continue;
    if (user.startsWith("mysql.")) continue;
    accounts.push({ user, host: host.trim() });
  }
  return accounts;
}

/**
 * Create an account, optionally with every privilege.
 *
 * "Every privilege" is offered because the common case is a project account
 * that owns its own database, and the alternative is a grant editor nobody
 * asked for. It is not the default.
 *
 * @param {{ user: string, host: string, password: string, allPrivileges?: boolean }} account
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createAccount({ user, host, password, allPrivileges }) {
  const bad = validate(user, host);
  if (bad) return { ok: false, error: bad };

  const who = `${sqlString(user)}@${sqlString(host)}`;
  const sql = [
    `CREATE USER ${who} IDENTIFIED BY ${sqlString(password)};`,
    allPrivileges ? `GRANT ALL PRIVILEGES ON *.* TO ${who} WITH GRANT OPTION;` : null,
    "FLUSH PRIVILEGES;",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await runSql(sql);
  return res.ok ? { ok: true } : { ok: false, error: res.out.trim() };
}

/** @param {Account} account @param {string} password
 *  @returns {Promise<{ ok: boolean, error?: string }>} */
export async function setPassword({ user, host }, password) {
  const bad = validate(user, host);
  if (bad) return { ok: false, error: bad };
  const sql = `ALTER USER ${sqlString(user)}@${sqlString(host)} IDENTIFIED BY ${sqlString(password)};\nFLUSH PRIVILEGES;`;
  const res = await runSql(sql);
  return res.ok ? { ok: true } : { ok: false, error: res.out.trim() };
}

/** @param {Account} account @returns {Promise<{ ok: boolean, error?: string }>} */
export async function dropAccount({ user, host }) {
  const bad = validate(user, host);
  if (bad) return { ok: false, error: bad };
  const res = await runSql(`DROP USER ${sqlString(user)}@${sqlString(host)};\nFLUSH PRIVILEGES;`);
  return res.ok ? { ok: true } : { ok: false, error: res.out.trim() };
}

/** Why this name cannot be used, or `null`.
 *  @param {string} user @param {string} host @returns {string | null} */
function validate(user, host) {
  if (!NAME.test(user)) return `"${user}" is not a usable account name.`;
  if (!NAME.test(host)) return `"${host}" is not a usable host pattern.`;
  return null;
}
