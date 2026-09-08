// The Projects section.
//
// A project row is the whole per-project story on one line: its domain, which
// PHP and Node it resolves to, and where that decision came from. That last
// part matters more than it looks - "8.2 (composer.json)" tells a user why
// their project is not on the version they set globally, which is otherwise the
// most confusing thing a version manager does.

import {
  h,
  row,
  pill,
  muted,
  button,
  dropdown,
  section,
  status,
  icon,
  confirm,
  modal,
  textInput,
} from "./el.js";
import {
  domainOf,
  addProject,
  updateProject,
  removeProject,
  discoverProjects,
  slug,
} from "../project/projects.js";
import { resolveProject } from "../project/resolve.js";
import { installedOf } from "../manager/versions.js";
import { paths, join } from "../core/paths.js";
import { openFolder } from "../core/proc.js";
import { mkdirp, exists } from "../core/fsx.js";
import { publish } from "../web/publish.js";
import { state, config, ctx } from "../runtime.js";

/** @typedef {import("../runtime.js").Project} Project */

/**
 * Rendered asynchronously because each row needs the project's resolved
 * runtime, which reads files. The caller mounts a placeholder and replaces it.
 *
 * @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
export async function projectsView(refresh) {
  /** @type {HTMLElement[]} */
  const rows = [];
  for (const project of state.projects) {
    rows.push(await projectRow(project, refresh));
  }

  const aside = h("div", { style: "display:flex;gap:5px;align-items:center" }, [
    button(
      "Open www",
      async () => {
        await mkdirp(paths.www());
        await openFolder(paths.www());
      },
      { icon: "lucide:FolderOpen", title: paths.www() },
    ),
    button("Refresh", () => void refreshProjects(refresh), {
      icon: "lucide:RefreshCw",
      title: `Pick up anything new in ${paths.www()}`,
    }),
    button("New project", () => void newProject(refresh), {
      variant: "primary",
      icon: "lucide:Plus",
      title: `Create a folder in ${paths.www()} and serve it`,
    }),
  ]);

  if (rows.length === 0) {
    rows.push(
      h(
        "div",
        {
          style:
            "display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px;" +
            "border:1px dashed var(--border);border-radius:6px;text-align:center",
        },
        [
          h("span", {
            text: "No projects yet.",
            style: "font-size:11.5px;color:var(--muted-foreground)",
          }),
          muted(`Press New project, or drop a folder in ${paths.www()} and press Refresh.`),
        ],
      ),
    );
  }

  return section("Projects", rows, aside);
}

/**
 * @param {Project} project @param {() => void} refresh
 * @returns {Promise<HTMLElement>}
 */
async function projectRow(project, refresh) {
  const domain = domainOf(project);
  // ONE resolve, not two. `resolveProject` already calls `readRequests` and
  // returns the very `sources` object it produced, so asking for it again
  // re-read `.nvmrc`, `.node-version` and `composer.json` for every project on
  // every repaint - three file reads per project, for an answer already in
  // hand.
  const resolved = await resolveProject(project);
  const enabled = project.enabled !== false;
  const scheme = (project.https ?? config.autoHttps) ? "https" : "http";
  const port = scheme === "https" ? config.httpsPort : config.httpPort;
  const url = `${scheme}://${domain}${isDefaultPort(scheme, port) ? "" : `:${port}`}`;

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;min-width:190px;flex:none" },
    [
      icon("lucide:Folder", enabled ? "var(--primary)" : "var(--muted-foreground)"),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        // `line-height:1` so the name's box hugs its glyphs. At 1.35 the box is
        // 16px tall around 12px of text, and centring THAT against a 13px tick
        // centres two boxes of different heights - which reads as the name
        // sitting low, because it is.
        h("span", { style: "display:flex;align-items:center;gap:5px;min-width:0" }, [
          status(enabled ? "ok" : "idle"),
          h("span", {
            text: project.name,
            style:
              "font-size:12px;font-weight:600;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
          }),
        ]),
        h("a", {
          text: url,
          title: project.path,
          attrs: { href: url, target: "_blank", rel: "noreferrer" },
          style: "color:var(--muted-foreground);font-size:10.5px;text-decoration:none",
        }),
      ]),
    ],
  );

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:5px;flex:1;min-width:0;flex-wrap:wrap" },
    [
      versionPicker("php", project, resolved.php, resolved.sources.php, refresh),
      versionPicker("node", project, resolved.node, resolved.sources.node, refresh),
      resolved.sources.phpFallback ? muted(resolved.sources.phpFallback) : null,
      resolved.sources.nodeFallback ? muted(resolved.sources.nodeFallback) : null,
    ],
  );

  const right = h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
    button("Folder", () => openFolder(project.path), {
      icon: "lucide:FolderOpen",
      title: `Open ${project.path} in the file manager`,
    }),
    // Feature-detected, not declared with `engines.tedi`: an older host simply
    // does not show the button, rather than refusing to install the extension
    // over one row control. `ctx.tabs.openTerminal` landed in TEDI 0.4.46.
    typeof ctx?.tabs?.openTerminal === "function"
      ? button("Terminal", () => void openProjectTerminal(project), {
          icon: "lucide:SquareTerminal",
          title: `Open a terminal in ${project.path}`,
        })
      : null,
    button(
      enabled ? "Disable" : "Enable",
      async () => {
        await updateProject(project.id, { enabled: !enabled });
        // A disabled project has to stop being SERVED, not just look grey.
        await publish().catch(() => {});
        refresh();
      },
      enabled
        ? { variant: "danger", icon: "lucide:PowerOff" }
        : { variant: "success", icon: "lucide:Power" },
    ),
    button(
      "Remove",
      async () => {
        const ok = await confirm({
          title: `Remove ${project.name}?`,
          description:
            "Its virtual host, certificate and hosts entry go. The folder and everything " +
            "in it stays exactly where it is.",
        });
        if (!ok) return;
        await removeProject(project.id);
        await publish().catch(() => {});
        refresh();
      },
      { variant: "danger" },
    ),
  ]);

  return row([left, middle, right]);
}

/** 80 and 443 are implied by the scheme; showing them is noise.
 *  @param {string} scheme @param {number} port @returns {boolean} */
function isDefaultPort(scheme, port) {
  return (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
}

/**
 * A per-project runtime override.
 *
 * "Follow global" is the first option and the default, so the common case needs
 * no decision, and a project only carries a pin when someone deliberately set
 * one.
 *
 * @param {"php" | "node"} kind
 * @param {Project} project
 * @param {string | null} resolvedVersion
 * @param {string | undefined} source
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function versionPicker(kind, project, resolvedVersion, source, refresh) {
  const installed = installedOf(kind);
  const pinned = kind === "php" ? project.php : project.node;
  const label = kind === "php" ? "PHP" : "Node";

  const options = [
    { value: "", label: `${label}: global`, hint: resolvedVersion ?? undefined },
    ...installed.map((v) => ({ value: v.version, label: `${label} ${v.version}` })),
  ];

  return h("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [
    dropdown(
      options,
      pinned ?? "",
      async (value) => {
        await updateProject(project.id, { [kind]: value || undefined });
        refresh();
      },
      { width: "132px" },
    ),
    // Where the version came from when the project did not pin one here. A
    // `.nvmrc` or composer.json constraint is invisible otherwise, and it is
    // the reason the picker says "global" while the project runs 8.2.
    !pinned && source ? pill(source) : null,
  ]);
}

/**
 * Put the current projects on the air, and say what happened.
 *
 * Adding a project used to give you a row in a list and nothing served: the
 * vhost, the certificate and the hosts entry all waited for someone to know
 * about "Apply changes". They do not wait any more - `publish()` runs here, so
 * a project that has just been added answers on `https://<name>.test` as soon
 * as the web server is up.
 *
 * @param {string[]} names @param {() => void} refresh @returns {Promise<void>}
 */
async function serve(names, refresh) {
  const label =
    names.length === 1 ? names[0] : `${names.length} project${names.length === 1 ? "" : "s"}`;
  try {
    const res = await publish();
    const suffix = res.hostsOk
      ? ""
      : ` The hosts file was not updated: ${res.hostsMessage ?? "permission refused"}.`;
    ctx?.ui.toast(
      `${label} added, with a virtual host and an HTTPS certificate.${suffix}` +
        (res.restarted ? "" : ` Start ${config.webServer} to serve it.`),
      { variant: res.hostsOk ? "success" : "warning" },
    );
  } catch (err) {
    ctx?.ui.toast(
      `${label} added, but its virtual host could not be written: ${err instanceof Error ? err.message : String(err)}`,
      { variant: "warning" },
    );
  }
  refresh();
}

/**
 * A terminal in the project's own folder.
 *
 * TEDI's own terminal, not one of ours: the shims this extension puts on the
 * terminal PATH are what make `php` and `node` in there resolve to the version
 * THIS project asks for, and that only happens in the app's shell. A terminal
 * of our own would have been a second shell with none of that.
 *
 * @param {Project} project @returns {Promise<void>}
 */
async function openProjectTerminal(project) {
  // The folder can have been deleted since the row was drawn, and a shell that
  // starts in a directory that is not there lands somewhere else without saying
  // so - which reads as the button opening the wrong terminal.
  if (!(await exists(project.path))) {
    ctx?.ui.toast(`${project.path} is not there any more.`, { variant: "error" });
    return;
  }
  ctx?.tabs?.openTerminal?.({ cwd: project.path });
}

/**
 * Make the folder, then serve it.
 *
 * This used to be a folder picker, and a picker is the wrong dialog for the
 * thing people actually do: they are not finding an existing project, they are
 * starting one. So the answer is a name, `www/<name>` is created, and the site
 * is live before they have opened an editor. The folder picker is still one
 * click away as "Open www" beside it, for a project that lives somewhere else -
 * drop it in and press Refresh.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function newProject(refresh) {
  const name = await askProjectName();
  if (!name) return;
  const dir = join(paths.www(), name);
  try {
    if (await exists(dir)) {
      // Registering it anyway would be the friendly-looking answer and the
      // wrong one: "New project" that quietly adopts whatever was already at
      // that path is how you end up serving a folder you forgot about.
      ctx?.ui.toast(`${dir} already exists. Press Refresh to serve it.`, { variant: "warning" });
      return;
    }
    await mkdirp(dir);
    const project = await addProject(dir);
    await serve([project.name], refresh);
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}

/**
 * Ask for the name, as a folder name and a domain label at once.
 *
 * `slug` is what the domain uses, so the field shows what the domain WILL be
 * rather than letting someone type "My App" and then find a site at
 * `my-app.test` they did not name. The folder gets the same slug, so the two
 * never diverge.
 *
 * @returns {Promise<string | null>}
 */
function askProjectName() {
  return new Promise((resolve) => {
    /** @type {string | null} */
    let answer = null;
    const field = textInput("my-app");
    const preview = muted("");
    const sync = () => {
      const name = slug(field.value.trim());
      preview.textContent = field.value.trim()
        ? `Creates ${join(paths.www(), name)}, served at ${name}.${config.domainSuffix}`
        : "";
    };
    field.addEventListener("input", sync);

    const commit = () => {
      if (!field.value.trim()) return;
      answer = slug(field.value.trim());
      dialog.close();
    };
    field.addEventListener("keydown", (ev) => {
      if (/** @type {KeyboardEvent} */ (ev).key === "Enter") commit();
    });

    const dialog = modal({
      title: "New project",
      description: `A folder in ${paths.www()}, with its virtual host and certificate written for it.`,
      body: h("div", { style: "display:flex;flex-direction:column;gap:6px" }, [field, preview]),
      footer: h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
        button("Cancel", () => dialog.close()),
        button("Create", commit, { variant: "primary", icon: "lucide:Plus" }),
      ]),
      onClose: () => resolve(answer),
    });
    field.focus();
  });
}

/**
 * Pick up anything new in `www`.
 *
 * The environment's own folder and no other: dropping a project in there is the
 * documented way to add one you already have, and a picker asking WHERE to look
 * every time was a question with the same answer on every press.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function refreshProjects(refresh) {
  await mkdirp(paths.www());
  try {
    const found = await discoverProjects(paths.www());
    if (found.length === 0) {
      refresh();
      ctx?.ui.toast(`Nothing new in ${paths.www()}.`, { variant: "info" });
      return;
    }
    /** @type {string[]} */
    const added = [];
    for (const item of found) added.push((await addProject(item.path)).name);
    await serve(added, refresh);
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}
