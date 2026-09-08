// Make the current set of projects actually reachable.
//
// Three things have to happen together and always did: the vhost files are
// regenerated (which is also where each site's certificate is issued), the
// hosts file is brought in line with the domains, and the running web server is
// told to pick the new configuration up. A vhost with no hosts entry does not
// resolve; a hosts entry with no vhost lands on the default site; either half
// on its own is a confusing result rather than half a feature.
//
// It used to live behind an "Apply changes" button only, which meant adding a
// project gave you a row in a list and nothing served. Every path that changes
// which projects exist calls this now, so a new project is a working
// https://<name>.test without anyone pressing anything.

import { generate, servedProjects } from "./vhost.js";
import { applyHosts } from "./hosts.js";
import { restart } from "../manager/services.js";
import { installedOf } from "../manager/versions.js";
import { WEB_SERVERS } from "./ports.js";
import { state, config, ctx, warn } from "../runtime.js";

/**
 * @typedef {object} PublishResult
 * @property {string[]} domains          Domains now served.
 * @property {boolean} hostsOk           False when the hosts file could not be written.
 * @property {string} [hostsMessage]     Why, when it could not.
 * @property {boolean} restarted         Whether the web server was reloaded.
 */

/**
 * Publish, and say so when it fails.
 *
 * Every call site used to be `publish().catch(() => {})`, which is how a
 * half-written config went unnoticed for a whole evening: `generate` threw
 * partway through Apache, the caller shrugged, and the server was left serving
 * one site out of two with nothing on screen and nothing in the log.
 *
 * Still non-throwing - a UI handler that rejects is a worse outcome than a
 * stale vhost - but the reason now reaches the log and the user.
 *
 * @param {{ hosts?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function republish(opts = {}) {
  try {
    await publish(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn("could not publish", message);
    ctx?.ui.toast(`The server configuration could not be written: ${message}`, {
      variant: "error",
    });
  }
}

/**
 * Regenerate vhosts and certificates, sync the hosts file, reload the server.
 *
 * @param {{ hosts?: boolean }} [opts] `hosts: false` skips the elevation prompt,
 *        for a caller that has already synced or knows nothing changed.
 * @returns {Promise<PublishResult>}
 */
export async function publish(opts = {}) {
  // Every installed web server, not only the active one. Each has its own
  // `conf/<server>/` tree and its own ports, so keeping both current costs a
  // few kilobytes and means starting the other one never serves a config from
  // three project changes ago. The active one is always included even when it
  // has no managed install, because a detected system server is still the one
  // that will be started.
  const servers = WEB_SERVERS.filter((id) => id === config.webServer || installedOf(id).length > 0);

  // The user's projects plus the tools this extension serves - phpMyAdmin is
  // not a project, but it still needs a vhost, a certificate and a hosts entry.
  // Asked of `servedProjects` rather than assembled here, because the web
  // server's own start regenerates the same vhosts and the two lists must be
  // the same list.
  const served = await servedProjects();

  /** @type {string[]} */
  let domains = [];
  for (const server of servers) {
    ({ domains } = await generate(served, server));
  }

  let hostsOk = true;
  /** @type {string | undefined} */
  let hostsMessage;
  if (config.manageHosts && opts.hosts !== false) {
    const res = await applyHosts(domains);
    hostsOk = res.ok;
    hostsMessage = res.message;
  }

  // Whichever server is actually UP, not whichever one is configured.
  //
  // Those are not always the same: `recoverRunning` adopts a web server it finds
  // still running after a crash whatever `webServer` says, and a user can start
  // the other one from its own row. Reloading the configured one meant
  // regenerating every vhost and then reloading a server that was not running,
  // while the one answering on port 80 kept serving a config from before the
  // change - which reads as a new site resolving to an old one.
  //
  // Only a server already up: starting one here would mean adding a project
  // silently begins listening on port 80, which is not what "add a project"
  // asked for.
  const live = WEB_SERVERS.find((id) => state.services.get(id)?.state === "running") ?? null;
  const restarted = live !== null;
  if (live) await restart(live);

  return { domains, hostsOk, hostsMessage, restarted };
}
