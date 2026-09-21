// Backing a project up: its folder and its database, in one zip.
//
// The database half is the only part with a decision in it. A project says
// which database it uses in its own `.env` (`DB_CONNECTION`, `DB_DATABASE`),
// and that file is read for the NAME and the credentials - but never for the
// host or the port. Those come from the running managed service, because the
// two disagree exactly when it matters: `.env` says 3306 because that is what
// everybody writes, and this extension moves a database off 3306 when something
// else already holds it. Dumping what `.env` literally says would then reach
// whatever OTHER server owns that port.
//
// The dump is written with `--result-file` / `--file` rather than by capturing
// stdout. `run` collects output through the host's log ring buffer, which is
// bounded and re-encoded: a 200 MB dump would come back truncated, silently,
// and only the restore months later would find out. `pg_dump` additionally gets
// `--no-password`, because `shell_bg_spawn_direct` gives a child no stdin - a
// password prompt would not fail, it would HANG until the timeout.
//
// The `.sql` is written INSIDE the project folder and deleted afterwards, which
// is what keeps the archiver call a single directory with a single root. The
// name carries the timestamp, so it cannot collide with a dump the user keeps
// in there themselves.

import { run, runWithInput } from "../core/proc.js";
import { pack, extract } from "../core/archive.js";
import { paths, join } from "../core/paths.js";
import { remove, readDir, readText } from "../core/fsx.js";
import { resolveVersion } from "./versions.js";
import { activeVersion } from "./config.js";
import { plannedPort } from "../web/ports.js";
import { config, state, exeSuffix } from "../runtime.js";

/**
 * @typedef {object} DbTarget
 * @property {"mysql"|"postgres"} service
 * @property {string} database
 * @property {string} user      Blank means the service's own superuser.
 * @property {string} password  Blank means none, which is how both are initialised.
 */

/** What a `DB_CONNECTION` value means. MariaDB speaks the MySQL protocol and
 *  uses the same client, and Laravel writes `pgsql` where everything else
 *  writes `postgres`. */
/** @type {Record<string, "mysql"|"postgres">} */
const DRIVERS = {
  mysql: "mysql",
  mariadb: "mysql",
  pgsql: "postgres",
  postgres: "postgres",
  postgresql: "postgres",
};

/** Folders restored by one command, offered as a default exclusion because they
 *  are routinely larger than everything else in the project put together. */
export const HEAVY = ["node_modules", "vendor"];

/**
 * The database a dotenv file points at, or null.
 *
 * Exported for the self-check: this decides what gets dumped, and its failure
 * mode is a backup that looks complete and carries the wrong database, or none.
 *
 * @param {string | null} text
 * @returns {DbTarget | null}
 */
export function parseEnvDb(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      // A quoted value keeps everything inside the quotes, a hash included: a
      // password is exactly the field somebody puts one in.
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[m[1]] = value;
  }

  const service = DRIVERS[(env.DB_CONNECTION ?? "").toLowerCase()];
  if (!service || !env.DB_DATABASE) return null;
  return {
    service,
    database: env.DB_DATABASE,
    user: env.DB_USERNAME ?? "",
    password: env.DB_PASSWORD ?? "",
  };
}

/** The dump program beside the active service binaries, or null when that
 *  service is not installed.
 *  @param {"mysql"|"postgres"} service @returns {string | null} */
function dumper(service) {
  const row = resolveVersion(service, activeVersion(service));
  const exe = service === "mysql" ? "mysqldump" : "pg_dump";
  return row ? join(row.binDir, `${exe}${exeSuffix()}`) : null;
}

/** Where the service is actually listening, falling back to where it would be.
 *  @param {string} service @returns {number} */
function servicePort(service) {
  return state.services.get(service)?.port ?? plannedPort(service);
}

/**
 * Argv for one dump.
 *
 * Exported for the self-check, which pins the three arguments that are not
 * obvious from reading it: the dump goes to a FILE, `--databases` puts the
 * `CREATE DATABASE` back in so a restore is one command, and `pg_dump` never
 * prompts.
 *
 * @param {DbTarget} target @param {number} port @param {string} outFile
 * @returns {string[]}
 */
export function dumpArgs(target, port, outFile) {
  if (target.service === "mysql") {
    return [
      "--host=127.0.0.1",
      `--port=${port}`,
      `--user=${target.user || "root"}`,
      // Omitted rather than passed empty: `--password=` with nothing after it
      // is how you tell this client to prompt, and there is no stdin to prompt
      // on. A password that IS set goes on argv and is visible in the process
      // list for the length of the dump, which buys nothing to hide - this
      // server is initialised `--initialize-insecure`, so anybody who can read
      // that list can connect as root anyway.
      ...(target.password ? [`--password=${target.password}`] : []),
      "--single-transaction",
      "--routines",
      "--triggers",
      // Without this the dump carries `SET @@GLOBAL.GTID_PURGED=...`, and
      // restoring that into a server that has already run a transaction - which
      // any development MySQL has - fails outright with "GTID_PURGED can only
      // be set when GTID_EXECUTED is empty". mysqldump warns about it on
      // stderr and still exits 0, so the backup looks fine until the day it is
      // needed. Verified against the shipped client, 26.7.0.
      "--set-gtid-purged=OFF",
      `--result-file=${outFile}`,
      "--databases",
      target.database,
    ];
  }
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    `--username=${target.user || "postgres"}`,
    "--no-password",
    "--create",
    `--file=${outFile}`,
    target.database,
  ];
}

/**
 * Dump one database to `outFile`.
 *
 * @param {DbTarget} target @param {string} outFile
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function dumpDatabase(target, outFile) {
  const label = target.service === "mysql" ? "MySQL" : "PostgreSQL";
  const exe = dumper(target.service);
  if (!exe) return { ok: false, error: `${label} is not installed.` };
  if (state.services.get(target.service)?.state !== "running") {
    return { ok: false, error: `${label} is not running, so it cannot be dumped.` };
  }

  const res = await run(exe, dumpArgs(target, servicePort(target.service), outFile), {
    timeoutMs: 15 * 60_000,
  });
  if (res.code === 0) return { ok: true };
  const tail = res.out.trim().split(/\r?\n/).slice(-3).join(" ");
  return { ok: false, error: tail || `${label} could not dump ${target.database}.` };
}

/** `2026-09-20-1432`, sortable and legal in a filename on every platform.
 *  @returns {string} */
function stamp() {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Back a project up. Returns the path of the archive it wrote.
 *
 * @param {import("../runtime.js").Project} project
 * @param {{ db?: DbTarget | null, skipHeavy?: boolean, onStep?: (text: string) => void }} [opts]
 * @returns {Promise<string>}
 */
export async function backupProject(project, opts = {}) {
  const when = stamp();
  const out = join(paths.backups(), `${project.name}-${when}.zip`);
  const onStep = opts.onStep ?? (() => {});

  /** @type {string | null} */
  let dumpFile = null;
  if (opts.db?.database) {
    // The database name is typed by hand in the dialog and is about to become a
    // filename inside someone's project, so it is reduced to characters that
    // cannot leave that folder or upset a filesystem. The name INSIDE the dump
    // is untouched: this is the label on the file, not the database.
    const safe = opts.db.database.replace(/[^A-Za-z0-9._-]/g, "_");
    dumpFile = join(project.path, `${safe}-${when}.sql`);
    onStep(`Dumping ${opts.db.database}…`);
    const res = await dumpDatabase(opts.db, dumpFile);
    if (!res.ok) {
      // A failed dump leaves a part-written file behind, and a part-written
      // dump inside a backup is worse than none: it restores.
      await remove(dumpFile);
      throw new Error(res.error ?? "The database could not be dumped.");
    }
  }

  try {
    onStep("Compressing…");
    await pack(project.path, out, { exclude: opts.skipHeavy ? HEAVY : [] });
  } finally {
    if (dumpFile) await remove(dumpFile);
  }
  // After the new one is safely written, never before: a prune that ran first
  // would make room by deleting a backup and then fail to write its
  // replacement.
  await pruneBackups(project.name, config.keepBackups);
  return out;
}

/**
 * Every backup zip on disk, newest first.
 *
 * @returns {Promise<{ name: string, path: string, size: number, mtime: number,
 *                     project: string }[]>}
 */
export async function listBackups() {
  const dir = paths.backups();
  const entries = await readDir(dir);
  return entries
    .filter((e) => e.kind === "file" && /\.zip$/i.test(e.name))
    .map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      size: e.size,
      mtime: e.mtime,
      project: backupProjectName(e.name),
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Which project an archive belongs to.
 *
 * `<project>-<date>-<time>.zip`, so the project is everything before the
 * timestamp `stamp()` writes: a name with its own dashes survives, and a zip
 * somebody dropped in here by hand keeps its whole name and simply groups
 * alone. Exported for the self-check, because this string is what `prune`
 * compares against - a parse that ate one dash too many would file a backup
 * under a project that is not its own.
 *
 * @param {string} file @returns {string}
 */
export function backupProjectName(file) {
  return file.replace(/\.zip$/i, "").replace(/-\d{4}-\d{2}-\d{2}-\d{4}$/, "");
}

/**
 * Keep the newest `keep` backups OF ONE PROJECT and delete the rest.
 *
 * Per project rather than across the folder, and that is the whole safety
 * argument: a global "keep 10" run after backing up one project deletes the
 * history of the two projects you did not touch. Scoped this way, the only
 * files a backup can ever remove are older copies of the thing just backed up.
 *
 * @param {string} project @param {number} keep  Zero or less keeps everything.
 * @returns {Promise<number>} how many were deleted
 */
export async function pruneBackups(project, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const mine = (await listBackups()).filter((b) => b.project === project);
  const doomed = mine.slice(keep);
  for (const backup of doomed) await remove(backup.path);
  return doomed.length;
}

/**
 * Put a backup back: the files, and the dump inside it.
 *
 * The files are EXTRACTED OVER their old home rather than into a clean folder:
 * `tar -x` overwrites what the archive carries and leaves everything else
 * alone, so a restore cannot silently delete the `storage/` a backup was
 * taken before. Emptying the folder first would be the tidier-looking choice
 * and the one that loses work.
 *
 * Where "home" is: the folder the matching project already sits in, so a
 * project registered from outside `www` is restored where it lives rather than
 * cloned into `www` under the same domain. With no such project it goes to
 * `www`, which is where Refresh will find it.
 *
 * @param {{ path: string, project: string }} backup
 * @param {{ into?: string, database?: boolean, onStep?: (text: string) => void }} [opts]
 * @returns {Promise<{ dir: string, database: string | null }>}
 */
export async function restoreBackup(backup, opts = {}) {
  const onStep = opts.onStep ?? (() => {});
  const into = opts.into ?? paths.www();

  onStep("Unpacking…");
  await extract(backup.path, into);
  const dir = join(into, backup.project);

  if (opts.database === false) return { dir, database: null };

  onStep("Looking for a dump…");
  const dump = await findDump(dir);
  if (!dump) return { dir, database: null };

  // Which server the dump belongs to is read from the project's own `.env`,
  // the same file the backup read when it decided what to dump. A dump with no
  // `.env` beside it is left on disk rather than guessed at: importing a
  // PostgreSQL script into MySQL fails late, after it has already run half of
  // whatever it could parse.
  const target = parseEnvDb(await readText(join(dir, ".env")));
  if (!target) return { dir, database: null };

  onStep(`Importing ${target.database}…`);
  const res = await importDump(target, dump);
  if (!res.ok) throw new Error(res.error ?? "The dump could not be imported.");
  return { dir, database: target.database };
}

/** The newest `.sql` at the root of a restored project, or null.
 *  @param {string} dir @returns {Promise<string | null>} */
async function findDump(dir) {
  const sql = (await readDir(dir))
    .filter((e) => e.kind === "file" && /\.sql$/i.test(e.name))
    .sort((a, b) => b.mtime - a.mtime);
  return sql[0] ? join(dir, sql[0].name) : null;
}

/**
 * Load a `.sql` script into its server.
 *
 * The two clients need opposite things. `psql` reads a file itself with `-f`,
 * and needs `ON_ERROR_STOP=1` or it runs to the end and exits 0 after every
 * statement has failed - a restore that reports success and restored nothing.
 * The MySQL client has no such flag and must be fed through stdin, which is
 * what `runWithInput` exists for; it stops at the first error by default.
 *
 * @param {DbTarget} target @param {string} file
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function importDump(target, file) {
  const label = target.service === "mysql" ? "MySQL" : "PostgreSQL";
  const row = resolveVersion(target.service, activeVersion(target.service));
  if (!row) return { ok: false, error: `${label} is not installed.` };
  if (state.services.get(target.service)?.state !== "running") {
    return { ok: false, error: `${label} is not running, so nothing can be imported.` };
  }
  const port = servicePort(target.service);
  const timeoutMs = 30 * 60_000;

  const res =
    target.service === "mysql"
      ? await runWithInput(
          join(row.binDir, `mysql${exeSuffix()}`),
          [
            "--host=127.0.0.1",
            `--port=${port}`,
            `--user=${target.user || "root"}`,
            ...(target.password ? [`--password=${target.password}`] : []),
          ],
          file,
          { timeoutMs },
        )
      : await run(
          join(row.binDir, `psql${exeSuffix()}`),
          [
            "--host=127.0.0.1",
            `--port=${port}`,
            `--username=${target.user || "postgres"}`,
            "--no-password",
            "--set=ON_ERROR_STOP=1",
            `--file=${file}`,
            // The database to connect to while the script runs. Our own dumps
            // carry `CREATE DATABASE` and switch to it themselves, so this is
            // only the doorway in, and `postgres` is the one initdb always makes.
            "postgres",
          ],
          { timeoutMs },
        );

  if (res.code === 0) return { ok: true };
  const tail = res.out.trim().split(/\r?\n/).slice(-3).join(" ");
  return { ok: false, error: tail || `${label} refused the dump (exit ${res.code}).` };
}
