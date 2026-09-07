// Running processes.
//
// Everything one-shot goes through `shell_bg_spawn_direct` + `shell_bg_logs`
// rather than `shell_run_command`, and that is not a style choice. The latter
// takes a single COMMAND STRING and runs it through the user's login shell, so
// every argument has to be quoted correctly for cmd.exe or for sh, and the
// first path containing a space (`D:\Ilham\Project\laragon\www\TEDI - terax-ai`,
// for instance) silently splits into two arguments. `spawn_direct` takes argv,
// so there is no quoting layer to get wrong. `sh()` exists for the handful of
// cases that genuinely need shell features, and is spelled differently so a
// reader can see which one they are looking at.

import { ctx, state } from "../runtime.js";

/**
 * @typedef {object} RunResult
 * @property {string} out   Combined stdout+stderr, as the ring buffer saw it.
 * @property {number} code  Exit code; 0 when the process reported none.
 * @property {boolean} killed  True when we killed it on timeout.
 */

/** Poll schedule for a running one-shot: fast at first so a quick command
 *  returns promptly, then backing off so a long download is not 400 IPC calls
 *  a minute. */
const POLL_STEPS = [40, 60, 100, 150, 250, 400];

/** @param {number} attempt @returns {number} */
function pollDelay(attempt) {
  return POLL_STEPS[Math.min(attempt, POLL_STEPS.length - 1)];
}

/**
 * Run a program to completion and collect its output.
 *
 * @param {string} program
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, onOutput?: (chunk: string) => void }} [opts]
 * @returns {Promise<RunResult>}
 */
export async function run(program, args = [], opts = {}) {
  const { cwd, timeoutMs = 120_000, onOutput } = opts;
  if (!ctx) throw new Error("extension is not active");

  /** @type {number} */
  const handle = await ctx.invoke("shell_bg_spawn_direct", {
    program,
    args,
    ...(cwd ? { cwd } : {}),
  });

  let offset = 0;
  let out = "";
  let attempt = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    for (;;) {
      const log = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: offset });
      offset = log.next_offset;
      if (log.bytes) {
        out += log.bytes;
        onOutput?.(log.bytes);
      }
      if (log.exited) return { out, code: log.exit_code ?? 0, killed: false };

      // A deactivate mid-run must not leave a poll loop spinning forever.
      if (!state.active) {
        await kill(handle);
        return { out, code: -1, killed: true };
      }
      if (Date.now() > deadline) {
        await kill(handle);
        return { out, code: -1, killed: true };
      }
      await sleep(pollDelay(attempt++));
    }
  } finally {
    // Drop the handle from the host's table either way; leaving it leaks a slot
    // and keeps a dead process listed in `shell_bg_list` forever.
    await ctx.invoke("shell_bg_remove", { handle }).catch(() => {});
  }
}

/**
 * Start a long-running process and return its handle. The caller owns the
 * handle and must kill it; nothing here supervises it.
 *
 * @param {string} program
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function spawn(program, args = [], opts = {}) {
  if (!ctx) throw new Error("extension is not active");
  return await ctx.invoke("shell_bg_spawn_direct", {
    program,
    args,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
}

/** @param {number} handle @returns {Promise<void>} */
export async function kill(handle) {
  await ctx?.invoke("shell_bg_kill", { handle }).catch(() => {});
}

/**
 * Read new output from a running process without waiting for it to exit.
 *
 * @param {number} handle
 * @param {number} sinceOffset
 */
export async function logs(handle, sinceOffset = 0) {
  if (!ctx) throw new Error("extension is not active");
  return await ctx.invoke("shell_bg_logs", { handle, sinceOffset });
}

/**
 * Is this handle still running?
 *
 * Asked through `shell_bg_list` rather than by reading logs at a huge offset:
 * the offset is a position in a ring buffer, and handing it one past the end is
 * asking the host a question about memory it may have already dropped. A handle
 * the host has forgotten is absent from the list, which reads as "not running" -
 * the honest answer for our purposes.
 *
 * @param {number} handle
 * @returns {Promise<boolean>}
 */
export async function isAlive(handle) {
  if (!ctx) return false;
  try {
    const list = await ctx.invoke("shell_bg_list");
    const row = list.find((p) => p.handle === handle);
    return Boolean(row) && !row?.exited;
  } catch {
    return false;
  }
}

/**
 * Run a real shell command string. Only for cases that need shell features
 * (pipes, redirection, builtins). Prefer `run()`.
 *
 * @param {string} command
 * @param {{ cwd?: string, timeoutSecs?: number }} [opts]
 */
export async function sh(command, opts = {}) {
  if (!ctx) throw new Error("extension is not active");
  return await ctx.invoke("shell_run_command", {
    command,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutSecs ? { timeoutSecs: opts.timeoutSecs } : {}),
  });
}

/**
 * Absolute path of a program on the system PATH, or null.
 *
 * Windows has no `command -v`, and `where` prints every match, so take the
 * first line on both. A non-zero exit means not found, which is not an error
 * worth throwing over: callers are asking precisely because it might be absent.
 *
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function which(name) {
  const isWin = ctx?.os?.platform === "windows";
  try {
    const res = isWin
      ? await run("where", [name], { timeoutMs: 8_000 })
      : await run("sh", ["-c", `command -v ${shellQuote(name)}`], { timeoutMs: 8_000 });
    if (res.code !== 0) return null;
    const hit = res.out.trim().split(/\r?\n/)[0]?.trim();
    return hit || null;
  } catch {
    return null;
  }
}

/**
 * Quote one argument for a POSIX shell. Used only by `which`, which genuinely
 * needs `sh -c`; everything else passes argv and needs no quoting at all.
 *
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Show a folder in the operating system's file manager.
 *
 * Each platform has exactly one command for this and they take a bare path, so
 * `run` carries it as argv and a folder name with a space needs no quoting.
 * Windows `explorer.exe` returns exit code 1 even when it succeeded, which is
 * why the result is ignored rather than checked.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function openFolder(path) {
  const platform = ctx?.os?.platform;
  const program =
    platform === "windows" ? "explorer.exe" : platform === "macos" ? "open" : "xdg-open";
  await run(program, [path], { timeoutMs: 15_000 }).catch(() => {});
}

/** @param {number} ms @returns {Promise<void>} */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a program and return only its first line of output, trimmed. The shape
 * every `--version` probe wants.
 *
 * @param {string} program
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function probe(program, args, opts = {}) {
  try {
    const res = await run(program, args, { timeoutMs: 10_000, ...opts });
    if (res.code !== 0) return null;
    const line = res.out.trim().split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}
