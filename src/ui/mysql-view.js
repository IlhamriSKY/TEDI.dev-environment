// The MySQL accounts dialog.

import {
  h,
  row,
  muted,
  button,
  modal,
  textInput,
  checkbox,
  confirm,
  skeleton,
  pill,
  settingRow,
} from "./el.js";
import { listAccounts, createAccount, setPassword, dropAccount } from "../manager/mysqlusers.js";
import { ctx } from "../runtime.js";

/**
 * Open it.
 *
 * The list is fetched when the dialog opens rather than kept in `state`: it is
 * a query against a running server, it changes for reasons this extension never
 * sees, and nothing outside this dialog reads it.
 *
 * @returns {void}
 */
export function openAccounts() {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:2px;min-height:60px" }, [
    skeleton("60%"),
    skeleton("45%"),
  ]);

  const dialog = modal({
    title: "MySQL accounts",
    description:
      "Who may connect, and from where. This environment starts with root and no password, which is right for loopback and wrong for anything you hand to someone else.",
    body,
    footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
      button("Add account", () => openNewAccount(load), {
        variant: "primary",
        icon: "lucide:Plus",
      }),
      button("Done", () => dialog.close()),
    ]),
    width: "min(34rem,100%)",
  });

  async function load() {
    const res = await listAccounts();
    if (!res.ok) {
      body.replaceChildren(muted(res.error ?? "Could not read the account list."));
      return;
    }
    body.replaceChildren(
      ...(res.accounts.length
        ? res.accounts.map((account) => accountRow(account, load))
        : [muted("No accounts, which should be impossible while MySQL is running.")]),
    );
  }
  void load();
}

/**
 * @param {import("../manager/mysqlusers.js").Account} account
 * @param {() => Promise<void>} reload
 * @returns {HTMLElement}
 */
function accountRow(account, reload) {
  const isRoot = account.user === "root";
  return row([
    h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
      h("span", {
        text: account.user,
        style: "font-size:12px;font-weight:600;line-height:1",
      }),
      muted(account.host === "%" ? "from anywhere" : `from ${account.host}`),
    ]),
    h("div", { style: "flex:1" }),
    isRoot ? pill("built in", { title: "Created when the data directory was initialised" }) : null,
    button("Password", () => openPassword(account, reload), { icon: "lucide:KeyRound" }),
    // Dropping root leaves a server nobody can administer, and nothing here can
    // put it back: the account is created once, when `mysqld --initialize` runs.
    isRoot
      ? null
      : button(
          "Remove",
          async () => {
            const ok = await confirm({
              title: `Remove ${account.user}@${account.host}?`,
              description:
                "The account is dropped and anything connecting as it stops being able to. Its databases are untouched.",
            });
            if (!ok) return;
            const res = await dropAccount(account);
            if (!res.ok) ctx?.ui.toast(res.error ?? "Could not remove it.", { variant: "error" });
            await reload();
          },
          { variant: "danger" },
        ),
  ]);
}

/** @param {() => Promise<void>} reload @returns {void} */
function openNewAccount(reload) {
  const user = textInput("app");
  const host = textInput("localhost");
  host.value = "localhost";
  const password = textInput("");
  password.setAttribute("type", "password");
  const privileges = toggle(false);

  const dialog = modal({
    title: "New MySQL account",
    body: h("div", { style: "display:flex;flex-direction:column;gap:2px" }, [
      sized("Name", "Letters, digits, dot, dash and underscore.", user),
      sized("From", "`localhost` for this machine, `%` for anywhere.", host),
      sized("Password", "Stored by MySQL, never by this extension.", password),
      settingRow(
        "All privileges",
        "Everything on every database. Off is the safer default.",
        privileges.el,
      ),
    ]),
    footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
      button("Cancel", () => dialog.close()),
      button(
        "Create",
        async () => {
          const res = await createAccount({
            user: user.value.trim(),
            host: host.value.trim() || "localhost",
            password: password.value,
            allPrivileges: privileges.on(),
          });
          if (!res.ok) {
            ctx?.ui.toast(res.error ?? "Could not create the account.", { variant: "error" });
            return;
          }
          dialog.close();
          await reload();
        },
        { variant: "primary", icon: "lucide:Plus" },
      ),
    ]),
    width: "min(30rem,100%)",
  });
  user.focus();
}

/**
 * @param {import("../manager/mysqlusers.js").Account} account
 * @param {() => Promise<void>} reload
 * @returns {void}
 */
function openPassword(account, reload) {
  const password = textInput("");
  password.setAttribute("type", "password");

  const dialog = modal({
    title: `Password for ${account.user}@${account.host}`,
    description: "Blank sets no password, which is what root starts with.",
    body: h("div", { style: "display:flex;flex-direction:column;gap:2px" }, [
      sized("New password", "Takes effect on the next connection.", password),
    ]),
    footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
      button("Cancel", () => dialog.close()),
      button(
        "Set",
        async () => {
          const res = await setPassword(account, password.value);
          if (!res.ok) {
            ctx?.ui.toast(res.error ?? "Could not set the password.", { variant: "error" });
            return;
          }
          dialog.close();
          await reload();
        },
        { variant: "primary" },
      ),
    ]),
    width: "min(28rem,100%)",
  });
  password.focus();
}

/**
 * A checkbox that flips itself.
 *
 * `checkbox` renders a STATE, not a control - it has no checked/unchecked
 * behaviour of its own - so every caller elsewhere repaints its whole row to
 * show a change. There is no row to repaint inside a dialog, so this keeps one
 * wrapper in the document and swaps what is inside it.
 *
 * @param {boolean} initial
 * @returns {{ el: HTMLElement, on: () => boolean }}
 */
function toggle(initial) {
  let on = initial;
  const el = h("span", { style: "display:inline-flex" });
  const paint = () => {
    const box = checkbox(on);
    box.addEventListener("click", () => {
      on = !on;
      paint();
    });
    el.replaceChildren(box);
  };
  paint();
  return { el, on: () => on };
}

/** `settingRow` with the input given a consistent width. Text inputs default to
 *  filling their parent, which in a dialog is the whole line.
 *  @param {string} title @param {string} note @param {HTMLElement} input
 *  @returns {HTMLElement} */
function sized(title, note, input) {
  input.style.width = "168px";
  return settingRow(title, note, input);
}
