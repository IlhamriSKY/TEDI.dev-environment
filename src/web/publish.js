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
import { servedProject } from "../tools/phpmyadmin.js";
import { applyHosts } from "./hosts.js";
import { restart } from "../manager/services.js";
import { installedOf } from "../manager/versions.js";
import { WEB_SERVERS } from "./ports.js";
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
  // Every installed web server, not only the active one. Each has its own
  // `conf/<server>/` tree and its own ports, so keeping both current costs a
  // few kilobytes and means starting the other one never serves a config from
  // three project changes ago. The active one is always included even when it
  // has no managed install, because a detected system server is still the one
  // that will be started.
  const servers = WEB_SERVERS.filter((id) => id === config.webServer || installedOf(id).length > 0);

  // The user's projects, plus the tools this extension serves. phpMyAdmin is
  // not a project - it lives outside `www/` and never enters the store, so
  // nothing discovers it and it is absent from the Projects list - but it still
  // needs a vhost, a certificate and a hosts entry, and `generate` takes a LIST
  // rather than reading the store precisely so this can be appended here.
  const tool = await servedProject();
  const served = tool ? [...state.projects, tool] : state.projects;

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

  // Only a server that is already up. Starting one here would mean adding a
  // project silently starts listening on port 80, which is not what "add a
  // project" asked for.
  const status = state.services.get(config.webServer);
  const restarted = status?.state === "running";
  if (restarted) await restart(config.webServer);

  return { domains, hostsOk, hostsMessage, restarted };
}
