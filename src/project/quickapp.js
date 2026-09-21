// Quick app: a new project that already runs.
//
// "New project" makes an empty folder with a domain, and for a static page that
// is the whole job. For the two things people actually start - a Laravel app and
// a WordPress site - an empty folder is the first ten minutes of a tutorial:
// fetch the code, create a database, and copy the credentials into a config
// file by hand. All three are things this environment already knows, so it does
// them.
//
// Nothing is vendored. Laravel comes from `composer create-project` and
// WordPress from wordpress.org, both resolved at run time, so there is no
// template to keep up to date here and no version pinned to the day this was
// written.
//
// Scaffolding runs BEFORE the project is registered, which is not an ordering
// preference: `addProject` writes `.tedi-runtime` into the folder, and
// `composer create-project` refuses a directory that is not empty.

import { fetchText, download } from "../core/net.js";
import { extract } from "../core/archive.js";
import { run } from "../core/proc.js";
import { paths, join } from "../core/paths.js";
import { readText, writeText, exists, move, remove } from "../core/fsx.js";
import { resolveVersion } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import { createDatabase } from "../manager/mysqlusers.js";
import { plannedPort } from "../web/ports.js";
import { start } from "../manager/services.js";
import { state, exeSuffix } from "../runtime.js";

/** @typedef {"empty" | "laravel" | "wordpress"} Template */

/** What "New project" offers. `empty` first, because it is still the common
 *  case and the one that costs nothing. */
export const TEMPLATES = [
  { value: "empty", label: "Empty folder", hint: "Just the folder and its domain" },
  { value: "laravel", label: "Laravel", hint: "composer create-project, with its database" },
  { value: "wordpress", label: "WordPress", hint: "Latest release, wp-config written" },
];

const WORDPRESS_ZIP = "https://wordpress.org/latest.zip";
const WORDPRESS_SALT = "https://api.wordpress.org/secret-key/1.1/salt/";

/** The eight constants WordPress wants unique per install. */
const SALT_KEYS = [
  "AUTH_KEY",
  "SECURE_AUTH_KEY",
  "LOGGED_IN_KEY",
  "NONCE_KEY",
  "AUTH_SALT",
  "SECURE_AUTH_SALT",
  "LOGGED_IN_SALT",
  "NONCE_SALT",
];

/**
 * @typedef {object} Scaffolded
 * @property {string} [docRoot]   Sub-path to serve, when the template has one.
 * @property {string | null} database  The database created, if any.
 * @property {string} [note]      Something that did not work but did not stop it.
 */

/**
 * Fill an empty folder with a working application.
 *
 * @param {Template} template
 * @param {{ dir: string, name: string, url: string,
 *           onStep?: (text: string, pct?: number) => void }} ask
 * @returns {Promise<Scaffolded>}
 */
export async function scaffold(template, ask) {
  if (template === "laravel") return await laravel(ask);
  if (template === "wordpress") return await wordpress(ask);
  return { database: null };
}

/**
 * Laravel, through Composer.
 *
 * `--no-interaction` because there is no terminal attached to answer the
 * starter-kit question with, and Composer left waiting on one looks exactly
 * like a download that stalled.
 *
 * @param {{ dir: string, name: string, url: string,
 *           onStep?: (text: string, pct?: number) => void }} ask
 * @returns {Promise<Scaffolded>}
 */
async function laravel({ dir, name, url, onStep = () => {} }) {
  const php = resolveVersion("php", activeVersion("php"));
  if (!php) throw new Error("Install a PHP version first: Laravel is built by Composer, in PHP.");
  const composer = resolveVersion("composer", activeVersion("composer"));
  if (!composer) throw new Error("Install Composer first, from the Runtimes section.");

  // Composer wants to create the directory itself, and `newProject` has
  // already made it. Removing it is safe: it is empty, and this runs before
  // anything has been registered against it.
  await remove(dir);

  onStep("Composer is fetching Laravel…");
  const res = await run(
    join(php.binDir, `php${exeSuffix()}`),
    [
      join(composer.binDir, "composer.phar"),
      "create-project",
      "laravel/laravel",
      dir,
      "--no-interaction",
      // Composer's own progress bars are drawn with carriage returns, which
      // arrive in the log buffer as one enormous line.
      "--no-progress",
    ],
    { timeoutMs: 20 * 60_000, cwd: paths.www() },
  );
  if (res.code !== 0) {
    const tail = res.out.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(tail || `Composer exited ${res.code}.`);
  }

  onStep("Creating the database…");
  const database = await database4(name);

  const envPath = join(dir, ".env");
  const env = await readText(envPath);
  if (env !== null) {
    await writeText(envPath, laravelEnv(env, { url, database: database.name }));
  }

  return {
    docRoot: "public",
    database: database.name,
    note: database.error ?? undefined,
  };
}

/**
 * Rewrite a Laravel `.env` against this environment.
 *
 * Every `DB_` line is REMOVED and one clean block appended, rather than each
 * being edited in place. A fresh Laravel ships the MySQL block commented out
 * under `DB_CONNECTION=sqlite`, so editing in place would leave the live line
 * saying sqlite and the corrected ones behind a `#`. Removing first also means
 * exactly one definition survives, which matters: phpdotenv takes the last one
 * it reads, and a file with two is a file where the answer depends on order.
 *
 * Exported for the self-check.
 *
 * @param {string} env @param {{ url: string, database: string | null }} to
 * @returns {string}
 */
export function laravelEnv(env, to) {
  const kept = env
    .split(/\r?\n/)
    .filter(
      (line) => !/^\s*#?\s*DB_(CONNECTION|HOST|PORT|DATABASE|USERNAME|PASSWORD|URL)\s*=/.test(line),
    )
    .map((line) => (/^\s*APP_URL\s*=/.test(line) ? `APP_URL=${to.url}` : line));

  const block = to.database
    ? [
        "",
        "DB_CONNECTION=mysql",
        "DB_HOST=127.0.0.1",
        `DB_PORT=${plannedPort("mysql")}`,
        `DB_DATABASE=${to.database}`,
        "DB_USERNAME=root",
        "DB_PASSWORD=",
      ]
    : [];

  return `${[...trimTail(kept), ...block].join("\n")}\n`;
}

/**
 * WordPress, from wordpress.org.
 *
 * @param {{ dir: string, name: string, url: string,
 *           onStep?: (text: string, pct?: number) => void }} ask
 * @returns {Promise<Scaffolded>}
 */
async function wordpress({ dir, name, onStep = () => {} }) {
  const zip = join(paths.downloads(), "wordpress-latest.zip");
  onStep("Downloading WordPress…");
  await download(WORDPRESS_ZIP, zip, {
    onProgress: (pct) => onStep("Downloading WordPress", pct),
  });

  try {
    onStep("Unpacking…");
    await extract(zip, dir);
    // The archive wraps everything in `wordpress/`. Lift it out by renaming
    // that folder over the project, rather than moving several thousand files
    // one at a time.
    const inner = join(dir, "wordpress");
    if (await exists(inner)) {
      const lifted = `${dir}-lift-${Date.now()}`;
      await move(inner, lifted);
      await remove(dir);
      await move(lifted, dir);
    }
  } finally {
    await remove(zip);
  }

  onStep("Creating the database…");
  const database = await database4(name);

  onStep("Writing wp-config.php…");
  const sample = await readText(join(dir, "wp-config-sample.php"));
  if (sample === null) {
    return { database: database.name, note: "wp-config-sample.php was not in the archive." };
  }
  const salts = await fetchText(WORDPRESS_SALT, { timeoutMs: 20_000 }).catch(() => "");
  await writeText(join(dir, "wp-config.php"), wpConfig(sample, { database: database.name, salts }));

  return {
    database: database.name,
    note:
      database.error ??
      (salts ? undefined : "The unique keys could not be fetched; wp-config has the sample ones."),
  };
}

/**
 * Fill in a `wp-config-sample.php`.
 *
 * The four credentials are matched by their PLACEHOLDER, not by the constant
 * name, because that is what the sample file actually guarantees: WordPress has
 * shipped the same four placeholder strings for fifteen years while the
 * formatting around them has changed more than once.
 *
 * Exported for the self-check.
 *
 * @param {string} sample @param {{ database: string | null, salts: string }} to
 * @returns {string}
 */
export function wpConfig(sample, to) {
  let out = sample
    .replace("database_name_here", to.database ?? "wordpress")
    .replace("username_here", "root")
    .replace("password_here", "")
    .replace("'localhost'", `'127.0.0.1:${plannedPort("mysql")}'`);

  // One `define` per key, replaced by the generated line for the same key. The
  // whole salt block is not swapped wholesale: the comment around it explains
  // what these are, and a user who regenerates them later expects to find it.
  for (const key of SALT_KEYS) {
    const generated = new RegExp(`^define\\(\\s*'${key}'.*$`, "m").exec(to.salts ?? "");
    if (!generated) continue;
    out = out.replace(new RegExp(`^define\\(\\s*'${key}'.*$`, "m"), generated[0]);
  }
  return out;
}

/**
 * The database a quick app connects to, created if the server will have it.
 *
 * MySQL is STARTED when it is installed but stopped, because a template whose
 * whole point is "it runs" cannot hand back a config file pointing at a server
 * that is not there. It is never installed here: that is a download with a
 * version choice behind it, and it belongs on the Services row where those are
 * made.
 *
 * @param {string} name
 * @returns {Promise<{ name: string | null, error?: string }>}
 */
async function database4(name) {
  // Dashes are legal in a MySQL name only inside backticks, and every config
  // file this writes would need them quoted too. Underscores are what the rest
  // of the world uses.
  const db = name
    .replace(/-/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 64);
  if (!db) return { name: null, error: "No usable database name." };

  if (state.services.get("mysql")?.state !== "running") {
    const installed = (state.installed.get("mysql") ?? []).length > 0;
    if (!installed)
      return { name: null, error: "MySQL is not installed, so no database was made." };
    const status = await start("mysql");
    if (status.state !== "running") {
      return {
        name: null,
        error: status.error ?? "MySQL would not start, so no database was made.",
      };
    }
  }

  const res = await createDatabase(db);
  return res.ok ? { name: db } : { name: null, error: res.error };
}

/** Drop trailing blank lines, so appending a block does not leave a gap.
 *  @param {string[]} lines @returns {string[]} */
function trimTail(lines) {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}
