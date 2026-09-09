/**
 * AI tools for the Dev Environment.
 *
 * Until now this extension registered NONE. It manages PHP and Node at any
 * number of versions, MySQL, MariaDB, PostgreSQL, Redis, nginx, Apache, per
 * project vhosts, local HTTPS and a cron scheduler - and the entire agent-facing
 * surface was three palette commands: open the panel, start everything, stop
 * everything. An agent could not tell you whether MySQL was running, let alone
 * start it, and "why is my site returning 502" was unanswerable without a human
 * clicking through the dashboard.
 *
 * EVERYTHING HERE IS A THIN WRAPPER over the functions the dashboard itself
 * calls. Not politeness - the sequencing is load-bearing and easy to get subtly
 * wrong, and a second implementation would get it wrong differently:
 *   - `updateProject` re-emits `.tedi-runtime`, which is what makes a version
 *     pin take effect in a terminal. A caller that wrote `state.projects`
 *     directly would leave every shell on the old runtime with nothing saying why.
 *   - `republish()` regenerates vhosts, certificates and hosts entries and
 *     reloads the server. A project added without it exists in the list and is
 *     served by nothing.
 *   - `saveJob` claims the minute in progress, so a job added at 11:07:30 first
 *     fires at 11:08 rather than fifteen seconds later.
 *
 * Anything that changes the machine is `approval: "needsApproval"`. An
 * extension's AI tool runs unvetted third-party code with the app's own
 * privileges, and starting a database, rewriting a vhost or scheduling a cron
 * job are all things a prompt-injected model must not do quietly. The two reads
 * are `auto` because an agent has to be able to look before it asks.
 */
import { config, ctx, state } from "./runtime.js";
import { activeVersion, setActiveVersion } from "./manager/config.js";
import { isValidSchedule, listJobs, removeJob, runJob, saveJob } from "./manager/cron.js";
import {
  IN_PROCESS,
  SERVICE_IDS,
  refreshStatuses,
  restart,
  start,
  startAll,
  stop,
  stopAll,
} from "./manager/services.js";
import { installedOf } from "./manager/versions.js";
import { addProject, projectUrl, removeProject, updateProject } from "./project/projects.js";
import { republish } from "./web/publish.js";

/** Runtime components a project or the machine can pin a version of. Read off
 *  what is actually installed rather than listed here twice. */
const RUNTIME_IDS = ["php", "node", "composer"];

/** Fields of a project that decide what the web server serves. A patch touching
 *  any of them needs `republish()`; a pure version pin does not, and paying the
 *  elevation prompt for one would be a UAC dialog for changing a PHP number. */
const VHOST_FIELDS = ["name", "path", "suffix", "domain", "docRoot", "kind", "proxyPort", "https", "enabled"];

/** @param {string} id */
function serviceRow(id) {
  const s = state.services.get(id);
  return {
    id,
    state: s?.state ?? "stopped",
    port: s?.port ?? null,
    version: s?.version ?? null,
    error: s?.error ?? null,
    // A port held by something this extension did not start is the single most
    // common reason a service will not come up, and the row already knows.
    conflict: s?.conflict ? `port ${s.conflict.port} is held by ${s.conflict.name}` : null,
    installed: IN_PROCESS.has(id) ? true : installedOf(id).length > 0,
  };
}

/** @param {import("./runtime.js").Project} p */
function projectRow(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    url: projectUrl(p),
    kind: p.kind ?? "php",
    docRoot: p.docRoot ?? null,
    php: p.php ?? null,
    node: p.node ?? null,
    enabled: p.enabled !== false,
  };
}

/** @param {import("./manager/cron.js").CronJob} j */
function jobRow(j) {
  return {
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    command: j.command,
    cwd: j.cwd ?? null,
    enabled: j.enabled !== false,
    lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
    lastExit: j.lastExit ?? null,
    lastOutput: j.lastOutput ?? null,
  };
}

/** The project named by id, name or path. Throws naming what IS registered,
 *  because "not found" with no list costs the model a whole extra step.
 *  @param {unknown} ref */
function projectOr(ref) {
  const needle = String(ref ?? "").trim();
  const hit = state.projects.find(
    (p) => p.id === needle || p.name === needle || p.path === needle,
  );
  if (hit) return hit;
  const have = state.projects.map((p) => `${p.name} (${p.id})`).join(", ") || "(none registered)";
  throw new Error(`No project "${needle}". Have: ${have}`);
}

/**
 * Annotated, because in a bare array literal `approval: "needsApproval"` widens
 * to `string` and stops satisfying the union the host declares.
 * @type {(import("../tedi").ContributedAiTool & { handler: (args: any) => any })[]}
 */
const TOOLS = [
  {
    name: "devenv_status",
    description:
      "The whole local development environment in one call: every service (nginx, apache, mysql, postgres, redis, cron) with its state, port and why it failed; the installed and active versions of PHP, Node and Composer; every registered project with its URL and pinned runtimes; and where the environment root is. Read-only. Start here - the ids every other devenv tool takes come from this.",
    approval: "auto",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      // Live, not the last poll: the poll only runs while the dashboard pane is
      // MOUNTED, so with the pane closed every row would be as stale as the
      // moment it was last looked at.
      await refreshStatuses().catch(() => {});
      /** @type {Record<string, { active: string | null, installed: string[] }>} */
      const runtimes = {};
      for (const id of RUNTIME_IDS) {
        runtimes[id] = {
          active: activeVersion(id) ?? null,
          installed: installedOf(id).map((v) => v.version),
        };
      }
      return {
        root: config.rootDir,
        webServer: config.webServer,
        httpPort: config.httpPort,
        httpsPort: config.httpsPort,
        domainSuffix: config.domainSuffix,
        services: SERVICE_IDS.map(serviceRow),
        runtimes,
        projects: state.projects.map(projectRow),
        cron: { running: state.services.get("cron")?.state === "running", jobs: listJobs().length },
        startupError: state.startupError,
      };
    },
  },

  {
    name: "devenv_service",
    description:
      'Start, stop or restart one service, or all of them with id "all". Returns the service\'s state afterwards, so a failure comes back with its reason and any port conflict rather than needing a second call.',
    approval: "needsApproval",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "restart"] },
        id: {
          type: "string",
          description: 'A service id from devenv_status, or "all".',
        },
      },
      required: ["action", "id"],
    },
    handler: async ({ action, id }) => {
      const target = String(id).trim().toLowerCase();
      if (target === "all") {
        if (action === "start") await startAll();
        else if (action === "stop") await stopAll();
        else {
          await stopAll();
          await startAll();
        }
        await refreshStatuses().catch(() => {});
        return { services: SERVICE_IDS.map(serviceRow) };
      }
      if (!SERVICE_IDS.includes(target)) {
        throw new Error(`No service "${target}". Have: ${SERVICE_IDS.join(", ")}, all.`);
      }
      if (action === "start") await start(target);
      else if (action === "stop") await stop(target);
      else await restart(target);
      return serviceRow(target);
    },
  },

  {
    name: "devenv_project",
    description:
      "Register a folder as a served site, change one, or unregister it. A change to anything the web server cares about (name, doc root, domain suffix, kind, HTTPS, enabled) regenerates the vhosts, certificates and hosts entries and reloads the server, which may raise one elevation prompt. Pinning `php` or `node` does not - it rewrites the project's runtime file, so a terminal opened there resolves that version.",
    approval: "needsApproval",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "remove"] },
        path: { type: "string", description: "add: absolute folder to serve." },
        project: { type: "string", description: "update / remove: id, name or path." },
        name: { type: "string" },
        docRoot: { type: "string", description: "Sub-path served, relative to the project." },
        kind: { type: "string", enum: ["php", "static", "proxy"] },
        proxyPort: { type: "number", description: 'kind "proxy": the backend port.' },
        php: { type: "string", description: "Pin a PHP version for this project." },
        node: { type: "string", description: "Pin a Node version for this project." },
        https: { type: "boolean" },
        enabled: { type: "boolean" },
      },
      required: ["action"],
    },
    handler: async (args) => {
      const { action, path, project: ref, ...rest } = args ?? {};
      /** Only the keys the caller actually sent - spreading `rest` wholesale
       *  would write `undefined` over a pin the user set by hand.
       *  @type {Record<string, unknown>} */
      const patch = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) patch[k] = v;

      if (action === "add") {
        if (!path) throw new Error("add needs `path` (an absolute folder).");
        const p = await addProject(String(path), patch);
        await republish();
        return projectRow(p);
      }
      const target = projectOr(ref);
      if (action === "remove") {
        await removeProject(target.id);
        await republish();
        return { removed: target.id, name: target.name };
      }
      if (action !== "update") throw new Error(`Unknown action "${action}".`);
      if (Object.keys(patch).length === 0) {
        throw new Error("update needs at least one field to change.");
      }
      const next = await updateProject(target.id, patch);
      if (!next) throw new Error(`Project "${target.id}" disappeared while updating it.`);
      if (Object.keys(patch).some((k) => VHOST_FIELDS.includes(k))) await republish();
      return projectRow(next);
    },
  },

  {
    name: "devenv_runtime",
    description:
      "Set which installed version of php, node or composer is the default for the whole machine. Versions come from devenv_status; installing a new one is a download with a progress bar and stays in the panel. To pin a version for ONE project use devenv_project instead.",
    approval: "needsApproval",
    parameters: {
      type: "object",
      properties: {
        component: { type: "string", enum: RUNTIME_IDS },
        version: { type: "string", description: "An installed version from devenv_status." },
      },
      required: ["component", "version"],
    },
    handler: async ({ component, version }) => {
      const have = installedOf(String(component)).map((v) => v.version);
      if (!have.includes(String(version))) {
        throw new Error(
          `${component} ${version} is not installed. Have: ${have.join(", ") || "(none)"}. Install it from the Dev Environment panel.`,
        );
      }
      await setActiveVersion(String(component), String(version));
      return { component, active: activeVersion(String(component)) ?? null, installed: have };
    },
  },

  {
    name: "devenv_cron",
    description:
      "The scheduled jobs that run on real cron expressions, resolving each job's runtime from the folder it runs in. `list` them with their last exit code and output; `add` / `update` / `remove` one; `run` one right now and get its output back. The scheduler itself is the `cron` service - start it with devenv_service, or a saved job never fires.",
    approval: "needsApproval",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "remove", "run"] },
        id: { type: "string", description: "update / remove / run: an id from `list`." },
        name: { type: "string" },
        schedule: {
          type: "string",
          description: "add / update: five cron fields, or @daily / @hourly / @reboot.",
        },
        command: { type: "string", description: "add / update: argv on one line; quotes group." },
        cwd: { type: "string", description: "Absolute. Defaults to the environment root." },
        enabled: { type: "boolean" },
      },
      required: ["action"],
    },
    handler: async ({ action, id, name, schedule, command, cwd, enabled }) => {
      if (action === "list") return { jobs: listJobs().map(jobRow), running: isCronUp() };
      if (action === "remove") {
        const job = jobOr(id);
        await removeJob(job.id);
        return { removed: job.id, name: job.name };
      }
      if (action === "run") {
        const job = jobOr(id);
        const res = await runJob(job);
        return { id: job.id, exitCode: res.code, output: res.out };
      }
      if (action === "add" || action === "update") {
        const base = action === "update" ? jobOr(id) : null;
        const nextSchedule = schedule ?? base?.schedule;
        const nextCommand = command ?? base?.command;
        if (!nextSchedule || !nextCommand) {
          throw new Error("add needs `schedule` and `command`.");
        }
        // The same gate the editor applies. An expression that parses as nothing
        // saves happily and then never fires, which is the failure a user cannot
        // see: the job sits in the list looking correct.
        if (!isValidSchedule(nextSchedule)) {
          throw new Error(
            `"${nextSchedule}" is not a cron schedule. Use five fields (e.g. "*/5 * * * *") or @hourly / @daily / @weekly / @monthly / @reboot.`,
          );
        }
        const job = await saveJob({
          id: base?.id,
          name: name ?? base?.name,
          schedule: nextSchedule,
          command: nextCommand,
          cwd: cwd ?? base?.cwd,
          enabled: enabled ?? base?.enabled ?? true,
        });
        return { ...jobRow(job), schedulerRunning: isCronUp() };
      }
      throw new Error(`Unknown action "${action}".`);
    },
  },
];

/** Is the cron service up? A job saved while it is not will never fire, and
 *  that is worth saying in the same answer rather than a support question. */
function isCronUp() {
  return state.services.get("cron")?.state === "running";
}

/** @param {unknown} ref */
function jobOr(ref) {
  const needle = String(ref ?? "").trim();
  const hit = listJobs().find((j) => j.id === needle || j.name === needle);
  if (hit) return hit;
  const have = listJobs().map((j) => `${j.name} (${j.id})`).join(", ") || "(no jobs)";
  throw new Error(`No cron job "${needle}". Have: ${have}`);
}

/**
 * Register with the host. Mirrors `tedi.api-client` and `tedi.sql-explorer`: the
 * DECLARATIONS go to `ctx.contribute.aiTools` and the handlers to
 * `registerAiToolHandler`, both at runtime from `activate()`. The manifest never
 * carries AI tools - reading `manifest.contributes.aiTools` reports an empty
 * list for every extension that actually ships some.
 */
export function registerAiTools() {
  if (typeof ctx?.contribute?.aiTools !== "function") return false;
  ctx.contribute.aiTools(TOOLS.map(({ handler: _handler, ...declaration }) => declaration));
  for (const tool of TOOLS) ctx.registerAiToolHandler?.(tool.name, tool.handler);
  return true;
}
