// What this environment offers to OTHER extensions, as one small file.
//
// There is no cross-extension channel in the host and that is deliberate:
// `ctx.settings`, `ctx.events` and `ctx.secrets` all namespace the key under
// the id of whoever is CALLING, so `tedi.devenv` writing
// `ext:tedi.sql-explorer:connections` is not merely discouraged, it is
// unreachable. Reaching around the host into the app's settings file would work
// today and break on the release after next, and it would be a deliberate
// namespace boundary walked through backwards.
//
// So the handoff is a file in the one place both sides can name without being
// configured - `~/.tedi/`, the same convention `tedi.browser` uses for its own
// state - and it is a PUBLISHED FACT, not a command: "these managed databases
// exist, here is how to reach them". Whoever reads it decides what to do. It
// carries no password because there is none to carry: mysqld is initialised
// `--initialize-insecure` and initdb with `-A trust`, both bound to loopback.
//
// The record shape is SQL Explorer's own connection record, so that reader can
// run its existing import sanitiser over these unchanged rather than growing a
// second parser for the same thing.

import { installedOf } from "./versions.js";
import { plannedPort } from "../web/ports.js";
import { writeJson, remove } from "../core/fsx.js";
import { paths, join } from "../core/paths.js";
import { warn } from "../runtime.js";

/** Where the file lives. Fixed, so a reader needs no configuration.
 *  @returns {string} */
function handoffFile() {
  return join(paths.home(), ".tedi", "dev-environment.json");
}

const HANDOFF_KIND = "tedi-dev-environment";
const HANDOFF_VERSION = 1;

/** The database services worth offering, and who to log in as.
 *  Both are trust/insecure auth on loopback, set up that way at init. */
const OFFERED = [
  { id: "mysql", label: "MySQL", user: "root", database: "" },
  // PostgreSQL binds ONE database per connection, so unlike MySQL this field is
  // the connect target and cannot be blank. `postgres` is the one initdb makes.
  { id: "postgres", label: "PostgreSQL", user: "postgres", database: "postgres" },
];

/**
 * The connection rows for whatever databases are installed right now.
 *
 * Exported for the self-check, and because it is the whole content decision:
 * everything else in this file is writing it out.
 *
 * @returns {{ id: string, kind: string, name: string, host: string, port: string,
 *             user: string, database: string, sslMode: string }[]}
 */
export function offeredConnections() {
  return OFFERED.filter((d) => installedOf(d.id).length > 0).map((d) => ({
    // Stable across restarts, ports and versions, so a reader that merges by id
    // updates its row instead of collecting a new one every time a port moves.
    id: `devenv:${d.id}`,
    kind: d.id,
    name: `${d.label} (Dev Environment)`,
    host: "127.0.0.1",
    port: String(plannedPort(d.id)),
    user: d.user,
    database: d.database,
    sslMode: "none",
  }));
}

/**
 * Write the file, or delete it when there is nothing to offer.
 *
 * Deleting matters: a stale file left behind after the last database is removed
 * would keep offering connections to a server that is gone, and a reader has no
 * way to tell that from one that is merely stopped.
 *
 * Never throws. This is a courtesy to another extension, not a step in
 * installing anything, so a read-only home directory must not fail an install.
 *
 * @returns {Promise<void>}
 */
export async function publishHandoff() {
  const file = handoffFile();
  if (!paths.home()) return;
  try {
    const connections = offeredConnections();
    if (connections.length === 0) {
      await remove(file);
      return;
    }
    await writeJson(file, {
      kind: HANDOFF_KIND,
      version: HANDOFF_VERSION,
      root: paths.root(),
      connections,
    });
  } catch (err) {
    warn("could not publish the database handoff file", err);
  }
}
