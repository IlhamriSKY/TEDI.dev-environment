// The Projects section.
//
// A project row is the whole per-project story on one line: its domain, which
// PHP and Node it resolves to, and where that decision came from. That last
// part matters more than it looks - "8.2 (composer.json)" tells a user why
// their project is not on the version they set globally, which is otherwise the
// most confusing thing a version manager does.

import { h, row, pill, muted, button, dropdown, section, status, icon } from "./el.js";
import {
  domainOf,
  addProject,
  updateProject,
  removeProject,
  discoverProjects,
} from "../project/projects.js";
import { resolveProject } from "../project/resolve.js";
import { installedOf } from "../manager/versions.js";
import { paths } from "../core/paths.js";
import { openFolder } from "../core/proc.js";
import { mkdirp } from "../core/fsx.js";
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
    button("Scan", () => void scanFolder(refresh), {
      icon: "lucide:Radar",
      title: "Register every project-looking folder under a directory",
    }),
    button("Add project", () => void addByPath(refresh), {
      variant: "primary",
      icon: "lucide:Plus",
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
          muted(`Drop a folder in ${paths.www()} and press Scan, or add one from anywhere.`),
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
        h("span", { style: "display:flex;align-items:center;gap:5px" }, [
          status(enabled ? "ok" : "idle"),
          h("span", {
            text: project.name,
            style: "font-size:12px;font-weight:600;line-height:1.35",
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
    button("Open", () => openFolder(project.path), {
      icon: "lucide:FolderOpen",
      title: project.path,
    }),
    button(enabled ? "Disable" : "Enable", async () => {
      await updateProject(project.id, { enabled: !enabled });
      // A disabled project has to stop being SERVED, not just look grey.
      await publish().catch(() => {});
      refresh();
    }),
    button(
      "Remove",
      async () => {
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
 * Register a folder the user picks.
 *
 * A native folder picker rather than a typed path: `ctx.ui.pickFolder` opens
 * the same OS dialog the folder-tree bridge already uses, and a typed absolute
 * path is how a stray character ends up in one.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function addByPath(refresh) {
  const picked = await ctx?.ui.pickFolder({
    title: "Add a project folder",
    defaultPath: paths.www(),
  });
  if (!picked) return;
  try {
    const project = await addProject(picked);
    await serve([project.name], refresh);
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}

/**
 * Register every project-looking folder under a parent directory.
 *
 * Defaults to the environment's own `www`: put a folder there and it becomes a
 * site. Any other folder still works.
 *
 * @param {() => void} refresh @returns {Promise<void>}
 */
async function scanFolder(refresh) {
  await mkdirp(paths.www());
  const target = await ctx?.ui.pickFolder({
    title: "Scan a folder for projects",
    defaultPath: paths.www(),
  });
  if (!target) return;
  try {
    const found = await discoverProjects(target);
    if (found.length === 0) {
      ctx?.ui.toast(`No unregistered projects found in ${target}.`, { variant: "info" });
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
