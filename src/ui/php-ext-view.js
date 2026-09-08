// The PHP extension browser.
//
// ONE list, ticked where an extension is active. It was two - loadable ones as
// toggles, compiled-in ones as a wrap of badges behind a `<details>` - because a
// tick next to something that cannot be unticked looked like a lie. It reads the
// other way round in use: "is mbstring on?" had two different answers in two
// different shapes, and a tick honestly means ACTIVE, which a compiled-in
// extension permanently is. Those rows simply do not take a click and say "built
// in" so the dead click is explained rather than merely dead.
//
// The tick itself is the app's own flat square (`el.checkbox`), not a native
// `<input type=checkbox>` tinted with `accent-color`, which on Windows is a
// rounded shaded OS widget with its own hover and focus rings.
//
// The "add" modal filters a list of roughly fifteen hundred names, so it filters
// as you type against a list fetched once, rather than asking the network per
// keystroke.

import { h, button, muted, modal, textInput, checkbox } from "./el.js";
import {
  listExtensions,
  availableExtensions,
  installExtension,
  enable,
  manageable,
} from "../manager/phpext.js";
import { reloadPhpPool } from "../manager/services.js";
import { ctx } from "../runtime.js";

/**
 * The extensions block for one PHP version.
 *
 * @param {string} version
 * @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
export async function extensionsBlock(version, refresh) {
  const check = await manageable(version);
  const rows = await listExtensions(version);
  const on = rows.filter((r) => r.enabled).length;

  const count = muted(
    check.ok ? `${on} of ${rows.length} extensions active` : (check.reason ?? ""),
  );

  // A search box, because a working PHP lists sixty-odd extensions in a grid
  // and "is pdo_pgsql on?" was a question you answered by reading all of them.
  // It filters what is already in hand rather than re-listing: the rows come
  // from one php.ini read and one directory listing, and typing must not repeat
  // either.
  const search = textInput("Search extensions");
  search.style.width = "168px";

  const header = h(
    "div",
    { style: "display:flex;align-items:center;justify-content:space-between;gap:8px" },
    [
      count,
      h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
        check.ok ? search : null,
        check.ok
          ? button("Add extension", () => void openBrowser(version, refresh), {
              icon: "lucide:Plus",
            })
          : null,
      ]),
    ],
  );

  // ONE list, sorted, with the active ones ticked - compiled-in extensions
  // included. They used to be hidden behind a `<details>` as a wrap of badges,
  // on the reasoning that a switch next to something that cannot be switched is
  // a lie. But that split the answer to "is mbstring on?" across two different
  // shapes in two different places, and the honest reading of a tick here is
  // "active", which a compiled-in extension is - permanently. It simply does
  // not take a click, and says why.
  const list = h("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:4px",
  });

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    list.replaceChildren(
      ...(hits.length
        ? hits.map((info) => extensionChip(info, version, refresh, check.ok))
        : [muted(`Nothing matches "${search.value.trim()}".`)]),
    );
    count.textContent = q
      ? `${hits.filter((r) => r.enabled).length} of ${hits.length} matching are active`
      : check.ok
        ? `${on} of ${rows.length} extensions active`
        : (check.reason ?? "");
  };

  search.addEventListener("input", draw);
  draw();

  return h("div", { style: "display:flex;flex-direction:column;gap:8px" }, [header, list]);
}

/**
 * One extension, with its state made legible.
 *
 * "enabled but missing" is drawn as an error rather than as an on switch,
 * because that is exactly the state that makes PHP print a startup warning on
 * every single command, and the user has no other way to find out why.
 *
 * @param {import("../manager/phpext.js").ExtensionInfo} info
 * @param {string} version
 * @param {() => void} refresh
 * @param {boolean} canToggle
 * @returns {HTMLElement}
 */
function extensionChip(info, version, refresh, canToggle) {
  const broken = info.enabled && !info.present;
  // Compiled into the binary: active, and no click will ever change that.
  const fixed = info.builtin || !canToggle;

  // The whole chip is the control, not a checkbox sitting inside a label. One
  // hit target instead of two, it takes focus and Space/Enter for free, and it
  // removes the input-inside-label pairing that made the click land twice
  // depending on where in the chip it happened.
  const chip = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        title: broken
          ? "Enabled in php.ini, but the file is missing"
          : info.builtin
            ? `${info.name} is compiled into this PHP and is always on`
            : info.name,
        attrs: { "aria-pressed": String(info.enabled) },
        style:
          "display:flex;align-items:center;gap:7px;padding:3px 9px;text-align:left;" +
          `border:1px solid ${broken ? "color-mix(in oklab,var(--destructive) 45%,transparent)" : "var(--border)"};` +
          `background:transparent;color:var(--foreground);font-size:11.5px;font-family:inherit;` +
          `min-width:0;outline:none;cursor:${fixed ? "default" : "pointer"}`,
      },
      [
        checkbox(info.enabled),
        h("span", {
          text: info.name,
          style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0",
        }),
        broken
          ? h("span", { text: "missing", style: "color:var(--destructive);font-size:10px" })
          : // Says WHY the tick will not move, rather than leaving a dead click.
            // Not the old badge list - the row is in the same grid as the rest,
            // this is only the reason it is fixed.
            info.builtin
            ? h("span", {
                text: "built in",
                style: "color:var(--muted-foreground);font-size:9.5px;flex:none",
              })
            : null,
      ],
    )
  );

  if (fixed) {
    chip.disabled = true;
    // A compiled-in extension is ACTIVE, so it is not dimmed like an
    // unavailable control; it just cannot be pressed.
    if (!info.builtin) chip.style.opacity = "0.6";
    return chip;
  }

  chip.addEventListener("focus", () => (chip.style.borderColor = "var(--ring)"));
  chip.addEventListener("blur", () => {
    chip.style.borderColor = broken
      ? "color-mix(in oklab,var(--destructive) 45%,transparent)"
      : "var(--border)";
  });

  chip.addEventListener("click", async () => {
    if (chip.disabled) return;
    chip.disabled = true;
    chip.style.opacity = "0.6";
    try {
      await enable(info.name, version, !info.enabled);
      // The CLI re-reads php.ini per process, but the FastCGI worker does not,
      // so a toggle that did not recycle the pool would appear to do nothing on
      // the site while working in the terminal.
      await reloadPhpPool(version);
      refresh();
    } catch (err) {
      ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
      chip.disabled = false;
      chip.style.opacity = "1";
    }
  });

  return chip;
}

/**
 * A searchable list of every extension PECL builds, filtered as you type.
 *
 * @param {string} version @param {() => void} refresh
 * @returns {Promise<void>}
 */
async function openBrowser(version, refresh) {
  let names;
  try {
    names = await availableExtensions();
  } catch (err) {
    ctx?.ui.toast(`Could not reach the PECL index: ${err instanceof Error ? err.message : err}`, {
      variant: "error",
    });
    return;
  }
  if (names.length === 0) {
    ctx?.ui.toast("No extension index is available for this platform.", { variant: "warning" });
    return;
  }

  const have = new Set((await listExtensions(version)).map((r) => r.name));

  const results = h("div", {
    style: "overflow:auto;display:flex;flex-direction:column;gap:1px;max-height:46vh",
  });

  const field = textInput(`Search ${names.length} extensions`);

  /** @type {{ close: () => void }} */
  let dialog;

  const draw = () => {
    const q = field.value.trim().toLowerCase();
    // Capped, because rendering fifteen hundred rows on every keystroke is what
    // makes a search box feel broken.
    const hits = (q ? names.filter((n) => n.includes(q)) : names).slice(0, 60);
    results.replaceChildren(
      ...hits.map((name) =>
        h(
          "button",
          {
            style:
              "display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 10px;" +
              "border:0;border-radius:999px;background:transparent;color:var(--foreground);" +
              "font-size:11.5px;cursor:pointer",
            on: {
              click: async () => {
                dialog.close();
                ctx?.ui.toast(`Installing ${name}`, { variant: "info" });
                try {
                  await installExtension(name, version);
                  await reloadPhpPool(version);
                  ctx?.ui.toast(`${name} installed and enabled.`, { variant: "success" });
                } catch (err) {
                  ctx?.ui.toast(err instanceof Error ? err.message : String(err), {
                    variant: "error",
                  });
                }
                refresh();
              },
              mouseenter: (e) => {
                /** @type {HTMLElement} */ (e.currentTarget).style.background = "var(--accent)";
              },
              mouseleave: (e) => {
                /** @type {HTMLElement} */ (e.currentTarget).style.background = "transparent";
              },
            },
          },
          [h("span", { text: name, style: "flex:1" }), have.has(name) ? muted("installed") : null],
        ),
      ),
    );
    if (hits.length === 0) results.append(muted("Nothing matches that."));
  };

  field.addEventListener("input", draw);
  draw();

  dialog = modal({
    title: `Add an extension`,
    description: `Only builds matching PHP ${version}'s branch, thread-safety and architecture are offered.`,
    body: h("div", { style: "display:flex;flex-direction:column;gap:9px;min-height:0" }, [
      field,
      results,
    ]),
  });
  field.focus();
}
