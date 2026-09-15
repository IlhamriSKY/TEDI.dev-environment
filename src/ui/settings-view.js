// The settings that have nowhere better to live.
//
// This pane is where the environment is operated, so a setting belongs to the
// thing it changes: the root folder is the first setup step, which web server
// serves is "Use this" on its own row, and the ports and the HTTPS switch are
// the fields beside them. Splitting those between here and TEDI's Settings
// would have meant two places to look for one decision, and the second one
// cannot show you whether the port is currently bound.
//
// What is left describes every project rather than any one component: how
// they are named, and who besides this machine can open them. They are a
// DIALOG off the header rather than sections of the pane. Sharing was a
// dashboard section for one release and it was the wrong place: a switch you
// flip once sat between Services and Projects on every paint, pushing the list
// people actually work in down a screen.
//
// Two groups, each ONE card with hairline-separated rows, the way a settings
// list reads. They were separate bordered cards two pixels apart, which looked
// like a stack of unrelated alerts rather than one form.

import { h, muted, pill, modal, button, status, noteLine, switchControl, input } from "./el.js";
import { writeSetting } from "../manager/config.js";
import { republish } from "../web/publish.js";
import {
  lanAddresses,
  setShareLan,
  firewallPending,
  allowFirewall,
  stopTunnel,
} from "../web/share.js";
import { cloudflared } from "../registry/cloudflared.js";
import { exists } from "../core/fsx.js";
import { paths } from "../core/paths.js";
import { WEB_SERVERS } from "../web/ports.js";
import { config, ctx, state, repaint, loudBusy } from "../runtime.js";

/**
 * Open the settings dialog.
 *
 * Every control commits on its own - there is no Save, because there is
 * nothing to cancel back to. The body repaints in place while the dialog is
 * open (it joins `state.views`), because a public link goes from connecting to
 * an address, or dies, while you are looking at it. A repaint never rebuilds
 * the field the cursor is in: that would throw away what is being typed.
 *
 * @param {() => void} refresh  The pane's own repaint.
 * @returns {void}
 */
export function openSettings(refresh) {
  const body = h("div", {
    style: "display:flex;flex-direction:column;gap:16px;min-height:0;overflow:auto",
  });

  let generation = 0;
  const paint = () => {
    const focused = document.activeElement;
    if (focused && focused.tagName === "INPUT" && body.contains(focused)) return;
    const token = ++generation;
    void groups().then((nodes) => {
      if (token === generation) body.replaceChildren(...nodes);
    });
  };
  // Through `repaint`, so a change reaches the pane and this dialog together.
  const update = () => {
    refresh();
    repaint();
  };

  state.views.add(paint);
  paint();

  const done = button("Done", () => dialog.close(), { variant: "primary" });
  done.style.flex = "1";
  const dialog = modal({
    title: "Settings",
    description: `This environment lives in ${paths.root()}.`,
    body,
    footer: h("div", { style: "display:flex;gap:8px" }, [done]),
    width: "min(34rem,100%)",
    onClose: () => state.views.delete(paint),
  });

  /** @returns {Promise<HTMLElement[]>} */
  async function groups() {
    return [
      group("Domains", [suffixItem(update), hostsItem(update)]),
      group("Sharing", [await lanItem(update), await publicItem(update)]),
    ];
  }
}

/**
 * The domain suffix. Changing it renames every generated virtual host, so it
 * republishes: the alternative is project URLs describing a `.test` the server
 * no longer answers to.
 *
 * @param {() => void} update @returns {HTMLElement}
 */
function suffixItem(update) {
  const field = input(
    config.domainSuffix,
    async (value) => {
      const next = value.trim().replace(/^\.+/, "");
      if (next === config.domainSuffix) return;
      if (!next) {
        ctx?.ui.toast("A domain suffix cannot be empty.", { variant: "error" });
        field.value = config.domainSuffix;
        return;
      }
      await writeSetting("domainSuffix", next);
      await republish();
      update();
    },
    "test",
  );
  field.style.width = "140px";
  field.setAttribute("aria-label", "Domain suffix");
  return item(
    "Domain suffix",
    `Every project is served at name.${config.domainSuffix || "test"} unless it sets its own.`,
    field,
  );
}

/**
 * Whether the hosts file is written at all.
 *
 * Off is a real choice: people running dnsmasq or a wildcard resolver want the
 * vhosts and certificates without a second thing editing that file under an
 * administrator prompt. The block is delimited, so turning this off leaves
 * whatever is already there alone.
 *
 * @param {() => void} update @returns {HTMLElement}
 */
function hostsItem(update) {
  const on = config.manageHosts;
  return item(
    "Write the hosts file",
    on
      ? "Adding a project points its domain at 127.0.0.1, under one administrator prompt."
      : "Off: virtual hosts and certificates are still written, but the domains are yours to resolve.",
    switchControl(
      on,
      async (next) => {
        await writeSetting("manageHosts", next);
        if (next) await republish();
        update();
      },
      { label: "Write the hosts file" },
    ),
  );
}

/**
 * The local network. See `web/share.js` for what on and off bind.
 *
 * @param {() => void} update @returns {Promise<HTMLElement>}
 */
async function lanItem(update) {
  const on = config.shareLan;
  const [ip] = on ? await lanAddresses() : [];
  const pendingFirewall = on ? await firewallPending() : [];
  const serving = WEB_SERVERS.some((id) => state.services.get(id)?.state === "running");

  return item(
    "Share on the local network",
    on
      ? ip
        ? `Devices on this network open a project at http://${ip}:<port>, shown under each project. Databases and phpMyAdmin stay on this machine.`
        : "On, but this machine has no network address right now."
      : "Off: every site answers on this machine only.",
    h("div", { style: "display:flex;align-items:center;gap:8px" }, [
      on && ip ? pill(ip) : null,
      switchControl(
        on,
        async (next) => {
          await setShareLan(next);
          update();
        },
        { label: "Share on the local network" },
      ),
    ]),
    [
      on && !serving ? noteLine(`Start ${config.webServer} to serve them.`, "warn") : null,
      pendingFirewall.length > 0
        ? h(
            "div",
            {
              style:
                "flex:1 1 100%;display:flex;align-items:center;flex-wrap:wrap;gap:8px;" +
                "padding-top:8px;border-top:1px solid var(--border)",
            },
            [
              h("span", {
                text: "The Windows firewall will refuse other devices until it is told to let them in.",
                style:
                  "flex:1 1 200px;min-width:0;font-size:10.5px;line-height:1.45;" +
                  "color:var(--tedi-icon-working, #facc15)",
              }),
              button(
                "Allow through firewall",
                async () => {
                  const res = await allowFirewall();
                  ctx?.ui.toast(
                    res.ok
                      ? "Other devices can reach the web server now."
                      : `Not changed: ${res.message ?? "declined"}`,
                    { variant: res.ok ? "success" : "warning" },
                  );
                  update();
                },
                {
                  icon: "lucide:ShieldCheck",
                  title: `Adds an inbound allow rule for ${pendingFirewall.join(", ")} and switches off any rule blocking it. One administrator prompt.`,
                },
              ),
            ],
          )
        : null,
    ],
  );
}

/**
 * Public links: what they are, and every one that is live.
 *
 * Started from a project's own menu, because a link is per project; listed
 * here, because this is the one place that answers "what of mine is on the
 * internet right now".
 *
 * @param {() => void} update @returns {Promise<HTMLElement>}
 */
async function publicItem(update) {
  const { exe } = await cloudflared.layout("");
  const installed = await exists(exe);
  const busy = loudBusy("cloudflared");
  const tunnels = [...state.tunnels.entries()];

  return item(
    "Public links",
    busy
      ? `Downloading cloudflared: ${busy.text}${busy.pct === undefined ? "" : ` ${busy.pct}%`}`
      : "A temporary https address anyone on the internet can open, through a Cloudflare quick tunnel. No account, nothing opened on your router. Start one from a project's menu.",
    installed ? pill("cloudflared ready") : null,
    tunnels.map(([id, t]) => tunnelLine(id, t, update)),
  );
}

/**
 * One live link.
 *
 * @param {string} id @param {{ url: string | null }} t @param {() => void} update
 * @returns {HTMLElement}
 */
function tunnelLine(id, t, update) {
  const name = state.projects.find((p) => p.id === id)?.name ?? id;
  return h(
    "div",
    {
      style:
        "flex:1 1 100%;min-width:0;display:flex;align-items:center;gap:8px;" +
        "padding-top:8px;border-top:1px solid var(--border)",
    },
    [
      status(t.url ? "ok" : "working", 12),
      h("span", { text: name, style: "flex:none;font-size:11.5px;font-weight:600" }),
      t.url
        ? h("a", {
            text: t.url.replace(/^https:\/\//, ""),
            title: t.url,
            attrs: { href: t.url, target: "_blank", rel: "noreferrer" },
            style:
              "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
              "color:var(--primary);font-size:10.5px;text-decoration:none",
          })
        : h("span", { style: "flex:1 1 auto;min-width:0" }, [muted("Connecting…")]),
      t.url
        ? button(
            "",
            async () => {
              await navigator.clipboard.writeText(t.url ?? "").catch(() => {});
              ctx?.ui.toast(`Copied ${t.url}`, { variant: "success" });
            },
            { icon: "lucide:Copy", title: "Copy link" },
          )
        : null,
      button(
        "",
        async () => {
          await stopTunnel(id);
          update();
        },
        { icon: "lucide:X", variant: "danger", title: `Close the public link for ${name}` },
      ),
    ],
  );
}

/**
 * A titled group: the pane's uppercase section label over one card.
 *
 * @param {string} title @param {HTMLElement[]} items @returns {HTMLElement}
 */
function group(title, items) {
  return h("div", { style: "display:flex;flex-direction:column;gap:6px" }, [
    h("h3", {
      text: title,
      style:
        "margin:0;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;" +
        "color:var(--muted-foreground)",
    }),
    h(
      "div",
      {
        style:
          "display:flex;flex-direction:column;border:1px solid var(--border);" +
          "border-radius:var(--radius, 8px);background:var(--card, var(--background))",
      },
      items.map((el, i) => {
        if (i > 0) el.style.borderTop = "1px solid var(--border)";
        return el;
      }),
    ),
  ]);
}

/**
 * One setting: title and note on the left, the control on the right, and any
 * follow-up lines full width underneath.
 *
 * The text has a 220px BASIS rather than `auto`, so a long note does not claim
 * the whole line and push the control under it; it wraps beside it instead,
 * and only drops the control to its own line when the dialog is truly narrow.
 *
 * @param {string} title @param {string} note @param {Node | null} control
 * @param {(Node | null)[]} [extra]
 * @returns {HTMLElement}
 */
function item(title, note, control, extra = []) {
  return h(
    "div",
    {
      style:
        "display:flex;align-items:center;flex-wrap:wrap;column-gap:16px;row-gap:8px;padding:11px 12px",
    },
    [
      h("div", { style: "display:flex;flex-direction:column;gap:2px;flex:1 1 220px;min-width:0" }, [
        h("span", { text: title, style: "font-size:12px;font-weight:600;line-height:1.35" }),
        muted(note),
      ]),
      control
        ? h("div", { style: "flex:0 0 auto;display:flex;align-items:center" }, [control])
        : null,
      ...extra,
    ],
  );
}
