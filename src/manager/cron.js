// Scheduled jobs.
//
// The thing a local development environment actually needs a scheduler for is
// one line: `php artisan schedule:run`, every minute, in a project folder. The
// system's own cron cannot do it well - it has the wrong PATH, it runs whether
// or not you are working, and on Windows it does not exist - so this is a
// scheduler of our own, and it runs exactly while the environment does.
//
// THREE DECISIONS, and each one removes a class of problem:
//
//   1. A job is argv, not a shell line. `shell_bg_spawn_direct` takes an
//      argument vector, so there is no quoting layer between what the user typed
//      and what runs, and a project path with a space in it cannot split into
//      two arguments. The cost is that a job cannot contain a pipe or a
//      redirect; a job that needs one calls a script that has one.
//
//   2. A shimmed tool is run THROUGH the shim. `php` in a job resolves to
//      `<internal>/shims/php`, which walks up from the job's working directory
//      for `.tedi-runtime` exactly as a terminal does - so a job in a project
//      pinned to PHP 8.3 runs 8.3, with no second copy of that resolution logic
//      living here to drift from the first one.
//
//   3. The schedule is a real cron expression. Not a "every N minutes" number,
//      because the job people are copying in already reads `* * * * *`, and not
//      a bespoke format they would have to learn. Including the rule that makes
//      cron cron: when BOTH day-of-month and day-of-week are restricted, either
//      one matching is a match.

import { paths, join } from "../core/paths.js";
import { readJson, writeJson } from "../core/fsx.js";
import { run } from "../core/proc.js";
import { SHIMS } from "../project/shims.js";
import { state, isWindows, warn } from "../runtime.js";

/**
 * @typedef {object} CronJob
 * @property {string} id
 * @property {string} name
 * @property {string} schedule  Five cron fields, or one of the `@` aliases.
 * @property {string} command   Argv as one line; quotes group.
 * @property {string} [cwd]     Absolute. Defaults to the environment root.
 * @property {boolean} [enabled]
 * @property {number} [lastRun]     ms since epoch.
 * @property {number} [lastExit]    Exit code of that run.
 * @property {string} [lastOutput]  Its last few lines, for the dashboard.
 */

/** How often the scheduler wakes. Cron's resolution is a minute, so this only
 *  has to be comfortably under one; a job fires once per matching minute
 *  whatever the tick rate, because the minute it last fired for is recorded. */
const TICK_MS = 15_000;

/** A job that has not finished in ten minutes is killed. Long enough for a real
 *  queue worker pass, short enough that a hung job does not sit forever holding
 *  its own slot. */
const JOB_TIMEOUT_MS = 10 * 60_000;

/** What the schedule's `@` shorthands mean. The same set cron itself accepts.
 *  @type {Record<string, string>} */
const ALIASES = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** Loaded job list. @type {CronJob[]} */
let jobs = [];

/** The tick handle while the scheduler is running. @type {ReturnType<typeof setInterval> | null} */
let timer = null;

/** Jobs currently executing, so a slow job never overlaps itself. The value is
 *  the minute stamp it started for. @type {Map<string, string>} */
const running = new Map();

/** The last minute each job fired for, so one matching minute fires once even
 *  though the tick is four times faster. @type {Map<string, string>} */
const fired = new Map();

// ---------------------------------------------------------------------------
// The expression
// ---------------------------------------------------------------------------

/**
 * Does one cron field admit `value`?
 *
 * Handles `*`, `n`, `a-b`, and a `/step` on any of them, comma-separated. A part
 * that does not parse is SKIPPED rather than treated as a wildcard: a typo
 * should make a job not run, which is visible, instead of making it run every
 * minute, which is a surprise at 3am.
 *
 * @param {string} field @param {number} value @param {number} min @param {number} max
 * @returns {boolean}
 */
function fieldMatches(field, value, min, max) {
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) continue;

    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
    if (lo < min || hi > max || lo > hi) continue;

    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/** The five fields of a schedule, or null when it is not one.
 *  @param {string} schedule @returns {string[] | null} */
function fields(schedule) {
  const text = ALIASES[String(schedule).trim().toLowerCase()] ?? String(schedule).trim();
  const parts = text.split(/\s+/).filter(Boolean);
  return parts.length === 5 ? parts : null;
}

/**
 * Is this a schedule at all? Used by the editor so a job cannot be saved with an
 * expression that would silently never fire.
 *
 * @param {string} schedule @returns {boolean}
 */
export function isValidSchedule(schedule) {
  const f = fields(schedule);
  if (!f) return false;
  // Every field has to admit SOMETHING, or the job never runs and the user is
  // left watching a schedule that looks fine.
  const bounds = /** @type {[number, number][]} */ ([
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]);
  return f.every((field, i) => {
    const [min, max] = bounds[i];
    for (let v = min; v <= max; v++) if (fieldMatches(field, v, min, max)) return true;
    return false;
  });
}

/**
 * Does `date` fall in a minute this schedule names?
 *
 * Pure, and exported, because it is the piece whose failure is invisible: a
 * wrong answer here is a job that quietly does not run, or one that runs sixty
 * times an hour when it was meant to run once.
 *
 * @param {string} schedule @param {Date} date @returns {boolean}
 */
export function matches(schedule, date) {
  const f = fields(schedule);
  if (!f) return false;
  const [min, hour, dom, month, dow] = f;

  if (!fieldMatches(min, date.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hour, date.getHours(), 0, 23)) return false;
  if (!fieldMatches(month, date.getMonth() + 1, 1, 12)) return false;

  // Cron's one genuinely surprising rule: when BOTH day fields are restricted,
  // the day matches if EITHER does, not both. `0 0 1 * 1` is the first of the
  // month AND every Monday, which is what every crontab(5) on the planet says
  // and what a copied-in expression will be relying on.
  const domAny = dom.trim() === "*";
  const dowAny = dow.trim() === "*";
  const domHit = fieldMatches(dom, date.getDate(), 1, 31);
  // Sunday is 0, and 7 is also Sunday in every cron that matters.
  const day = date.getDay();
  const dowHit = fieldMatches(dow, day, 0, 6) || (day === 0 && fieldMatches(dow, 7, 0, 7));

  if (domAny && dowAny) return true;
  if (domAny) return dowHit;
  if (dowAny) return domHit;
  return domHit || dowHit;
}

/**
 * Split a command line into argv, respecting quotes.
 *
 * Exported and pure. The alternative was handing the whole line to a shell,
 * which is how `C:\Program Files\...` becomes two arguments; this is fifteen
 * lines and cannot.
 *
 * @param {string} line @returns {string[]}
 */
export function splitCommand(line) {
  /** @type {string[]} */
  const out = [];
  let current = "";
  let quoted = false;
  /** @type {string | null} */
  let quote = null;

  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      // So an explicitly empty argument ("" ) survives as one.
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || quoted) out.push(current);
      current = "";
      quoted = false;
      continue;
    }
    current += ch;
  }
  if (current || quoted) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// The job list
// ---------------------------------------------------------------------------

/** @returns {Promise<CronJob[]>} */
export async function loadJobs() {
  /** @type {{ jobs?: CronJob[] }} */
  const doc = await readJson(paths.cronFile(), {});
  jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
  return jobs;
}

/** @returns {CronJob[]} */
export function listJobs() {
  return jobs;
}

/** @returns {Promise<void>} */
async function save() {
  await writeJson(paths.cronFile(), { jobs });
}

/**
 * Add a job, or update one by id.
 * @param {Partial<CronJob> & { schedule: string, command: string }} patch
 * @returns {Promise<CronJob>}
 */
export async function saveJob(patch) {
  const index = patch.id ? jobs.findIndex((j) => j.id === patch.id) : -1;
  /** @type {CronJob} */
  const job = {
    id: patch.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: patch.name?.trim() || patch.command.trim().slice(0, 40),
    schedule: patch.schedule.trim(),
    command: patch.command.trim(),
    cwd: patch.cwd,
    enabled: patch.enabled ?? true,
    ...(index >= 0 ? { lastRun: jobs[index].lastRun, lastExit: jobs[index].lastExit } : {}),
  };
  jobs = index >= 0 ? jobs.map((j, i) => (i === index ? job : j)) : [...jobs, job];

  // Claim the minute already in progress, so a job saved at 11:07:30 starts
  // firing at 11:08 rather than fifteen seconds after it was typed. Cron fires
  // at the START of a matching minute; running the instant you press Save is a
  // surprise for `* * * * *` and simply wrong for `@daily`, which would
  // otherwise go off if you happened to add it in the first minute of a day.
  fired.set(job.id, minuteStamp(new Date()));

  await save();
  return job;
}

/** @param {string} id @returns {Promise<void>} */
export async function removeJob(id) {
  jobs = jobs.filter((j) => j.id !== id);
  fired.delete(id);
  await save();
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

/**
 * The executable for a job's first word.
 *
 * A tool this environment shims is run THROUGH the shim, which is what makes a
 * job pick up the runtime its project asked for: the shim walks up from the
 * working directory for `.tedi-runtime`, so a job in a project pinned to PHP
 * 8.3 runs 8.3, and the same job moved to another project runs that project's
 * version. Anything else is spawned by name and resolved on the system PATH,
 * exactly as a terminal would.
 *
 * @param {string} name @returns {string}
 */
function programFor(name) {
  const shim = SHIMS.find((s) => s.name === name.toLowerCase());
  if (!shim) return name;
  return join(paths.shims(), isWindows() ? `${shim.name}.cmd` : shim.name);
}

/**
 * Run one job now, whatever its schedule says.
 *
 * @param {CronJob} job
 * @returns {Promise<{ code: number, out: string }>}
 */
export async function runJob(job) {
  const argv = splitCommand(job.command);
  if (argv.length === 0) throw new Error("This job has no command.");

  const cwd = job.cwd?.trim() || paths.root();
  const res = await run(programFor(argv[0]), argv.slice(1), {
    cwd,
    timeoutMs: JOB_TIMEOUT_MS,
  });

  // Recorded on the job so the dashboard can show what happened without
  // keeping a log the user has to go and find.
  //
  // Onto the object that is in the LIST, not the one that was passed in. An
  // edit while a job is running replaces its entry with a new object, and
  // `save()` writes the list - so writing the result onto the caller's copy
  // would persist a list that does not contain the run that just happened.
  const live = jobs.find((j) => j.id === job.id) ?? job;
  live.lastRun = Date.now();
  live.lastExit = res.killed ? -1 : res.code;
  live.lastOutput = res.out.trim().split(/\r?\n/).slice(-4).join("\n").slice(0, 800);
  // What tells the dashboard poll that anything happened at all. See
  // `state.cronRuns`: a run changes nothing else the signature looks at, so
  // without this the row would keep showing the previous result until the user
  // touched something.
  state.cronRuns++;
  await save().catch((err) => warn("could not record a cron run", err));
  return { code: live.lastExit ?? 0, out: live.lastOutput ?? "" };
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/** The minute `date` falls in, as a string that changes exactly once a minute.
 *  @param {Date} date @returns {string} */
function minuteStamp(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

/** One pass. Fires every enabled job whose schedule names this minute and which
 *  has not already fired for it. @returns {Promise<void>} */
async function tick() {
  if (!state.active) return;
  const now = new Date();
  const stamp = minuteStamp(now);

  for (const job of jobs) {
    if (job.enabled === false) continue;
    if (fired.get(job.id) === stamp) continue;
    if (!matches(job.schedule, now)) continue;
    fired.set(job.id, stamp);

    // A job still running from a previous minute is SKIPPED, not queued. Two
    // copies of `schedule:run` in the same project is how a queue processes the
    // same item twice, and a backlog that grows while the first one is stuck is
    // worse than a missed minute.
    if (running.has(job.id)) {
      warn(`cron: ${job.name} is still running from ${running.get(job.id)}; skipping this minute`);
      continue;
    }
    running.set(job.id, stamp);
    void runJob(job)
      .catch((err) => warn(`cron: ${job.name} failed`, err))
      .finally(() => running.delete(job.id));
  }
}

/** Is the scheduler running? @returns {boolean} */
export function isRunning() {
  return timer !== null;
}

/** How many jobs are executing right now. @returns {number} */
export function runningCount() {
  return running.size;
}

/** Start ticking. Idempotent. @returns {Promise<void>} */
export async function startCron() {
  if (timer) return;
  await loadJobs();
  // Nothing fires on the tick that starts the scheduler: `fired` is empty, so
  // the current minute would fire immediately for every `* * * * *` job, which
  // is a surprise burst on every press of Start.
  const stamp = minuteStamp(new Date());
  for (const job of jobs) fired.set(job.id, stamp);
  timer = setInterval(() => void tick(), TICK_MS);
}

/** Stop ticking. Jobs already running are left to finish; they are short, and
 *  killing a half-written queue pass is worse than waiting for it.
 *  @returns {void} */
export function stopCron() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  fired.clear();
}
