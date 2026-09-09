// A very small DOM helper, styled to match TEDI itself.
//
// `registerPanelRenderer` hands over a raw `HTMLElement` and nothing else: no
// React, no framework, no CSS pipeline. So the whole UI is built with
// `document.createElement`, and this file exists so that is three characters
// instead of six lines per node.
//
// The styling is not invented. It mirrors what `components/ui/button.tsx` and
// `components/ui/input.tsx` actually render, because the pane sits inside the
// app and anything following a different vocabulary reads as foreign no matter
// how tidy it is on its own. Three rules carry most of it:
//
//   - a control's border is TRANSPARENT and becomes `--ring` only on focus,
//     with the shape carried by a filled background rather than an outline;
//   - the fill is a token (`--tedi-button-face`, `--primary`, `--input`), never
//     a colour, so a custom theme moves this pane with it;
//   - status colour comes from `--tedi-icon-{idle,working,blocked}`, the app's
//     own green/amber/red, never from `--chart-*` (which is a syntax palette).
//
// The radii below say `999px` because `button.tsx` and `input.tsx` say
// `rounded-4xl`/`rounded-3xl`, but NOTHING in this app is round: `globals.css`
// ends its base layer with `*, *::before, *::after { border-radius: 0
// !important }`, and a stylesheet `!important` beats an inline style. Every
// radius written here is therefore documentation of the class it mirrors, not
// a pixel that ships. Do not "fix" a square corner by fighting it - the square
// IS the app.
//
// Reading a THEME TOKEN is fine; reading a saved theme VALUE is not, because
// the saved copy is not the live one.

import { ctx } from "../runtime.js";

/** Pill radius, matching `rounded-4xl` on buttons and `rounded-3xl` on inputs.
 *  One large value reads as a pill at every control height used here. */
const PILL = "999px";

/** How thick the progress hairline under a working row is. See `progress()`
 *  for why this does not follow the app's own 12px progress bar. */
const BAR_HEIGHT = "3px";

/**
 * There is deliberately no `html` option. Almost every string this UI renders
 * came from somewhere else - a folder name, a version index, an error from a
 * downloaded binary - and an `innerHTML` escape hatch is how one of those ends
 * up executing. `text` sets `textContent`, which cannot.
 *
 * @param {string} tag
 * @param {{ class?: string, text?: string, title?: string, style?: string,
 *           attrs?: Record<string, string>,
 *           on?: Record<string, (ev: Event) => void> }} [props]
 * @param {(Node | string | null | false | undefined)[]} [children]
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  // Never the native `title`. That is the browser's own widget: an OS-coloured
  // box in an OS font that appears a second late and cannot be styled at all,
  // which inside a themed pane reads exactly as foreign as a native `<select>`
  // did. Routing every caller through `tip` here means the pane has one
  // tooltip rather than two.
  if (props.title) tip(node, props.title);
  if (props.style) node.setAttribute("style", props.style);
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(event, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** One turn of a spinning icon, in ms. Exported because a caller that decides
 *  how long to keep one on screen has to agree with it. */
export const SPIN_MS = 900;

/**
 * The rotation, anchored to the clock rather than to when the node was built.
 *
 * This pane repaints on a four-second poll and every repaint builds new nodes,
 * so without the negative delay a spinner restarted from zero each time and
 * what you saw was a twitch. Two spinners on screen also turn together, which
 * is what makes them read as one thing happening rather than several.
 *
 * @returns {string}
 */
function spinAnimation() {
  return `tedi-dev-spin ${SPIN_MS}ms linear infinite -${Date.now() % SPIN_MS}ms`;
}

/**
 * Turn this glyph, about its own centre.
 *
 * One helper rather than an assignment at each site: `transform-origin` and the
 * animation are the two facts that make a spin smooth, and a new call site that
 * remembered only the second one is how the last one stopped being.
 *
 * @param {HTMLElement} el @returns {void}
 */
function startSpin(el) {
  el.style.transformOrigin = "50% 50%";
  el.style.animation = spinAnimation();
}

/** The loading glyph, or the caller's own. One name, so a button, a row and a
 *  status line cannot each pick a different idea of what "working" looks like.
 *  @param {boolean | undefined} on @param {string} own @returns {string} */
function loading(on, own) {
  return on ? LOADING_ICON : own;
}

/** What "working" looks like everywhere in this pane. `status("working")` draws
 *  the same one. */
const LOADING_ICON = "lucide:LoaderCircle";

/**
 * A button, in the app's own shape.
 *
 * Disables itself while its handler runs: every action here is async and most
 * take seconds, and without this a second click starts a second download of the
 * same thing into the same file.
 *
 * The colour vocabulary is the pane's own status triad, not a second one:
 * green goes, red stops, amber is the state in between. So Start reads as Start
 * before the word is, and Stop and Disable are the two you cannot press by
 * accident while looking somewhere else.
 *
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} onClick
 * @param {{ variant?: "primary" | "default" | "danger" | "success" | "warn" | "ghost",
 *           title?: string, disabled?: boolean, icon?: string, spin?: boolean }} [opts]
 * @returns {HTMLButtonElement}
 */
export function button(label, onClick, opts = {}) {
  const variant = opts.variant ?? "default";
  // An icon with no words is a SQUARE button, the way `size="icon-xs"` is in
  // `button.tsx`. Left with the text padding it becomes a wide lozenge with a
  // glyph rattling around in it, which is what the find bar's next/previous
  // arrows looked like.
  const iconOnly = opts.icon !== undefined && label === "";
  const base =
    `display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;` +
    `${iconOnly ? "width:24px;padding:0" : "padding:0 10px"};border-radius:${PILL};` +
    `border:1px solid transparent;font-size:11px;` +
    `font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;` +
    `transition:background-color .12s ease,opacity .12s ease;outline:none`;
  const skin = {
    primary: "background:var(--primary);color:var(--primary-foreground)",
    // `--tedi-button-face` is the app's own default button fill; `--secondary`
    // is the fallback for a theme that predates it.
    default:
      "background:var(--tedi-button-face, var(--secondary));" +
      "color:var(--tedi-button-face-foreground, var(--secondary-foreground))",
    danger:
      "background:color-mix(in oklab,var(--destructive) 12%,transparent);color:var(--destructive)",
    success:
      "background:color-mix(in oklab,var(--tedi-icon-idle, #34d399) 14%,transparent);" +
      "color:var(--tedi-icon-idle, #34d399)",
    warn:
      "background:color-mix(in oklab,var(--tedi-icon-working, #facc15) 14%,transparent);" +
      "color:var(--tedi-icon-working, #facc15)",
    ghost: "background:transparent;color:var(--muted-foreground)",
  }[variant];

  // The label lives in its own span rather than as the button's text, so an
  // icon can sit beside it and so the busy state below can dim the button
  // without erasing the icon along with the words.
  // A spinning icon rather than a bar, for work with nothing to measure. The
  // button you pressed is where you are already looking, and it says which
  // component is busy without a second element having to name one.
  const size = iconOnly ? 14 : 13;
  let glyph = opts.icon ? icon(loading(opts.spin, opts.icon), "currentColor", size) : null;
  if (glyph && opts.spin) startSpin(glyph);

  /**
   * Swap between this button's own icon and the loading one.
   *
   * A SWAP, not a spin of whatever is already there: a rotating Play triangle
   * or a rotating square is not a thing that is loading, it is a thing that has
   * gone wrong. `LoaderCircle` is the one glyph that means "working" without
   * having to be read, and it is the same glyph `status("working")` puts on the
   * row - so the button and the row it sits on say the same thing the same way.
   *
   * @param {boolean} on
   */
  const setLoading = (on) => {
    if (!glyph || !opts.icon) return;
    const next = icon(loading(on, opts.icon), "currentColor", size);
    if (on) startSpin(next);
    glyph.replaceWith(next);
    glyph = next;
  };

  const btn = /** @type {HTMLButtonElement} */ (
    h("button", { style: `${base};${skin}`, title: opts.title }, [
      glyph,
      iconOnly ? null : h("span", { text: label }),
    ])
  );
  if (opts.disabled) {
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "default";
    return btn;
  }

  // `focus-visible:border-ring` and `active:translate-y-px`, as the real button
  // does them.
  btn.addEventListener("focus", () => (btn.style.borderColor = "var(--ring)"));
  btn.addEventListener("blur", () => (btn.style.borderColor = "transparent"));
  btn.addEventListener("pointerdown", () => (btn.style.transform = "translateY(1px)"));
  for (const e of ["pointerup", "pointerleave"]) {
    btn.addEventListener(e, () => (btn.style.transform = "none"));
  }

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";
    btn.style.cursor = "progress";
    // Whatever this button does, it says so while it is doing it. Every handler
    // in this pane is async and most reach the network or the disk, and the
    // button already knows exactly when that starts and ends - so this happens
    // here rather than at each call site remembering to ask for it.
    // "Install Xdebug" downloads a DLL and reconfigures php.ini, and looked
    // frozen for every second of it.
    setLoading(true);
    try {
      await onClick();
    } finally {
      // The panel usually re-renders and throws this node away; restoring is
      // for the case where it does not.
      setLoading(Boolean(opts.spin));
      if (btn.isConnected) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      }
    }
  });
  return btn;
}

/**
 * A tooltip drawn by us rather than by the browser.
 *
 * Not exported: every node in this pane is built by `h`, and `h` calls this for
 * any `title` prop, so a second way to attach one would only be a second way to
 * forget.
 *
 * Positioned on show, in fixed coordinates, instead of with CSS: the pane
 * scrolls, and a tooltip anchored inside a scroller is clipped by it the moment
 * its row is near an edge - which is exactly the row whose full path you wanted
 * to read.
 *
 * @template {Element} T
 * @param {T} el
 * @param {string} text
 * @returns {T}
 */
function tip(el, text) {
  if (!text) return el;
  /** @type {HTMLElement | null} */
  let bubble = null;

  /** Cancels the orphan watch below. @type {ReturnType<typeof setInterval> | null} */
  let watch = null;

  const hide = () => {
    bubble?.remove();
    bubble = null;
    if (watch !== null) clearInterval(watch);
    watch = null;
  };

  const show = () => {
    if (bubble || !el.isConnected) return;
    bubble = h("div", {
      text,
      style:
        "position:fixed;z-index:70;max-width:320px;padding:5px 9px;border-radius:var(--radius, 6px);" +
        "background:var(--popover, var(--background));color:var(--popover-foreground, var(--foreground));" +
        "font-size:10.5px;line-height:1.45;pointer-events:none;white-space:normal;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.35);" +
        "outline:1px solid color-mix(in oklab,var(--foreground) 8%,transparent)",
    });
    document.body.append(bubble);

    const anchor = el.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    // Above by default, below when there is no room - which is what happens to
    // the top row of the pane.
    const top = anchor.top - box.height - 6 >= 4 ? anchor.top - box.height - 6 : anchor.bottom + 6;
    const left = Math.min(
      Math.max(4, anchor.left + anchor.width / 2 - box.width / 2),
      innerWidth - box.width - 4,
    );
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;

    // A hovered row can be thrown away under the pointer - the panel repaints
    // wholesale, and switching panes discards the whole tree - and `pointerleave`
    // never fires for a node that stopped existing. Without this the bubble is
    // left floating over whatever replaced it, which is exactly what a stray
    // tooltip over another extension's pane looks like.
    watch = setInterval(() => {
      if (!el.isConnected) hide();
    }, 250);
  };

  el.addEventListener("pointerenter", show);
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  // A click usually opens a dialog or repaints the pane; either way this node
  // stops existing and the bubble would be left floating over the new screen.
  el.addEventListener("click", hide);
  return el;
}

/**
 * A component's icon, tinted.
 *
 * `ctx.ui.icon` mounts a REACT ROOT per call and the host only unmounts them on
 * deactivate, so calling it once per row per repaint leaks a root every time the
 * panel redraws. One master per icon NAME is therefore cached for the life of
 * the extension, kept OUT of the document, and each use gets a COPY of the SVG
 * it rendered. See `fill` below for why a copy and not the master itself, and
 * for the second trap: a copy taken before the host's lazy chunk lands is
 * permanently empty, so it is retried briefly.
 *
 * @param {string} name    A `lucide:<Name>` reference.
 * @param {string} [colour] CSS colour for the glyph.
 * @param {number} [size]
 * @returns {HTMLElement}
 */
export function icon(name, colour, size = 15) {
  // `align-items`/`justify-content` because the slot is a fixed box and the SVG
  // dropped into it is whatever the host rendered. Without them the glyph is
  // stretched or pinned to one corner rather than centred, and every row that
  // puts text beside an icon inherits the offset - which is what made a project
  // name sit low against its tick.
  const slot = h("span", {
    style:
      `display:inline-flex;align-items:center;justify-content:center;flex:none;` +
      `width:${size}px;height:${size}px;color:${colour ?? "var(--muted-foreground)"}`,
  });

  const key = `${name}@${size}`;
  let master = iconCache.get(key);
  if (!master) {
    // One React root per icon NAME, for the life of the extension. The master
    // is never put in the document; only copies of its rendered SVG are.
    master = ctx?.ui?.icon?.(name, { size }) ?? h("span");
    iconCache.set(key, master);
  }

  // Moving the master instead of copying it looked simpler and was wrong: two
  // rows can want the same glyph (MySQL and PostgreSQL are both `Database`,
  // Composer and npm are both `Package`), and a node can only be in one place,
  // so the second row silently rendered nothing.
  const fill = () => {
    const art = master?.firstChild;
    if (!art) return false;
    const copy = /** @type {HTMLElement} */ (art.cloneNode(true));
    // The copy FILLS the slot exactly, and is a block.
    //
    // The slot is the box the spin animation is on, so the glyph inside it has
    // to be that same box or the rotation is not about the glyph's own centre.
    // Sized by the host it usually is, but it is a flex item, so a stylesheet
    // that sets a height the slot does not share leaves it stretched: measured
    // in Chromium, a 13px slot under a rule forcing `svg{height:16px}` renders
    // a 13x16 glyph, and a rotating ellipse swells and shrinks rather than
    // turning. Saying the size here is what makes the glyph a circle whatever
    // the surrounding CSS believes.
    copy.style.display = "block";
    copy.style.width = "100%";
    copy.style.height = "100%";
    slot.replaceChildren(copy);
    return true;
  };

  // `ctx.ui.icon` returns an EMPTY span and fills it when its lazy chunk lands,
  // so a copy taken on the first ever call would be permanently blank. Retry
  // briefly; after that the icon simply is not available and the slot stays an
  // empty box of the right size, which keeps the row's layout intact.
  if (!fill()) {
    let tries = 0;
    const timer = setInterval(() => {
      if (fill() || ++tries > 20 || !slot.isConnected) clearInterval(timer);
    }, 50);
  }
  return slot;
}

/**
 * Render a component's mark: a real brand logo when there is one, a lucide
 * glyph when there is not.
 *
 * The two arrive in the same shape from `markFor`, so a view never has to know
 * which kind a component has. A brand path is drawn directly with
 * `createElementNS` - no host call, no React root, no lazy chunk - which is why
 * these appear instantly while a lucide icon has to be polled for.
 *
 * @param {{ path?: string, icon?: string, colour: string }} m
 * @param {number} [size]
 * @returns {Element}
 */
export function mark(m, size = 15) {
  if (!m.path) return icon(m.icon ?? "lucide:Box", m.colour, size);

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.flex = "none";
  svg.style.display = "inline-block";
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", m.path);
  path.setAttribute("fill", m.colour);
  svg.append(path);
  return svg;
}

/** @type {Map<string, HTMLElement>} */
const iconCache = new Map();

/** Drop every cached icon. Called on deactivate so a reload starts clean. */
export function clearIconCache() {
  iconCache.clear();
}

/**
 * A dropdown in the app's shape.
 *
 * A native `<select>` renders with the OS widget, which on Windows is a grey
 * 1990s control sitting inside a themed panel - the single most obviously
 * foreign thing in the pane. This is a button plus a positioned list, built from
 * the same tokens every other control here uses.
 *
 * @param {{value: string, label: string, hint?: string}[]} options
 * @param {string | null} selected
 * @param {(value: string) => unknown} onChange
 * @param {{ width?: string, placeholder?: string, full?: boolean }} [opts]
 *        `full` fills the space the row gives it instead of sitting at a fixed
 *        width with a gap after it. `width` is then ignored.
 * @returns {HTMLElement}
 */
export function dropdown(options, selected, onChange, opts = {}) {
  const current = options.find((o) => o.value === selected) ?? options[0];
  const wrap = h("div", {
    style: opts.full
      ? "position:relative;display:flex;flex:1;min-width:0"
      : "position:relative;display:inline-flex",
  });

  const btn = h(
    "button",
    {
      style:
        `display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 7px 0 11px;` +
        `border-radius:${PILL};border:1px solid transparent;font-size:11px;cursor:pointer;` +
        `background:var(--tedi-button-face, var(--secondary));` +
        `color:var(--tedi-button-face-foreground, var(--secondary-foreground));` +
        (opts.full ? `flex:1;min-width:0;` : `min-width:${opts.width ?? "120px"};`) +
        `justify-content:space-between;outline:none`,
    },
    [
      h("span", {
        text: current?.label ?? opts.placeholder ?? "Select",
        style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      }),
      h("span", { text: "▾", style: "opacity:.5;font-size:9px;flex:none" }),
    ],
  );
  btn.addEventListener("focus", () => (btn.style.borderColor = "var(--ring)"));
  btn.addEventListener("blur", () => (btn.style.borderColor = "transparent"));

  /** @type {HTMLElement | null} */
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  /** @param {Event} ev */
  const onOutside = (ev) => {
    if (!wrap.contains(/** @type {Node} */ (ev.target))) close();
  };
  /** @param {KeyboardEvent} ev */
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (menu) return close();
    menu = h(
      "div",
      {
        style:
          "position:absolute;top:calc(100% + 4px);left:0;z-index:40;min-width:100%;max-height:240px;" +
          "overflow:auto;padding:4px;border-radius:var(--radius, 8px);border:1px solid var(--border);" +
          "background:var(--popover, var(--background));box-shadow:0 10px 30px rgba(0,0,0,.35)",
      },
      options.map((o) =>
        h(
          "button",
          {
            style:
              `display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:5px 9px;` +
              `border:0;border-radius:${PILL};font-size:11px;cursor:pointer;white-space:nowrap;` +
              `background:${o.value === selected ? "var(--accent)" : "transparent"};color:var(--foreground)`,
            on: {
              click: (e) => {
                e.stopPropagation();
                close();
                if (o.value !== selected) void onChange(o.value);
              },
              mouseenter: (e) => {
                /** @type {HTMLElement} */ (e.currentTarget).style.background = "var(--accent)";
              },
              mouseleave: (e) => {
                const t = /** @type {HTMLElement} */ (e.currentTarget);
                t.style.background = o.value === selected ? "var(--accent)" : "transparent";
              },
            },
          },
          [
            h("span", { text: o.label, style: "flex:1" }),
            o.hint ? h("span", { text: o.hint, style: "opacity:.5;font-size:10px" }) : null,
          ],
        ),
      ),
    );
    wrap.append(menu);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });

  wrap.append(btn);
  return wrap;
}

/**
 * A full-width line that drops UNDER the rest of a row.
 *
 * A failure message used to sit in the middle group, between a version picker
 * and the buttons, where it pushed everything else sideways and, on a narrow
 * pane, wrapped into the middle of the controls. It is a sentence, not a
 * control, so it belongs on a line of its own.
 *
 * No new container: `row()` already wraps, so a child with a 100% basis lands on
 * its own line INSIDE the same card. Anything else would draw a second border
 * under the first.
 *
 * @param {string} text
 * @param {"error" | "warn" | "muted"} [tone]
 * @returns {HTMLElement}
 */
export function noteLine(text, tone = "error") {
  const colour =
    tone === "error"
      ? "var(--destructive)"
      : tone === "warn"
        ? "var(--tedi-icon-working, #facc15)"
        : "var(--muted-foreground)";
  return h(
    "div",
    {
      style:
        "flex:1 1 100%;min-width:0;display:flex;align-items:flex-start;gap:6px;" +
        "padding-top:2px;border-top:1px solid var(--border);margin-top:2px",
    },
    [
      h("span", {
        text: tone === "muted" ? "" : "!",
        style:
          `flex:none;width:13px;height:13px;margin-top:1px;border-radius:999px;font-size:9px;` +
          `font-weight:700;line-height:13px;text-align:center;color:var(--background);` +
          `background:${colour};${tone === "muted" ? "display:none" : ""}`,
      }),
      h("span", {
        text,
        style: `flex:1;min-width:0;color:${colour};font-size:10.5px;line-height:1.45;word-break:break-word`,
      }),
    ],
  );
}

/**
 * The overflow menu for a row's secondary actions.
 *
 * A running MySQL row carried six buttons - settings, install, phpMyAdmin,
 * viewer, stop, restart - plus a version picker and two port pills. At a pane
 * width of 400px that is three lines of controls around one line of fact, and
 * the one button anybody presses (Stop) is somewhere in the middle of it. Only
 * the primary action stays on the row; everything else comes in here.
 *
 * The panel is anchored to the RIGHT edge of its button, because the button
 * sits at the right end of a row: opening leftwards is what keeps it inside a
 * narrow pane instead of pushing a scrollbar onto the whole panel.
 *
 * @param {{ label: string, icon?: string, onClick: () => void, disabled?: boolean, danger?: boolean }[]} items
 * @param {{ title?: string }} [opts]
 * @returns {HTMLElement | null}
 */
export function actionsMenu(items, opts = {}) {
  const live = items.filter(Boolean);
  if (live.length === 0) return null;

  const wrap = h("div", { style: "position:relative;display:inline-flex;flex:none" });
  // `Ellipsis`, not `MoreHorizontal`. The host resolves `lucide:<Name>` against
  // lucide's `icons` RECORD, and that record holds only canonical names -
  // `MoreHorizontal` is one of 245 deprecated aliases that lucide still exports
  // as a component but leaves out of the record. The lookup returned null, the
  // host rendered its empty placeholder span, and every row grew a blank square
  // where the menu button should be. Nothing threw; it just was not there.
  const btn = button("", () => {}, { icon: "lucide:Ellipsis", title: opts.title ?? "More" });

  /** @type {HTMLElement | null} */
  let panel = null;
  const close = () => {
    panel?.remove();
    panel = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  /** @param {Event} ev */
  const onOutside = (ev) => {
    if (!wrap.contains(/** @type {Node} */ (ev.target))) close();
  };
  /** @param {KeyboardEvent} ev */
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (panel) return close();
    panel = h(
      "div",
      {
        style:
          "position:absolute;top:calc(100% + 4px);right:0;z-index:40;min-width:170px;" +
          "padding:4px;border-radius:var(--radius, 8px);border:1px solid var(--border);" +
          "background:var(--popover, var(--background));box-shadow:0 10px 30px rgba(0,0,0,.35)",
      },
      live.map((item) =>
        h(
          "button",
          {
            style:
              `display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:6px 9px;` +
              `border:0;border-radius:${PILL};font-size:11px;white-space:nowrap;background:transparent;` +
              `color:${item.danger ? "var(--destructive)" : "var(--foreground)"};` +
              `cursor:${item.disabled ? "not-allowed" : "pointer"};opacity:${item.disabled ? ".45" : "1"}`,
            attrs: item.disabled ? { disabled: "true" } : {},
            on: {
              click: (e) => {
                e.stopPropagation();
                if (item.disabled) return;
                close();
                item.onClick();
              },
              mouseenter: (e) => {
                if (item.disabled) return;
                /** @type {HTMLElement} */ (e.currentTarget).style.background = "var(--accent)";
              },
              mouseleave: (e) => {
                /** @type {HTMLElement} */ (e.currentTarget).style.background = "transparent";
              },
            },
          },
          [
            item.icon ? icon(item.icon, "currentColor", 13) : null,
            h("span", { text: item.label, style: "flex:1" }),
          ],
        ),
      ),
    );
    wrap.append(panel);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });

  wrap.append(btn);
  return wrap;
}

/**
 * A checkbox, drawn flat the way `components/ui/checkbox.tsx` draws one.
 *
 * A native `<input type="checkbox">` was here, tinted with `accent-color`. That
 * is the browser's own widget: on Windows a rounded, shaded control with its own
 * hover and focus rings, which is the same foreignness a native `<select>` had.
 * The app's own is a 14px SQUARE - `border-input` when off, filled `--primary`
 * with a `--primary-foreground` tick when on - and nothing about it is round or
 * shaded.
 *
 * The tick is drawn with `createElementNS` rather than through `icon()`: a
 * lucide glyph arrives on a lazy chunk and has to be polled for, and a check
 * mark that fades in a few frames after the click is exactly the kind of lag
 * that makes a toggle feel broken.
 *
 * Visual only. The caller owns the click, because every use here has a larger
 * hit target than the box itself.
 *
 * @param {boolean} checked
 * @param {{ size?: number }} [opts]
 * @returns {HTMLElement}
 */
export function checkbox(checked, opts = {}) {
  const size = opts.size ?? 14;
  const box = h("span", {
    style:
      `display:inline-flex;align-items:center;justify-content:center;flex:none;` +
      `width:${size}px;height:${size}px;box-sizing:border-box;` +
      `border:1px solid ${checked ? "var(--primary)" : "var(--input)"};` +
      `background:${checked ? "var(--primary)" : "transparent"};` +
      `color:var(--primary-foreground);transition:background-color .12s ease,border-color .12s ease`,
  });
  if (!checked) return box;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(Math.round(size * 0.72)));
  svg.setAttribute("height", String(Math.round(size * 0.72)));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  // Lucide's `Check` at the same weight `checkbox.tsx` renders it.
  svg.setAttribute("stroke-width", "3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M20 6 9 17l-5-5");
  svg.append(path);
  box.append(svg);
  return box;
}

/**
 * A state, as a glyph in the app's own status colours.
 *
 * This was a 6px filled square. A square carries its whole meaning in its fill,
 * which makes it a colour quiz: green and amber at that size are two shades of
 * bright, and to anyone with a red-green deficiency "running" and "failed" are
 * the same mark. A tick, a spinner, a triangle and an alert circle each say
 * their state on their own, and the colour then agrees with the shape instead
 * of being the only carrier of it.
 *
 * `--chart-2` and `--chart-4` were the obvious guess for those colours and they
 * are wrong: in the shipped theme they are SYNTAX colours (`#c586c0` pink,
 * `#9cdcfe` light blue), so "running" rendered pink and "needs attention"
 * rendered blue. TEDI's actual status triad is `--tedi-icon-{idle,working,
 * blocked}`, the same green/amber/red the AI CLI badge and the SSH tab use, and
 * it travels with an exported theme.
 *
 * @param {"ok"|"working"|"warn"|"error"|"idle"} tone
 * @param {number} [size]
 * @returns {HTMLElement}
 */
export function status(tone, size = 13) {
  const spec = STATUS_TONES[tone] ?? STATUS_TONES.idle;
  const node = icon(spec.icon, spec.colour, size);
  // A LoaderCircle is a ring with a gap in it: the gap only means anything if it
  // travels. It used to breathe instead - the app's own `ai-breathe` pulse - and
  // a spinner that fades in and out is a blinking ring, which reads as a fault
  // light rather than as work in progress. Rotation is what that glyph is drawn
  // for, and it is the one animation nobody has to learn.
  if (spec.spin) startSpin(node);
  return node;
}

/**
 * What each state looks like.
 *
 * A glyph and a colour, never a colour alone: the previous 6px square carried
 * the whole state in its fill, which is unreadable to anyone who cannot
 * separate the greens from the reds and is a guess for everyone else. A tick, a
 * spinner, a warning triangle and an alert circle say the same thing without
 * the colour, and the colour then confirms it.
 *
 * The tokens are the app's own status trio. `--tedi-icon-idle` is the GREEN one
 * despite the name: in the AI CLI vocabulary it means ready, which is what a
 * running service is.
 */
const STATUS_TONES = {
  ok: { icon: "lucide:CircleCheck", colour: "var(--tedi-icon-idle, #34d399)", spin: false },
  working: {
    icon: LOADING_ICON,
    colour: "var(--tedi-icon-working, #facc15)",
    spin: true,
  },
  warn: {
    icon: "lucide:TriangleAlert",
    colour: "var(--tedi-icon-working, #facc15)",
    spin: false,
  },
  error: {
    icon: "lucide:CircleAlert",
    colour: "var(--tedi-icon-blocked, var(--destructive))",
    spin: false,
  },
  idle: { icon: "lucide:Circle", colour: "var(--muted-foreground)", spin: false },
};

/**
 * A hairline under the row that is doing the work.
 *
 * The mechanics are `components/ui/progress.tsx`: a `bg-muted` track with a
 * `bg-primary/90` indicator moved by `translateX(-(100 - value)%)` rather than
 * resized, which is what makes the transition animate smoothly instead of
 * reflowing. Ported rather than reinvented so a download here behaves like
 * every other progress in the app.
 *
 * The HEIGHT deliberately does not follow it. That component is `h-3`, 12px,
 * which is right for a progress bar somebody is looking AT; this one runs under
 * a compact row somebody is looking THROUGH, and at 12px it read as a second
 * row rather than as an attribute of the first. Three pixels is enough to see
 * from across the pane and little enough that the list does not jump when a
 * download starts.
 *
 * An UNKNOWN length is drawn as a sweep, never as 0%. "Unpacking" and
 * "Verifying" have no measurable length, and a bar sitting at zero through them
 * reads as a download that stalled - which is exactly the moment a user reaches
 * for the cancel they do not have.
 *
 * @param {number} [pct] 0-100, or omitted for indeterminate.
 * @returns {HTMLElement}
 */
export function progress(pct) {
  const known = typeof pct === "number" && Number.isFinite(pct);
  const value = known ? Math.max(0, Math.min(100, pct)) : 0;

  const indicator = h("div", {
    style:
      "height:100%;background:color-mix(in oklab,var(--primary) 90%,transparent);" +
      (known
        ? `width:100%;transition:transform .15s ease;transform:translateX(-${100 - value}%)`
        : "width:40%;animation:tedi-dev-sweep 1.1s ease-in-out infinite"),
  });

  return h(
    "div",
    {
      attrs: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        ...(known ? { "aria-valuenow": String(value) } : {}),
      },
      style:
        `display:flex;align-items:center;height:${BAR_HEIGHT};width:100%;min-width:0;` +
        "overflow-x:hidden;background:var(--muted)",
    },
    [indicator],
  );
}

/**
 * A loading placeholder, in the app's own shape.
 *
 * `settings/sections/components/InstallReviewDialog.tsx` draws exactly this
 * while an extension's icon is fetched: a `bg-muted` block with `animate-pulse`.
 * The animation is taken from `--animate-pulse` rather than written out, so the
 * timing is the app's and stays the app's; the literal behind it is the same
 * value Tailwind emits, for a host that predates the token.
 *
 * Used only where the wait is REAL and unavoidable. A skeleton over something
 * that could just be fast is decoration hiding a defect - which is why the
 * survey behind the one in `packagers-view` was made concurrent in the same
 * change.
 *
 * @param {string} [width] Any CSS length.
 * @param {number} [height] Pixels.
 * @returns {HTMLElement}
 */
export function skeleton(width = "100%", height = 11) {
  return h("div", {
    attrs: { "aria-hidden": "true" },
    style:
      `width:${width};height:${height}px;flex:none;background:var(--muted);` +
      `animation:var(--animate-pulse, pulse 2s cubic-bezier(.4,0,.6,1) infinite)`,
  });
}

/** A muted one-line caption. @param {string} text @returns {HTMLElement} */
export function muted(text) {
  return h("span", {
    text,
    style: "color:var(--muted-foreground);font-size:10.5px;line-height:1.45",
  });
}

/**
 * A small pill, for versions and ports.
 *
 * `icon` turns it into a labelled badge, and `colour` tints both the glyph and
 * the text. Colour is never the only carrier: a badge that means something
 * always says so in words beside the glyph, for the same reason `status()`
 * stopped being a coloured square.
 *
 * @param {string} text
 * @param {{ icon?: string, colour?: string, title?: string }} [opts]
 * @returns {HTMLElement}
 */
export function pill(text, opts = {}) {
  const colour = opts.colour ?? "var(--muted-foreground)";
  return h(
    "span",
    {
      title: opts.title ?? text,
      style:
        `display:inline-flex;align-items:center;gap:4px;max-width:min(340px,100%);white-space:nowrap;` +
        `padding:2px 9px;border-radius:${PILL};background:var(--muted);` +
        `color:${colour};font-size:10px;font-family:ui-monospace,monospace`,
    },
    [
      opts.icon ? icon(opts.icon, colour, 11) : null,
      h("span", {
        text,
        style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0",
      }),
    ],
  );
}

/** The shared uppercase section label.
 *  @param {string} title @returns {HTMLElement} */
function heading(title) {
  return h("h2", {
    text: title,
    style:
      "margin:0;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;" +
      "color:var(--muted-foreground)",
  });
}

/** A section heading, with an optional right-hand slot.
 *  @param {string} title
 *  @param {(Node|string|null|false|undefined)[]} children
 *  @param {Node} [aside] */
export function section(title, children, aside) {
  return h("section", { style: "display:flex;flex-direction:column;gap:6px" }, [
    h(
      "div",
      {
        style:
          "display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:8px",
      },
      [heading(title), aside ?? null],
    ),
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, children),
  ]);
}

/**
 * A bordered row.
 *
 * It WRAPS, and that is the one thing about it worth writing down. This pane is
 * a full-width tab exactly as often as it is a canvas window, a split, or a
 * narrow side column, and its width has nothing to do with the viewport's - so
 * a media query cannot see the constraint that matters here and there is none.
 * Instead every row is built as groups that can each fall to a line of their
 * own: an identity group that keeps its column until there is no column left,
 * the controls, and the buttons. Wide enough and they sit on one line exactly
 * as they always did; too narrow and they stack, rather than running off the
 * edge behind a horizontal scrollbar nobody looks for.
 *
 * The rule a caller has to follow is only this: give a group `flex:0 1 auto` or
 * `flex:1 1 auto` with `min-width:0`, never `flex:none`. `flex:none` is what
 * makes a group refuse to shrink, and one such group is enough to push the
 * whole row past the pane.
 *
 * @param {(Node|string|null|false|undefined)[]} children @returns {HTMLElement}
 */
export function row(children) {
  return h(
    "div",
    {
      style:
        "display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:6px 10px;" +
        "border:1px solid var(--border);" +
        "border-radius:var(--radius, 8px);background:var(--card, var(--background))",
    },
    children,
  );
}

/**
 * A text input in the app's shape: pill, filled, transparent border until
 * focus. Mirrors `components/ui/input.tsx`.
 *
 * @param {string} placeholder @param {string} [width] @param {number} [height]
 * @returns {HTMLInputElement}
 */
export function textInput(placeholder, width = "100%", height = 26) {
  const el = /** @type {HTMLInputElement} */ (
    h("input", {
      style:
        `height:${height}px;width:${width};min-width:0;border-radius:${PILL};` +
        `border:1px solid transparent;background:color-mix(in oklab,var(--input) 50%,transparent);` +
        `color:var(--foreground);font-size:11px;padding:0 11px;outline:none;` +
        `transition:border-color .12s ease`,
      attrs: { placeholder, spellcheck: "false" },
    })
  );
  el.addEventListener("focus", () => (el.style.borderColor = "var(--ring)"));
  el.addEventListener("blur", () => (el.style.borderColor = "transparent"));
  return el;
}

/**
 * A modal, in the app's own dialog shape.
 *
 * Measured against `components/ui/dialog.tsx` line by line rather than
 * approximated, because "close enough" is what a dialog is worst at hiding:
 * `bg-black/30` + `backdrop-blur-sm`, a `--popover` surface held by a hairline
 * RING (`ring-1 ring-foreground/5`) not a border, `shadow-xl`, `p-6`, `gap-6`,
 * `max-w-md`, `max-h-[calc(100dvh-2rem)]`, `text-sm`, and NO radius class at all
 * so it is square in the shipped theme.
 *
 * The close control is the real one too: an icon-only ghost X in the top-right
 * corner over `--secondary`, turning destructive on hover. A text "Close" button
 * in the header was the single thing that made these read as someone else's
 * dialogs.
 *
 * @param {{ title: Node | string, description?: string, body?: Node | null, footer?: Node,
 *           width?: string, onClose?: () => void }} opts
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function modal(opts) {
  const overlay = h("div", {
    style:
      "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
      "padding:16px;background:rgba(0,0,0,.3);backdrop-filter:blur(4px);" +
      "animation:tedi-dev-fade .1s ease",
  });

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    const at = openModals.indexOf(close);
    if (at !== -1) openModals.splice(at, 1);
    opts.onClose?.();
  };
  /** @param {KeyboardEvent} ev */
  const onKey = (ev) => {
    // Only the TOP dialog answers Escape. Both listeners are on the document in
    // capture phase, so they fire in registration order, and without this check
    // a config dialog that opened an editor on top of itself would close the one
    // underneath and leave the editor stranded.
    if (ev.key !== "Escape" || openModals[openModals.length - 1] !== close) return;
    ev.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  openModals.push(close);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) close();
  });

  const dismiss = h(
    "button",
    {
      title: "Close",
      style:
        "position:absolute;top:16px;right:16px;display:inline-flex;align-items:center;" +
        "justify-content:center;width:26px;height:26px;flex:none;border:0;padding:0;" +
        `border-radius:${PILL};background:var(--secondary);color:var(--muted-foreground);` +
        "cursor:pointer;transition:background-color .12s ease,color .12s ease",
      on: {
        click: close,
        mouseenter: () => {
          dismiss.style.background = "color-mix(in oklab,var(--destructive) 10%,transparent)";
          dismiss.style.color = "var(--destructive)";
        },
        mouseleave: () => {
          dismiss.style.background = "var(--secondary)";
          dismiss.style.color = "var(--muted-foreground)";
        },
      },
    },
    [icon("lucide:X", "currentColor", 14)],
  );

  // `DialogHeader` is a COLUMN of title then description, not a row with the
  // close button in it - the close button is absolutely positioned over the
  // corner, which is why the header gets right padding instead.
  const head = h(
    "div",
    { style: "display:flex;flex-direction:column;gap:6px;padding-right:34px" },
    [
      typeof opts.title === "string"
        ? h("strong", {
            text: opts.title,
            style: "font-size:15px;font-weight:500;line-height:1;font-family:inherit",
          })
        : opts.title,
      opts.description
        ? h("span", {
            text: opts.description,
            style: "font-size:11.5px;line-height:1.5;color:var(--muted-foreground)",
          })
        : null,
    ],
  );

  overlay.append(
    h(
      "div",
      {
        style:
          `position:relative;display:flex;flex-direction:column;gap:16px;padding:20px;` +
          `width:${opts.width ?? "min(28rem,100%)"};max-height:calc(100dvh - 2rem);overflow:hidden;` +
          `background:var(--popover, var(--background));color:var(--popover-foreground, var(--foreground));` +
          `border-radius:var(--radius, 0px);font-size:12px;outline:none;` +
          `box-shadow:0 0 0 1px color-mix(in oklab,var(--foreground) 6%,transparent),` +
          `0 20px 25px -5px rgba(0,0,0,.35),0 8px 10px -6px rgba(0,0,0,.3);` +
          `animation:tedi-dev-pop .1s ease`,
      },
      [dismiss, head, opts.body, opts.footer ?? null],
    ),
  );

  document.body.append(overlay);
  return { el: overlay, close };
}

/** Close handlers of every open dialog, innermost last. @type {(() => void)[]} */
const openModals = [];

/** The dialog's `fade-in-0 zoom-in-95 duration-100`, which has no inline form.
 *  Injected once; a second activation of the extension finds it already there. */
if (typeof document !== "undefined" && !document.getElementById("tedi-devenv-anim")) {
  document.head.append(
    h("style", {
      attrs: { id: "tedi-devenv-anim" },
      text:
        "@keyframes tedi-dev-fade{from{opacity:0}to{opacity:1}}" +
        "@keyframes tedi-dev-pop{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}" +
        // The indeterminate progress sweep. Travels the full track width plus
        // its own, so the block leaves one edge exactly as it enters the other.
        "@keyframes tedi-dev-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}" +
        "@keyframes tedi-dev-spin{to{transform:rotate(360deg)}}",
    }),
  );
}

/**
 * A committed text input.
 *
 * Commits on blur and on Enter, never on every keystroke: each commit here
 * writes a file and may recycle a FastCGI pool.
 *
 * @param {string} value @param {(v: string) => unknown} onCommit @param {string} [placeholder]
 * @returns {HTMLInputElement}
 */
export function input(value, onCommit, placeholder = "") {
  const el = textInput(placeholder);
  el.value = value;
  el.addEventListener("blur", () => void onCommit(el.value));
  el.addEventListener("keydown", (ev) => {
    if (/** @type {KeyboardEvent} */ (ev).key === "Enter") el.blur();
  });
  return el;
}

/**
 * One labelled setting: what it is, what it does, and the control.
 *
 * Every dialog in this pane lays a setting out this way, and three copies of
 * the same twenty lines is how they drift.
 *
 * @param {string} title @param {string} note @param {Node | null} control
 * @returns {HTMLElement}
 */
export function settingRow(title, note, control) {
  return row([
    // `flex:1` on the LABEL and `flex:none` on the control, rather than a
    // spacer between two auto-sized items. Text is the only thing here that can
    // wrap, so under a flex default it is the only thing that gives - and a
    // row with three controls squeezed its description down to one word per
    // line while the buttons kept their full width.
    h("div", { style: "display:flex;flex-direction:column;gap:0;flex:1;min-width:0" }, [
      h("span", { text: title, style: "font-size:12px;font-weight:600;line-height:1" }),
      muted(note),
    ]),
    h(
      "div",
      { style: "display:flex;align-items:center;flex-wrap:wrap;gap:5px;flex:0 1 auto;min-width:0" },
      [control],
    ),
  ]);
}

/**
 * Ask before doing something that cannot be undone.
 *
 * Every Remove in this pane used to fire on the first click, and they are not
 * equal: removing a project unpublishes a site, removing a version deletes a
 * download that took four minutes to fetch. One shared dialog rather than a
 * confirm flag on `button`, because the wording is the whole value - "Remove"
 * twice tells you nothing about what is about to go.
 *
 * Resolves false on Escape, on the backdrop, and on the close button, so every
 * way out of the dialog except the danger button is a no.
 *
 * @param {{ title: string, description: string, confirmLabel?: string,
 *           icon?: string }} opts
 * @returns {Promise<boolean>}
 */
export function confirm(opts) {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = modal({
      title: opts.title,
      description: opts.description,
      body: null,
      footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
        button("Cancel", () => dialog.close()),
        button(
          opts.confirmLabel ?? "Remove",
          () => {
            answer = true;
            dialog.close();
          },
          { variant: "danger", icon: opts.icon ?? "lucide:Trash2" },
        ),
      ]),
      width: "min(24rem,100%)",
      onClose: () => resolve(answer),
    });
  });
}
