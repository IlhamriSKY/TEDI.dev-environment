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

import { generate } from "./vhost.js";
import { applyHosts } from "./hosts.js";
import { restart } from "../manager/services.js";
import { state, config } from "../runtime.js";

/**
 * @typedef {object} PublishResult
 * @property {string[]} domains          Domains now served.
 * @property {boolean} hostsOk           False when the hosts file could not be written.
 * @property {string} [hostsMessage]     Why, when it could not.
 * @property {boolean} restarted         Whether the web server was reloaded.
 */

/**
 * Regenerate vhosts and certificates, sync the hosts file, reload the server.
 *
 * @param {{ hosts?: boolean }} [opts] `hosts: false` skips the elevation prompt,
 *        for a caller that has already synced or knows nothing changed.
 * @returns {Promise<PublishResult>}
 */
export async function publish(opts = {}) {
  const { domains } = await generate(state.projects);

  let hostsOk = true;
  /** @type {string | undefined} */
  let hostsMessage;
  if (config.manageHosts && opts.hosts !== false) {
    const res = await applyHosts(domains);
    hostsOk = res.ok;
    hostsMessage = res.message;
  }

  // Only a server that is already up. Starting one here would mean adding a
  // project silently starts listening on port 80, which is not what "add a
  // project" asked for.
  const status = state.services.get(config.webServer);
  const restarted = status?.state === "running";
  if (restarted) await restart(config.webServer);

  return { domains, hostsOk, hostsMessage, restarted };
}
