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

/**
 * A button, in the app's own shape.
 *
 * Disables itself while its handler runs: every action here is async and most
 * take seconds, and without this a second click starts a second download of the
 * same thing into the same file.
 *
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} onClick
 * @param {{ variant?: "primary" | "default" | "danger" | "ghost", title?: string,
 *           disabled?: boolean, icon?: string }} [opts]
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
    ghost: "background:transparent;color:var(--muted-foreground)",
  }[variant];

  // The label lives in its own span rather than as the button's text, so an
  // icon can sit beside it and so the busy state below can dim the button
  // without erasing the icon along with the words.
  const btn = /** @type {HTMLButtonElement} */ (
    h("button", { style: `${base};${skin}`, title: opts.title }, [
      opts.icon ? icon(opts.icon, "currentColor", iconOnly ? 14 : 13) : null,
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
    try {
      await onClick();
    } finally {
      // The panel usually re-renders and throws this node away; restoring is
      // for the case where it does not.
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
 * panel redraws. Each icon name appears exactly once in a paint, so the master
 * node is cached and MOVED into its new position rather than cloned - which
 * also sidesteps the second trap, that a clone taken before the host's lazy
 * chunk lands is permanently empty.
 *
 * @param {string} name    A `lucide:<Name>` reference.
 * @param {string} [colour] CSS colour for the glyph.
 * @param {number} [size]
 * @returns {HTMLElement}
 */
export function icon(name, colour, size = 15) {
  const slot = h("span", {
    style: `display:inline-flex;flex:none;width:${size}px;height:${size}px;color:${colour ?? "var(--muted-foreground)"}`,
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
    if (art) slot.replaceChildren(art.cloneNode(true));
    return Boolean(art);
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
  // The app's own breathing pulse, by name. `ai-breathe` is defined at the top
  // level of `styles/globals.css` precisely so it is always available, and this
  // pane renders in the same document - so the animation an active AI CLI icon
  // uses is the animation this uses, rather than a second one that drifts from
  // it. If the host ever drops the keyframe the icon simply stops breathing,
  // which is the right way for a decoration to fail.
  if (spec.breathe) node.style.animation = "ai-breathe 1.8s ease-in-out infinite";
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
  ok: { icon: "lucide:CircleCheck", colour: "var(--tedi-icon-idle, #34d399)", breathe: false },
  working: {
    icon: "lucide:LoaderCircle",
    colour: "var(--tedi-icon-working, #facc15)",
    breathe: true,
  },
  warn: {
    icon: "lucide:TriangleAlert",
    colour: "var(--tedi-icon-working, #facc15)",
    breathe: false,
  },
  error: {
    icon: "lucide:CircleAlert",
    colour: "var(--tedi-icon-blocked, var(--destructive))",
    breathe: false,
  },
  idle: { icon: "lucide:Circle", colour: "var(--muted-foreground)", breathe: false },
};

/**
 * A progress bar, in the shape `components/ui/progress.tsx` renders.
 *
 * That component is a `bg-muted` track with a `bg-primary/90` indicator moved
 * by `translateX(-(100 - value)%)` rather than resized, which is what makes the
 * `transition-all` animate smoothly instead of reflowing. Ported rather than
 * reinvented so a download here looks like every other progress in the app.
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
        "display:flex;align-items:center;height:12px;width:100%;min-width:0;" +
        "overflow-x:hidden;background:var(--muted)",
    },
    [indicator],
  );
}

/** A muted one-line caption. @param {string} text @returns {HTMLElement} */
export function muted(text) {
  return h("span", {
    text,
    style: "color:var(--muted-foreground);font-size:10.5px;line-height:1.45",
  });
}

/** A small pill, for versions and ports. @param {string} text @returns {HTMLElement} */
export function pill(text) {
  return h("span", {
    text,
    title: text,
    style:
      `display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `padding:2px 9px;border-radius:${PILL};background:var(--muted);` +
      `color:var(--muted-foreground);font-size:10px;font-family:ui-monospace,monospace`,
  });
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
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:8px" }, [
      heading(title),
      aside ?? null,
    ]),
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, children),
  ]);
}

/** A bordered row. @param {(Node|string|null|false|undefined)[]} children @returns {HTMLElement} */
export function row(children) {
  return h(
    "div",
    {
      style:
        "display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border);" +
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
 * @param {{ title: Node | string, description?: string, body: Node, footer?: Node,
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
        "@keyframes tedi-dev-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}",
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
