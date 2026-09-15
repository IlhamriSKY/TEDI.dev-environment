// The Sharing section: who besides this machine can open your projects.
//
// Two rows, because they are two different audiences with two different
// risks. The local network is a switch for the whole environment - the devices
// on your Wi-Fi either can reach your sites or they cannot. A public link is
// per project and temporary, so it is started from the project's own row and
// only LISTED here, where the one place to see "what is on the internet right
// now" belongs.

import {
  h,
  row,
  muted,
  pill,
  button,
  section,
  status,
  icon,
  checkbox,
  noteLine,
  progress,
} from "./el.js";
import {
  lanAddresses,
  setShareLan,
  firewallPending,
  allowFirewall,
  stopTunnel,
} from "../web/share.js";
import { cloudflared } from "../registry/cloudflared.js";
import { exists } from "../core/fsx.js";
import { state, config, ctx, loudBusy } from "../runtime.js";
import { WEB_SERVERS } from "../web/ports.js";

/**
 * Async for the same reason Projects is: the network address is a subprocess
 * (cached) and the cloudflared check a file probe.
 *
 * Nothing here that spawns runs while its answer is not on screen. The pane
 * repaints on every action, and a `where cloudflared` per paint for a tool most
 * people never install is the per-repaint subprocess `httpsProbe` in
 * dashboard.js exists to avoid. So the pill asks only whether OUR copy exists;
 * a system cloudflared is still found when a link is started.
 *
 * @param {() => void} refresh @returns {Promise<HTMLElement>}
 */
export async function shareView(refresh) {
  const on = config.shareLan;
  const [ip] = on ? await lanAddresses() : [];
  const pendingFirewall = on ? await firewallPending() : [];
  const { exe } = await cloudflared.layout("");
  const tunnelExe = (await exists(exe)) ? exe : null;
  const serving = WEB_SERVERS.some((id) => state.services.get(id)?.state === "running");

  const toggle = h(
    "button",
    {
      title: on
        ? "Stop answering to other devices. Every server goes back to this machine only."
        : "Let devices on this network open your projects, each on its own port.",
      style:
        "display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 4px;border:0;" +
        "background:transparent;color:var(--foreground);font-size:11px;cursor:pointer",
      on: {
        click: async (ev) => {
          const el = /** @type {HTMLButtonElement} */ (ev.currentTarget);
          el.disabled = true;
          await setShareLan(!on);
          refresh();
        },
      },
    },
    [checkbox(on), h("span", { text: "Share on this network" })],
  );

  const lan = row([
    identity(
      on ? "ok" : "idle",
      "lucide:Wifi",
      "Local network",
      on
        ? ip
          ? `Phones and computers on this network open a project at http://${ip}:<port>, shown under each project. Databases and phpMyAdmin stay on this machine.`
          : "On, but this machine has no network address right now."
        : "Off. Every site answers on this machine only; nothing else on the network can reach it.",
    ),
    h("div", { style: "display:flex;align-items:center;gap:8px;flex:0 0 auto" }, [
      on && ip ? pill(ip, { icon: "lucide:Network" }) : null,
      toggle,
    ]),
    on && !serving ? noteLine(`Start ${config.webServer} to serve them.`, "warn") : null,
    pendingFirewall.length > 0
      ? noteLine(
          "The Windows firewall has not been told to let other devices in, so they will be refused.",
          "warn",
        )
      : null,
    pendingFirewall.length > 0
      ? button(
          "Allow through firewall",
          async () => {
            const res = await allowFirewall();
            ctx?.ui.toast(
              res.ok
                ? "Other devices can reach the web server now."
                : `Not changed: ${res.message ?? "declined"}`,
              { variant: res.ok ? "success" : "warning" },
            );
            refresh();
          },
          {
            icon: "lucide:ShieldCheck",
            title: `Adds an inbound allow rule for ${pendingFirewall.join(", ")}, and switches off any rule blocking it. Asks for administrator rights once.`,
          },
        )
      : null,
  ]);

  const busy = loudBusy("cloudflared");
  const tunnels = [...state.tunnels.entries()];
  const publicRow = row([
    identity(
      tunnels.some(([, t]) => t.url) ? "ok" : busy || tunnels.length ? "working" : "idle",
      "lucide:Globe",
      "Public link",
      busy
        ? `cloudflared: ${busy.text}${busy.pct === undefined ? "" : ` ${busy.pct}%`}`
        : "A temporary https address anyone on the internet can open, through a Cloudflare quick tunnel. No account, nothing opened on your router, and the address is new every time. Start one from a project's menu.",
    ),
    tunnelExe ? pill("cloudflared", { icon: "lucide:Check", title: tunnelExe }) : null,
    ...tunnels.map(([id, t]) => tunnelLine(id, t, refresh)),
    busy ? h("div", { style: "flex:1 1 100%" }, [progress(busy.pct)]) : null,
  ]);

  return section("Sharing", [lan, publicRow]);
}

/**
 * One live link, on its own line inside the Public link card.
 *
 * @param {string} id
 * @param {{ url: string | null, error: string | null }} t
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function tunnelLine(id, t, refresh) {
  const name = state.projects.find((p) => p.id === id)?.name ?? id;
  return h(
    "div",
    {
      style:
        "flex:1 1 100%;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:6px;" +
        "padding-top:5px;border-top:1px solid var(--border)",
    },
    [
      status(t.url ? "ok" : "working", 12),
      h("span", { text: name, style: "font-size:11.5px;font-weight:600" }),
      t.url
        ? h("a", {
            text: t.url,
            attrs: { href: t.url, target: "_blank", rel: "noreferrer" },
            style:
              "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
              "color:var(--primary);font-size:10.5px;text-decoration:none;font-family:ui-monospace,monospace",
          })
        : h("span", { style: "flex:1 1 auto" }, [muted("Connecting to Cloudflare…")]),
      t.url ? copyButton(t.url) : null,
      button(
        "Stop",
        async () => {
          await stopTunnel(id);
          refresh();
        },
        { variant: "danger", icon: "lucide:Square", title: `Close the public link for ${name}` },
      ),
    ],
  );
}

/** @param {string} text @returns {HTMLButtonElement} */
function copyButton(text) {
  return button(
    "",
    async () => {
      await navigator.clipboard.writeText(text).catch(() => {});
      ctx?.ui.toast(`Copied ${text}`, { variant: "success" });
    },
    { icon: "lucide:Copy", title: `Copy ${text}` },
  );
}

/**
 * The same status + icon + two-line text group the setup rows use.
 *
 * @param {"ok"|"working"|"warn"|"error"|"idle"} tone
 * @param {string} glyph @param {string} title @param {string} detail
 * @returns {HTMLElement}
 */
function identity(tone, glyph, title, detail) {
  return h(
    "div",
    { style: "display:flex;align-items:center;gap:10px;flex:1 1 240px;min-width:min(240px,100%)" },
    [
      status(tone),
      icon(glyph, tone === "idle" ? "var(--muted-foreground)" : "var(--primary)"),
      h("div", { style: "display:flex;flex-direction:column;gap:1px;flex:1;min-width:0" }, [
        h("span", { text: title, style: "font-size:12px;font-weight:600" }),
        muted(detail),
      ]),
    ],
  );
}
