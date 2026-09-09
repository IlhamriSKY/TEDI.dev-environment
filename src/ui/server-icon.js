// The status-bar glyph: lucide's `Server` chassis with one light per service.
//
// The chassis is copied EXACTLY from lucide-react's `server` icon - two 20x8
// rounded rects at y=2 and y=14 - because the point is that nothing about the
// shape changed, only what is inside it. Lucide draws one indicator per rack as
// a zero-length line at x=6 with a round cap; those two are replaced by four
// circles at x=6 and its mirror at x=18, which is the same inset from each
// rack's inner edge, so the pair still reads as centred hardware rather than as
// two dots that drifted.
//
// Why an SVG we build ourselves rather than `lucide:Server`:
//
// A lucide icon reaches the status bar as a React component painted in ONE
// `currentColor`, and an SVG asset reaches it as a CSS mask, which is one shape
// in one `background-color`. Both collapse four lights into a single colour, so
// "MySQL is up and Redis died" could only ever be told as one overall tone. The
// host's `iconColored` opts out of that and renders this as an image instead.
//
// The cost of being an image is that the SVG is its own document: it cannot see
// the app's CSS, so `var(--foreground)` and `currentColor` are both dead inside
// it. Every colour here is therefore READ from the live theme and baked into
// the markup, which is also why this is a function and not a constant.

/** Where each service's light sits, and which services own it.
 *
 *  Four lights for six services: `cron` is a timer inside this extension, not
 *  something you connect to, and the two web servers are exclusive (the ticked
 *  one is the one project URLs point at), so they share the top-left seat. */
const LAMPS = [
  { x: 6, y: 6, ids: ["nginx", "apache"] },
  { x: 18, y: 6, ids: ["redis"] },
  { x: 6, y: 18, ids: ["mysql"] },
  { x: 18, y: 18, ids: ["postgres"] },
];

// How wide the halo is, and how far it is blurred.
//
// TUNED AT 16 PX, which is the only size that matters: that is what the status
// bar renders, and at that scale the whole glyph is 16 px and a light's core is
// 1.3. Blurs of 1.6 and 1.4 were tried first and both fogged the chassis into a
// grey smudge, worst on a light theme where the halo washed the rack's own
// stroke out - a glow that eats the thing it is supposed to be attached to. At
// 1.0 the rack stays crisp and the bloom is still there.
//
// Be honest about the ceiling: at 16 px the bloom is a hint, not a halo. What
// actually tells a running service from a failed one is the COLOUR; the glow is
// what stops the lights reading as flat printed dots, and it comes into its own
// at the 24 px the icon is natively drawn at. Re-tune both numbers together if
// this is ever rendered somewhere larger.
const HALO_R = 1.8;
const HALO_BLUR = 1.0;

/**
 * The breathing glow.
 *
 * CSS, not SMIL, and declared INSIDE the SVG because the host renders this as
 * an `<img>`: the file is its own document, so nothing in the app's stylesheet
 * reaches it. Scripts are blocked in that context and declarative animation is
 * not, which is exactly why the animation had to be CSS.
 *
 * 2.4s is slow on purpose. This is the only thing in the status bar that moves
 * with nothing happening, and anything quicker turns a bar you are supposed to
 * glance at into something that keeps asking to be looked at. It also costs a
 * repaint forever, so if that ever shows up in a profile, deleting this
 * constant and the `class="b"` on the halo turns the lights back to steady.
 *
 * The floor is .2 rather than 0: a halo that reaches zero is a light switching
 * off twice a second, and the steady core underneath is what it would be read
 * against. Reduced motion turns it off outright - the colour already carries
 * the state, so nothing is lost by holding still.
 */
const BREATHE =
  `<style>@keyframes b{0%,100%{opacity:.85}50%{opacity:.2}}` +
  `.b{animation:b 2.4s ease-in-out infinite}` +
  `@media(prefers-reduced-motion:reduce){.b{animation:none}}</style>`;

/** Read a live theme token. Custom properties inherit, so `body` sees whatever
 *  `:root` and the theme class set, and it also catches a theme applied to the
 *  body itself. The fallbacks are the shipped dark theme's values, for the one
 *  frame before the stylesheet has resolved.
 *  @param {string} name @param {string} fallback @returns {string} */
function token(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * One light.
 *
 * A lit light is two circles: a blurred halo and a crisp core. The halo is what
 * makes it read as GLOWING rather than as a coloured dot, and it needs the
 * oversized filter region below because a filter's default region is the bbox
 * plus 10%, which clips a blur this wide to a square.
 *
 * An unlit one is the core alone at low alpha. Drawn rather than omitted: the
 * four seats have to stay visible or the glyph changes shape as services come
 * up, and a light you can see is off says more than an empty rack.
 *
 * @param {{ x: number, y: number }} seat
 * @param {"on" | "error" | "off"} state
 * @param {{ on: string, error: string, off: string }} colours
 */
function lamp(seat, state, colours) {
  const at = `cx="${seat.x}" cy="${seat.y}"`;
  if (state === "off") return `<circle ${at} r="1" fill="${colours.off}" opacity=".3"/>`;
  const colour = state === "error" ? colours.error : colours.on;
  // The HALO breathes, the core does not. A light whose whole body fades out is
  // a light going off and on, which reads as a fault however green it is; a
  // steady core under a breathing halo is the same LED with its glow rising and
  // falling, and it never stops saying "this service is up".
  return (
    `<circle ${at} r="${HALO_R}" fill="${colour}" opacity=".8" filter="url(#glow)" class="b"/>` +
    `<circle ${at} r="1" fill="${colour}"/>`
  );
}

/**
 * Build the icon for a set of service states.
 *
 * @param {(ids: string[]) => "on" | "error" | "off"} stateOf
 *   Answers what one seat's services add up to. Passed in rather than reading
 *   `state.services` here so this file stays about drawing.
 * @returns {string} A `data:` URL for `StatusItem.icon`, with `iconColored`.
 */
export function serverIcon(stateOf) {
  const colours = {
    // `--tedi-icon-idle` is the GREEN one despite the name: in the AI CLI
    // vocabulary idle means ready, which is what a running service is. Same
    // triad `ui/el.js` uses for its row lights, so a custom theme moves the
    // status bar and the dashboard together.
    on: token("--tedi-icon-idle", "#34d399"),
    error: token("--tedi-icon-blocked", "#f87171"),
    off: token("--foreground", "#cccccc"),
  };

  const lights = LAMPS.map((seat) => lamp(seat, stateOf(seat.ids), colours));

  // The chassis dims when every light is out, which is the "off" look the host
  // would have applied for us if it were still allowed to tint this. It is not,
  // so the extension does it - and it is better placed to, because only the
  // extension knows the difference between nothing running and nothing
  // installed reading the same grey.
  const lit = LAMPS.some((seat) => stateOf(seat.ids) !== "off");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    BREATHE +
    // Region well outside the bbox, or the halo is clipped square.
    `<filter id="glow" x="-200%" y="-200%" width="500%" height="500%">` +
    `<feGaussianBlur stdDeviation="${HALO_BLUR}"/></filter>` +
    `<g fill="none" stroke="${colours.off}" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" opacity="${lit ? 1 : 0.45}">` +
    `<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>` +
    `<rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>` +
    `</g>${lights.join("")}</svg>`;

  // `encodeURIComponent`, not base64: a theme token can be `oklch(0.148 0.004
  // 228.8)`, whose spaces and parens are legal in the markup and not in a URL,
  // and an unencoded `#` from a hex colour would cut the URL into a fragment.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
