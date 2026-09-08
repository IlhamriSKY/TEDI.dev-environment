// The Cron section: the scheduled jobs and what they last did.
//
// A job row answers the three questions someone has when they look at a
// scheduler: when does it run, what does it run, and did the last one work.
// The third is the one every cron UI leaves out and every user then goes
// hunting for in a log file, so the exit code and the tail of the output are on
// the row.
//
// The editor is a dialog with four fields and no wizard. A cron expression is
// the thing people paste in from a README; offering a builder instead would
// mean translating what they already have into clicks.

import { h, row, pill, muted, button, status, section, icon, modal, textInput } from "./el.js";
import {
  listJobs,
  saveJob,
  removeJob,
  runJob,
  isValidSchedule,
  splitCommand,
} from "../manager/cron.js";
import { isRunning as isCronRunning } from "../manager/cron.js";
import { start } from "../manager/services.js";
import { paths } from "../core/paths.js";
import { state, ctx } from "../runtime.js";

/** @typedef {import("../manager/cron.js").CronJob} CronJob */

/** The examples the placeholder and the empty state offer. Chosen because each
 *  is a thing people actually schedule, not because it demonstrates syntax. */
const EXAMPLES = [
  { schedule: "* * * * *", command: "php artisan schedule:run", name: "Laravel scheduler" },
  { schedule: "*/5 * * * *", command: "php artisan queue:work --stop-when-empty", name: "Queue" },
  { schedule: "0 3 * * *", command: "npm run backup", name: "Nightly backup" },
];

/**
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
export function cronView(refresh) {
  const jobs = listJobs();
  const rows = jobs.map((job) => jobRow(job, refresh));

  const aside = h("div", { style: "display:flex;gap:5px;align-items:center" }, [
    // Said here rather than only on the Services row, because this is the
    // section where a stopped scheduler looks like a broken one: the jobs are
    // all listed, they all have schedules, and nothing happens.
    isCronRunning()
      ? muted("Scheduler running")
      : button(
          "Start scheduler",
          async () => {
            await start("cron");
            refresh();
          },
          { icon: "lucide:Play", variant: jobs.length ? "primary" : "default" },
        ),
    button("Add job", () => openEditor(null, refresh), { variant: "primary", icon: "lucide:Plus" }),
  ]);

  if (rows.length === 0) {
    rows.push(
      h(
        "div",
        {
          style:
            "display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px;" +
            "border:1px dashed var(--border);text-align:center",
        },
        [
          h("span", {
            text: "No scheduled jobs.",
            style: "font-size:11.5px;color:var(--muted-foreground)",
          }),
          muted(`For example: ${EXAMPLES[0].command} on ${EXAMPLES[0].schedule}.`),
        ],
      ),
    );
  }

  return section("Cron", rows, aside);
}

/**
 * How a run went, in the shortest form that is still actionable.
 *
 * `null` exit means it has never run, which is different from having run and
 * succeeded and is the state a user misreads most often - a job added a minute
 * ago with the scheduler stopped looks identical to one that ran cleanly.
 *
 * @param {CronJob} job @returns {{ tone: "ok"|"error"|"idle", text: string }}
 */
function lastRunSummary(job) {
  if (!job.lastRun) return { tone: "idle", text: "never run" };
  const when = new Date(job.lastRun).toLocaleString();
  if (job.lastExit === 0) return { tone: "ok", text: `ok · ${when}` };
  if (job.lastExit === -1) return { tone: "error", text: `timed out · ${when}` };
  return { tone: "error", text: `exit ${job.lastExit} · ${when}` };
}

/**
 * @param {CronJob} job @param {() => void} refresh
 * @returns {HTMLElement}
 */
function jobRow(job, refresh) {
  const enabled = job.enabled !== false;
  const last = lastRunSummary(job);

  const left = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px;min-width:190px;flex:none" },
    [
      icon("lucide:CalendarClock", enabled ? "var(--primary)" : "var(--muted-foreground)"),
      h("div", { style: "display:flex;flex-direction:column;gap:0;min-width:0" }, [
        h("span", { style: "display:flex;align-items:center;gap:5px" }, [
          status(enabled ? last.tone : "idle"),
          h("span", { text: job.name, style: "font-size:12px;font-weight:600;line-height:1.35" }),
        ]),
        muted(enabled ? last.text : "disabled"),
      ]),
    ],
  );

  const middle = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap" },
    [
      pill(job.schedule),
      h("span", {
        text: job.command,
        title: job.cwd || paths.root(),
        style:
          "font-family:ui-monospace,monospace;font-size:11px;overflow:hidden;" +
          "text-overflow:ellipsis;white-space:nowrap;min-width:0",
      }),
      // The tail of what it printed, and only when it failed: on a green run
      // nobody reads it, and on a red one it is the whole reason they came here.
      job.lastExit && job.lastExit !== 0 && job.lastOutput
        ? h("span", {
            text: job.lastOutput.split("\n").slice(-1)[0],
            title: job.lastOutput,
            style: "color:var(--destructive);font-size:11px;min-width:0",
          })
        : null,
    ],
  );

  const right = h("div", { style: "display:flex;align-items:center;gap:5px;flex:none" }, [
    button("Run now", () => void runOnce(job, refresh), {
      icon: "lucide:Play",
      title: "Run this job immediately, whatever its schedule says",
    }),
    button(enabled ? "Disable" : "Enable", async () => {
      await saveJob({ ...job, enabled: !enabled });
      refresh();
    }),
    button("Edit", () => openEditor(job, refresh), { icon: "lucide:PenLine" }),
    button(
      "Remove",
      async () => {
        await removeJob(job.id);
        refresh();
      },
      { variant: "danger" },
    ),
  ]);

  return row([left, middle, right]);
}

/**
 * Run a job by hand and say what came back.
 *
 * The point of the button is the feedback: a schedule you cannot test without
 * waiting for it is a schedule you find out about at 3am.
 *
 * @param {CronJob} job @param {() => void} refresh @returns {Promise<void>}
 */
async function runOnce(job, refresh) {
  ctx?.ui.toast(`Running ${job.name}`, { variant: "info" });
  try {
    const res = await runJob(job);
    ctx?.ui.toast(
      res.code === 0
        ? `${job.name} finished.`
        : `${job.name} exited ${res.code}. ${res.out.split("\n").slice(-1)[0] ?? ""}`,
      { variant: res.code === 0 ? "success" : "error" },
    );
  } catch (err) {
    ctx?.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
  refresh();
}

/**
 * Add or edit a job.
 *
 * Validated before it saves rather than after it fails to fire: an expression
 * with a typo in it is a job that silently never runs, and there is nowhere for
 * that to surface later.
 *
 * @param {CronJob | null} job @param {() => void} refresh
 * @returns {void}
 */
function openEditor(job, refresh) {
  const name = textInput("Nightly backup");
  const schedule = textInput("* * * * *");
  const command = textInput("php artisan schedule:run");
  const folder = textInput(paths.root());

  name.value = job?.name ?? "";
  schedule.value = job?.schedule ?? "* * * * *";
  command.value = job?.command ?? "";
  folder.value = job?.cwd ?? "";

  const problem = muted("");
  problem.style.color = "var(--destructive)";

  /** @param {string} text */
  const complain = (text) => {
    problem.textContent = text;
  };

  const save = button(
    job ? "Save job" : "Add job",
    async () => {
      if (!command.value.trim()) return complain("A job needs a command to run.");
      if (splitCommand(command.value).length === 0) return complain("That command is empty.");
      if (!isValidSchedule(schedule.value)) {
        return complain(
          "That is not a schedule. Five fields (minute hour day month weekday), or @daily / @hourly.",
        );
      }
      try {
        await saveJob({
          id: job?.id,
          name: name.value,
          schedule: schedule.value,
          command: command.value,
          cwd: folder.value.trim() || undefined,
          enabled: job?.enabled ?? true,
        });
        close();
        refresh();
      } catch (err) {
        complain(err instanceof Error ? err.message : String(err));
      }
    },
    { variant: "primary" },
  );
  save.style.flex = "1";
  save.style.height = "30px";

  /** @param {string} label @param {HTMLElement} field @param {string} hint @returns {HTMLElement} */
  const labelled = (label, field, hint) =>
    h("label", { style: "display:flex;flex-direction:column;gap:3px;min-width:0" }, [
      h("span", {
        text: label,
        style: "font-size:11px;font-weight:500;color:var(--muted-foreground)",
      }),
      field,
      muted(hint),
    ]);

  const pick = button(
    "Choose",
    async () => {
      const picked = await ctx?.ui.pickFolder({
        title: "Where should this job run?",
        defaultPath: folder.value.trim() || paths.www(),
      });
      if (picked) folder.value = picked;
    },
    { icon: "lucide:FolderOpen" },
  );

  const { close } = modal({
    title: job ? `Edit ${job.name}` : "Add a scheduled job",
    description:
      "Runs while the scheduler is on. The command is an argument list, not a shell line, so a pipe or a redirect belongs in a script the job calls.",
    body: h("div", { style: "display:flex;flex-direction:column;gap:11px;min-height:0" }, [
      labelled("Name", name, "What it is, for the list. Blank uses the command."),
      labelled(
        "Schedule",
        schedule,
        "minute hour day month weekday. `*/5 * * * *` is every five minutes; @daily and @hourly also work.",
      ),
      labelled(
        "Command",
        command,
        // The whole reason a job resolves its project's runtime.
        "php, node, npm and composer resolve to the version the folder below asks for.",
      ),
      labelled(
        "Folder",
        h("div", { style: "display:flex;gap:5px;align-items:center" }, [folder, pick]),
        `Where it runs, and what decides its PHP and Node. Blank uses ${paths.root()}.`,
      ),
      problem,
      // Only when there is nothing to copy from yet.
      state.projects.length && !job ? exampleRow(command, schedule, name, folder) : null,
    ]),
    footer: h("div", { style: "display:flex;gap:8px" }, [save]),
    width: "min(620px,100%)",
  });

  (job ? schedule : command).focus();
}

/**
 * One-click starting points.
 *
 * Not a template picker: they fill the fields in and leave them editable, so
 * the user sees the expression they are getting rather than a label that hides
 * it.
 *
 * @param {HTMLInputElement} command @param {HTMLInputElement} schedule
 * @param {HTMLInputElement} name @param {HTMLInputElement} folder
 * @returns {HTMLElement}
 */
function exampleRow(command, schedule, name, folder) {
  return h("div", { style: "display:flex;flex-direction:column;gap:5px" }, [
    muted("Start from:"),
    h(
      "div",
      { style: "display:flex;gap:5px;flex-wrap:wrap" },
      EXAMPLES.map((ex) =>
        button(ex.name, () => {
          command.value = ex.command;
          schedule.value = ex.schedule;
          if (!name.value) name.value = ex.name;
          if (!folder.value && state.projects[0]) folder.value = state.projects[0].path;
        }),
      ),
    ),
  ]);
}
