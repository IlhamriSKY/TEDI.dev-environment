// Sharing a project beyond this machine: the local network, and a public link.
//
// Both ride on ONE thing, the project's share listener (`isShared` in
// vhost.js): its own port, plain http, no hostname. A phone on the same Wi-Fi
// cannot resolve `shop.test` and would not trust the local CA if it could, so
// "open it on my phone" has to be `http://<this machine>:<port>`; and a tunnel
// arrives with a Host header of its own, which `server_name shop.test` would
// never match. One listener answers both, so there is one config shape to get
// right instead of two.
//
// Off is the default and means OFF. Every listener binds 127.0.0.1 then,
// including the main 80/443 - see `LOOPBACK` in vhost.js for the phpMyAdmin
// exposure that used to be the default. The databases are not part of this at
// all: MySQL's root and PostgreSQL's `trust` are passwordless by design, and
// they stay loopback whatever this says.

import { ctx, config, state, isWindows, isMac, warn, repaint } from "../runtime.js";
import { run, spawn, kill, logs, isAlive, sleep, which } from "../core/proc.js";
import { exists } from "../core/fsx.js";
import { basename, samePath } from "../core/paths.js";
import { elevate } from "../core/elevate.js";
import { writeSetting, rememberFirewall, activeVersion } from "../manager/config.js";
import { install } from "../manager/install.js";
import { installedOf, resolveVersion } from "../manager/versions.js";
import { start } from "../manager/services.js";
import { assignSharePorts } from "../project/projects.js";
import { cloudflared } from "../registry/cloudflared.js";
import { serverExe } from "./serverroot.js";
import { WEB_SERVERS } from "./ports.js";
import { republish } from "./publish.js";

/** @typedef {import("../runtime.js").Project} Project */

// ---------------------------------------------------------------------------
// Local network
// ---------------------------------------------------------------------------

/** A promise, so the two views painting at once share one subprocess.
 *  @type {{ at: number, ips: Promise<string[]> | null }} */
let lanCache = { at: 0, ips: null };

/**
 * This machine's address on the network, as another device would dial it.
 *
 * The address of the interface the DEFAULT ROUTE leaves by, not every address
 * the machine has. A developer laptop carries a WSL switch, a Hyper-V switch, a
 * VPN adapter and a Docker bridge, all with private addresses, and a phone can
 * reach none of them. Asked of the routing table, which is also the cheap
 * question: `Get-NetIPConfiguration` answers the same thing on Windows in five
 * seconds, `route print` in fifty milliseconds.
 *
 * Cached for a minute. The pane repaints on every action and this is a
 * subprocess; a laptop changes networks far less often than that.
 *
 * @returns {Promise<string[]>} Best first. Empty when there is no network.
 */
export function lanAddresses() {
  if (lanCache.ips && Date.now() - lanCache.at < 60_000) return lanCache.ips;
  const ips = probeLan();
  lanCache = { at: Date.now(), ips };
  return ips;
}

/** @returns {Promise<string[]>} */
async function probeLan() {
  /** @type {string[]} */
  let ips = [];
  try {
    if (isWindows()) {
      ips = parseWindowsRoutes(
        (await run("route", ["print", "-4", "0.0.0.0"], { timeoutMs: 8_000 })).out,
      );
    } else if (isMac()) {
      const route = await run("route", ["-n", "get", "1.1.1.1"], { timeoutMs: 8_000 });
      const iface = route.out.match(/interface:\s*(\S+)/)?.[1];
      const ip = iface
        ? (await run("ipconfig", ["getifaddr", iface], { timeoutMs: 8_000 })).out.trim()
        : "";
      ips = IPV4.test(ip) ? [ip] : [];
    } else {
      ips = parseIpRouteGet(
        (await run("ip", ["-4", "route", "get", "1.1.1.1"], { timeoutMs: 8_000 })).out,
      );
    }
  } catch (err) {
    warn("could not read this machine's network address", err);
  }
  return ips;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The local addresses of the active IPv4 default routes, from `route print`.
 *
 * Only the ACTIVE table: the persistent section repeats the route with a
 * gateway and the word "Default" where the metric goes, which the trailing
 * number rule skips. The gateway column is matched loosely because a directly
 * attached route prints a localised word there ("On-link", "Auf Verbindung").
 *
 * @param {string} text @returns {string[]}
 */
export function parseWindowsRoutes(text) {
  /** @type {{ ip: string, metric: number }[]} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(
      /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+.+?\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/,
    );
    if (m && !m[1].startsWith("169.254.")) rows.push({ ip: m[1], metric: Number(m[2]) });
  }
  rows.sort((a, b) => a.metric - b.metric);
  return [...new Set(rows.map((r) => r.ip))];
}

/** `ip -4 route get` prints `1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.10`.
 *  @param {string} text @returns {string[]} */
export function parseIpRouteGet(text) {
  const ip = text.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1];
  return ip ? [ip] : [];
}

/** Where another device opens this project, or null when it is not shared.
 *  @param {Project} project @param {string | undefined} ip @returns {string | null} */
export function lanUrl(project, ip) {
  if (!config.shareLan || !ip || !project.sharePort || project.enabled === false) return null;
  return `http://${ip}:${project.sharePort}`;
}

/**
 * Open or close the environment to the local network.
 *
 * Republished without the hosts file: which interface a server binds changes
 * nothing about which names resolve. On Windows, opening also asks the
 * firewall, because a server listening on every interface is still refused at
 * the door until the firewall agrees, and the refusal is silent - the phone
 * just spins.
 *
 * @param {boolean} on @returns {Promise<void>}
 */
export async function setShareLan(on) {
  await writeSetting("shareLan", on);
  if (on) {
    const fw = await allowFirewall();
    if (!fw.ok) {
      ctx?.ui.toast(
        `Sharing is on, but the Windows firewall was not opened (${fw.message ?? "declined"}). Other devices will be refused until it is.`,
        { variant: "warning" },
      );
    }
  }
  await republish({ hosts: false });
}

// ---------------------------------------------------------------------------
// Windows firewall
// ---------------------------------------------------------------------------

/**
 * Web-server executables the firewall has not been told about yet.
 *
 * Remembered per executable path rather than asked of the firewall: reading the
 * rule table takes seconds, and the path changes exactly when it has to be
 * asked again - a new nginx version is a new folder.
 *
 * @returns {Promise<string[]>}
 */
export async function firewallPending() {
  if (!isWindows()) return [];
  /** @type {string[]} */
  const exes = [];
  for (const id of WEB_SERVERS) {
    const row = resolveVersion(id, activeVersion(id) ?? installedOf(id)[0]?.version ?? null);
    if (!row) continue;
    const exe = await serverExe(id, row).catch(() => null);
    if (exe && !config.firewallAllowed.some((known) => samePath(known, exe))) exes.push(exe);
  }
  return exes;
}

/**
 * The elevated PowerShell that lets these executables in.
 *
 * Allow by PROGRAM, not by port, so a project added later needs no second
 * prompt. `Profile Any`, because a home network Windows filed as "Public" is the
 * normal case, not the exception, and a rule scoped to Private would do nothing
 * there without saying so.
 *
 * Inbound BLOCK rules for the same executable are switched off, not deleted. In
 * the Windows firewall a block beats an allow, and one is exactly what gets
 * written when somebody dismisses the "allow access" prompt the first time nginx
 * listens - so without this the allow rule is inert. Disabled rather than
 * removed, because a block rule may be one the user wrote on purpose, and
 * turning sharing on should not destroy it.
 *
 * Exported for the self-check. Every path is single-quoted, with `'` doubled.
 *
 * @param {string[]} exes @returns {string[]}
 */
export function firewallScript(exes) {
  return exes.flatMap((exe) => {
    const quoted = exe.replace(/'/g, "''");
    const name = `TEDI Dev Environment (${basename(exe)})`.replace(/'/g, "''");
    return [
      `$exe = '${quoted}'`,
      "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $exe } | Get-NetFirewallRule |" +
        " Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Set-NetFirewallRule -Enabled False",
      `Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
      `New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Any | Out-Null`,
    ];
  });
}

/** Ask once, remember the answer. @returns {Promise<{ ok: boolean, message?: string }>} */
export async function allowFirewall() {
  const exes = await firewallPending();
  if (exes.length === 0) return { ok: true };
  const res = await elevate(firewallScript(exes), {
    description: "TEDI Dev Environment needs to let other devices reach your web server",
  });
  if (res.ok) await rememberFirewall(exes);
  return res;
}

// ---------------------------------------------------------------------------
// Public link
// ---------------------------------------------------------------------------

/** cloudflared, ours or the system's, or null when neither exists.
 *  @returns {Promise<string | null>} */
async function cloudflaredExe() {
  const { exe } = await cloudflared.layout("");
  if (await exists(exe)) return exe;
  return await which("cloudflared");
}

/** Download it, the first time a public link is asked for.
 *  @returns {Promise<string>} */
async function installCloudflared() {
  const [latest] = await cloudflared.versions();
  if (!latest) throw new Error("Could not reach GitHub to find the current cloudflared release.");
  await install(cloudflared, latest.version);
  const exe = await cloudflaredExe();
  if (!exe) throw new Error("cloudflared downloaded but its executable is not where it should be.");
  return exe;
}

/**
 * The address a quick tunnel was given, out of cloudflared's log.
 *
 * Not `api.trycloudflare.com`: that is the endpoint it asks FOR a tunnel, and
 * it is in the log exactly when the asking failed.
 *
 * @param {string} text @returns {string | null}
 */
export function parseTunnelUrl(text) {
  return text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}

/**
 * Give a project a public address.
 *
 * The share listener comes first, because that is what the tunnel points at: a
 * running web server is reloaded to add it (unless the local network is
 * already shared, in which case it exists), and a stopped one is started, since
 * a public link to nothing is a Cloudflare error page.
 *
 * @param {Project} project @returns {Promise<void>}
 */
export async function startTunnel(project) {
  if (state.tunnels.has(project.id)) return;
  // The STORED object. A row can hold a copy from before an update, and a port
  // assigned to a copy is a port nobody saves.
  const live = state.projects.find((p) => p.id === project.id);
  if (!live) return;

  /** @type {{ handle: number, url: string | null, error: string | null }} */
  const entry = { handle: -1, url: null, error: null };
  state.tunnels.set(live.id, entry);
  repaint();

  try {
    const exe = (await cloudflaredExe()) ?? (await installCloudflared());
    await assignSharePorts([live]);

    const up = WEB_SERVERS.find((id) => state.services.get(id)?.state === "running");
    if (!up) {
      const s = await start(config.webServer);
      if (s.state !== "running") throw new Error(s.error ?? `${config.webServer} did not start.`);
    } else if (!config.shareLan) {
      await republish({ hosts: false });
    }
    if (state.tunnels.get(live.id) !== entry) return;

    entry.handle = await spawn(exe, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${live.sharePort}`,
    ]);

    let offset = 0;
    let text = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      // Stopped from the row while it was still connecting.
      if (state.tunnels.get(live.id) !== entry || !state.active) return;
      const log = await logs(entry.handle, offset);
      offset = log.next_offset;
      text += log.bytes ?? "";
      const url = parseTunnelUrl(text);
      if (url) {
        await untilReachable(url, () => state.tunnels.get(live.id) === entry);
        entry.url = url;
        repaint();
        return;
      }
      if (log.exited) break;
      await sleep(400);
    }
    const tail = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\S+\s+(INF|ERR|WRN)\s+/, "").trim())
      .filter((l) => l && !l.startsWith("+") && !l.startsWith("|"))
      .slice(-2)
      .join(" ");
    throw new Error(tail || "cloudflared gave no address within a minute.");
  } catch (err) {
    if (state.tunnels.get(live.id) === entry) {
      state.tunnels.delete(live.id);
      if (entry.handle >= 0) await kill(entry.handle);
      repaint();
      ctx?.ui.toast(
        `No public link for ${live.name}: ${err instanceof Error ? err.message : String(err)}`,
        { variant: "error" },
      );
    }
  }
}

/**
 * Hold the link back until the name actually answers.
 *
 * cloudflared prints the address about five seconds before Cloudflare's DNS
 * has it: measured, the name resolved at 11s and served its first 200 at 19s.
 * A link clicked in that window does not just fail once. The OS caches the
 * failed lookup, and the test that found this kept getting ENOTFOUND for the
 * next thirty seconds from a tunnel that was up the whole time.
 *
 * So the probe must not ask the system resolver either, or it poisons the very
 * cache it is waiting on. curl's `--doh-url` resolves over HTTPS by itself.
 * 530 and 502 are Cloudflare saying the tunnel is not wired yet; any other
 * answer is the site. A curl without DoH support (exit 2) or no curl at all
 * gets a fixed wait instead, and a site that never answers (a proxy project
 * whose dev server is down) is shown anyway at the deadline: the link is real,
 * the thing behind it is what is missing.
 *
 * @param {string} url @param {() => boolean} stillWanted @returns {Promise<void>}
 */
async function untilReachable(url, stillWanted) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && stillWanted()) {
    const res = await run(
      "curl",
      [
        "--doh-url",
        "https://1.1.1.1/dns-query",
        "-s",
        "-m",
        "10",
        "-o",
        isWindows() ? "NUL" : "/dev/null",
        "-w",
        "%{http_code}",
        url,
      ],
      { timeoutMs: 15_000 },
    ).catch(() => null);
    if (!res || res.code === 2) return await sleep(15_000);
    const status = Number(res.out.trim().slice(-3));
    if (res.code === 0 && status !== 530 && status !== 502) return;
    await sleep(2_000);
  }
}

/**
 * Close a project's public link.
 *
 * The share listener is left in place until the next publish rather than
 * removed now: on loopback it reaches nothing, and removing it would restart
 * the web server under every other tab the user has open.
 *
 * @param {string} id @returns {Promise<void>}
 */
export async function stopTunnel(id) {
  const entry = state.tunnels.get(id);
  if (!entry) return;
  state.tunnels.delete(id);
  if (entry.handle >= 0) await kill(entry.handle);
  repaint();
}

/** Every link, at deactivate. @returns {Promise<void>} */
export async function stopTunnels() {
  for (const id of [...state.tunnels.keys()]) await stopTunnel(id);
}

/**
 * Notice a tunnel whose process died on its own.
 *
 * A link that still shows an address after cloudflared exited is a link the
 * user sends to someone and that does not open.
 *
 * @returns {Promise<void>}
 */
export async function refreshTunnels() {
  for (const [id, entry] of state.tunnels) {
    if (!entry.url || (await isAlive(entry.handle))) continue;
    state.tunnels.delete(id);
    const name = state.projects.find((p) => p.id === id)?.name ?? "a project";
    warn(`public link for ${name} closed on its own`);
    ctx?.ui.toast(`The public link for ${name} closed: cloudflared exited.`, {
      variant: "warning",
    });
  }
}
