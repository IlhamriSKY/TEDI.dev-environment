# tedi.devenv - Architecture and Technical Plan

A complete local development environment manager, native to TEDI,
cross-platform, and fully data-driven.

Written before implementation, from a read of TEDI v0.4.43 source. Every
decision below cites the host fact that forced it.

---

## 1. What TEDI already gives us (do not rebuild these)

Read from source 2026-09-07. These are the load-bearing facts:

| Host fact                                                                                                                                   | What it decides here                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `terminalEnvPath` is a core preference read **per PTY spawn** straight from `tedi-settings.json` (`pty/shell_init.rs:user_extra_path_dirs`) | This is the PATH hook. One shim directory registered once, and every new terminal picks it up. |
| `path_probe.rs` already descends one level into a parent like `bin\php` to find `php-8.3.1-...`                                             | Our layout stays one level deep so the core probe reads it too.                                |
| `pty_open` takes `cols, rows, cwd, on_event` and **no env**                                                                                 | Per-project runtime CANNOT be env injection. It must be shims that resolve from CWD.           |
| `shell_bg_spawn_direct(program, args, cwd)` - also no env                                                                                   | Same. Services get absolute binary paths and generated config files, never env.                |
| `port_is_open` is a core command                                                                                                            | Port conflict detection is free. Do not write a socket prober.                                 |
| `tedi.browser` downloads with `curl` and extracts with `tar` / `unzip` / `python3 -m zipfile`                                               | No Rust sidecar. The whole download+extract layer is those two tools.                          |
| Extension data convention is `~/.tedi/<name>/`, deliberately OUTSIDE the install folder so an extension update cannot delete it             | Our root is `~/.tedi/devenv`, and it must survive updates.                                     |
| `ctx.settings` namespaces every key to `ext:<id>:<key>`                                                                                     | We cannot write `terminalEnvPath` through the sanctioned API. See section 7.                   |
| Extension package cap is 50 MiB, 10 MiB per file                                                                                            | Nothing is bundled. Every runtime is downloaded at first use.                                  |
| `ctx.invoke` is gated per command; `secrets_*` and `ext_*` are hard-denied                                                                  | The permission list in the manifest is the real capability surface.                            |

## 2. Decisions

### 2.1 No sidecar binary

`tedi.beautify`, `tedi.screenshot` and `tedi.browser` ship native sidecars, but
`tedi.browser` proves the download path needs none: `curl` for transfer, and
`tar` (bsdtar on Windows and macOS reads zip) with `unzip` and
`python3 -m zipfile` as Linux fallbacks. A sidecar would mean six build targets
and a release-zip size problem for zero capability gained. **Decision: pure JS,
no sidecar.**

### 2.2 Everything is a provider

No version, URL, or path is hardcoded. A **provider** describes one managed
thing and answers three questions:

```js
{
  id: "php",
  kind: "runtime" | "server" | "service" | "tool",
  async versions(plat)   // -> [{ version, channel }]   dynamic, cached
  async resolve(v, plat) // -> { url, format, strip, probe } | null
  layout(v, plat)        // -> { binDir, exe, extras }
  sources                // download | system | package-manager, in order
}
```

`resolve()` returning `null` is a first-class answer meaning "this platform has
no prebuilt build", and the UI then offers the `system` or `package-manager`
source instead of downloading something that cannot work. This is what keeps the
extension honest on macOS and Linux, where **most of these projects publish no
official binary at all**.

### 2.3 Version sources, per component

| Component  | Version list (dynamic)                     | Windows binary                  | macOS / Linux binary                              |
| ---------- | ------------------------------------------ | ------------------------------- | ------------------------------------------------- |
| PHP        | `php.net/releases/index.php?json=1&max=-1` | windows.php.net (official)      | static-php-cli (`dl.static-php.dev`), else system |
| PHP ext    | `windows.php.net/downloads/pecl/releases/` | official PECL DLL matrix        | `pecl` if a toolchain exists, else n/a            |
| Node.js    | `nodejs.org/dist/index.json`               | official                        | official                                          |
| Composer   | `getcomposer.org/versions`                 | phar (platform-independent)     | phar                                              |
| PostgreSQL | `postgresql.org/versions.json`             | EDB binaries zip                | EDB binaries tar.gz                               |
| MariaDB    | `downloads.mariadb.org/rest-api/mariadb/`  | official zip                    | official tar.gz                                   |
| MySQL      | template + probe                           | official zip                    | official tar.xz / tar.gz                          |
| Redis      | GitHub releases API                        | `redis-windows` community build | system, else source build if `make`               |
| Nginx      | `nginx.org/download/` index                | official zip                    | system / package manager                          |
| Apache     | Apache Lounge                              | Apache Lounge zip               | system / package manager                          |
| mkcert     | GitHub releases API                        | official                        | official                                          |

Everything in column 2 is fetched at runtime and cached with a TTL. Nothing in
this table is compiled into the bundle except the shape of the URL template.

### 2.4 Web server: Nginx (default) and Apache

Chosen by the owner over a single-binary server. Consequences accepted:

- **We own certificates.** No server-managed local CA, so `mkcert` is downloaded
  as a tool (single Go binary, all platforms, installs into the OS and NSS trust
  stores). `openssl` is the fallback when mkcert has no build.
- **We own the PHP process.** Windows PHP has no FPM, so PHP is served with
  `php-cgi` behind a small process pool we supervise. macOS and Linux use
  `php-fpm` when the build has it. The vhost generator emits whichever the
  active runtime actually supports, probed at activation, never assumed.
- **Both are installed, and both can run.** The chosen one keeps the configured
  ports, because those are the numbers in the user's URLs and in their
  bookmarks; the other takes a fixed `+8000` offset, which is deterministic
  because the number is written into the generated `listen` line and has to be
  the same one next time. Each writes its own `conf/<server>/` tree, so starting
  the other never means serving a configuration from three project changes ago.
- **Where each server keeps its OWN files is asked, not derived.** `nginx -V`
  states its conf path and `httpd -V` states `HTTPD_ROOT`; the answer is then
  confirmed by looking for a file that must be there, with a candidate list
  behind it. Deriving it from the install directory is only correct for a
  managed download - for a system install that directory is where the BINARY
  sits, which is how `include "/usr/sbin/conf/mime.types"` got written on the
  two platforms where a system install is the only option. Apache's
  `LoadModule` list is read off the modules directory for the same reason: the
  Windows build ships no MPM and no unixd module, and naming either aborts
  startup.

### 2.5 Local domains: hosts file, batched elevation

Real local DNS needs port 53 plus a system resolver change, which on Windows
means editing adapter DNS and on Linux differs per distro. The hosts file
behaves identically everywhere. The user never edits it:
the extension computes the desired block, diffs it against the current file, and
applies **all** changes under a single elevation prompt.

The managed region is delimited so we never touch a line we did not write:

```
# >>> tedi.devenv >>>
127.0.0.1  project-a.test
# <<< tedi.devenv <<<
```

Elevation per platform: `Start-Process -Verb RunAs` (Windows),
`osascript ... with administrator privileges` (macOS), `pkexec` then `sudo` in a
visible TEDI terminal (Linux).

### 2.6 Project runtime: shims resolving from CWD

`pty_open` accepts no env, so the only way a terminal gets the project's PHP is a
shim on PATH that resolves at exec time.

```
<root>/shims/php.cmd   (Windows)      <root>/shims/php   (POSIX, 0755)
```

Each shim walks up from CWD for `.tedi-runtime`, a flat `KEY=VALUE` file the
extension generates from project config. Flat text, not JSON, because a Windows
`.cmd` can parse it without starting an interpreter, which keeps shim overhead
near zero. Absent that file, the shim falls back to `<root>/global.env`.

Resolution order for a project, highest first:

1. `.tedi-devenv.json` in the project (explicit `php` / `node` pins)
2. `.nvmrc` or `.node-version` (Node only, respected because it already exists)
3. `composer.json` -> `config.platform.php` (PHP only)
4. global default from `config.json`

Hot reload is then trivial: rewriting `.tedi-runtime` changes what the next
command resolves to, with no restart of TEDI, the daemon, or the terminal.

### 2.7 Storage layout

Root defaults to `~/.tedi/devenv` and is a setting, never a constant.

```
<root>/
  www/                 projects, the folder you actually open
  runtimes/php/<ver>/  runtimes/node/<ver>/ runtimes/composer/<ver>/
  servers/nginx/<ver>/ servers/apache/<ver>/
  services/mysql/<ver>/ services/postgres/<ver>/ services/redis/<ver>/
  data/mysql/<ver>/    data/postgres/<ver>/ data/redis/
  logs/                per-service and per-site logs
  config.json          global config (defaults, terminal-PATH decision)
  projects.json        project registry
  cron.json            scheduled jobs
  internal/            everything generated; nothing here is yours to edit
    shims/             generated, and what goes on the terminal PATH
    global.env         shim fallback - beside the shims, because both read
                       it as `<self>/../global.env`
    certs/             rootCA + issued leaf certs
    conf/              generated nginx/apache/php configs
    tools/             composer.phar, mkcert
    cache/             provider metadata, TTL'd
    downloads/         in-flight archives
    run/               pidfiles, elevation scripts
    temp/              nginx's scratch space
```

One level deep under each component so the core `path_probe` subdirectory
expansion also resolves it.

The split is by WHO OPENS IT, not by what the code calls it. The root had
fifteen entries and nine of them were plumbing, so the four things a person has
a reason to look for - their projects, their databases, the logs, and which
runtimes are installed - were outnumbered two to one by folders that exist for
our benefit. `manager/migrate.js` moves an older environment into this shape
once, on activation, and re-registers the terminal PATH because the shim
directory's old path is on it and would otherwise silently point at nothing.

### 2.8 Scheduled jobs

A scheduler of our own rather than the system's, for three reasons that all
point the same way: the system's cron has the wrong PATH for a per-project
runtime, it runs whether or not you are working, and on Windows it does not
exist. It runs exactly while the extension does, which is the honest scope of a
development scheduler.

Three decisions carry it. A job is **argv**, not a shell line, so there is no
quoting layer between what the user typed and what runs. A shimmed tool is run
**through the shim**, so a job's `php` resolves from its own working directory
exactly as a terminal's would and no second copy of that logic lives in the
scheduler. And the schedule is a **real cron expression**, including the rule
that makes cron cron: when both day fields are restricted, either one matching
is a match.

## 3. Module map

Every file stays under ~300 lines, fleet convention. As built, which is not
quite as planned: `core/log.js` folded into `runtime.js`, `registry/pecl.js`
became `manager/phpext.js` because it manages state rather than describing a
download, `manager/runtimes.js` and `project/envfile.js` never needed to exist,
and six modules turned up that the plan did not foresee.

```
src/
  index.js            activate/deactivate, wiring only
  runtime.js          ctx + state singletons and setters (the ONE owner)
  core/               paths.js fsx.js proc.js net.js archive.js elevate.js
  registry/           index.js util.js php.js node.js composer.js db.js
                      redis.js servers.js mkcert.js
  manager/            install.js versions.js config.js defaults.js apply.js
                      services.js cron.js migrate.js
                      phpini.js phpext.js xdebug.js packagers.js
  project/            projects.js resolve.js shims.js
  web/                vhost.js serverroot.js hosts.js certs.js ports.js
                      publish.js
  ui/                 dashboard.js setup.js install-all.js el.js marks.js
                      runtimes-view.js services-view.js projects-view.js
                      cron-view.js php-view.js php-ext-view.js
                      packagers-view.js
```

`registry/util.js` exists because `registry/index.js` imports all nine providers
while each of them wanted a helper back; `manager/apply.js` because a runtime
change has three consequences and no call site should be able to do two of them;
`web/serverroot.js` because where a web server keeps its own files has to be
asked, not derived; `web/publish.js` because a vhost with no hosts entry and a
hosts entry with no vhost are each half a feature.

Dependency direction is strictly downward: `ui -> manager/project/web -> registry
-> core -> runtime`. Nothing in `core` imports upward, which is what keeps the
whole thing testable without a webview.

## 4. Permissions requested, and why each is unavoidable

| Permission                              | Why                                                   |
| --------------------------------------- | ----------------------------------------------------- |
| `invoke:shell_bg_spawn_direct`          | everything: curl, tar, version probes, and the         |
|                                         | long-running services (nginx, mysql, php-cgi)          |
| `invoke:shell_bg_logs/kill/list/remove` | reading that output back, and service supervision      |
| `invoke:fs_*`                           | layout, config generation, reading archives back       |
| `invoke:port_is_open`                   | port conflict detection (core already has it)          |
| `terminal:path`                         | putting the shim directory first on the terminal PATH  |
| `panels:register`, `tabs:open`          | the dashboard pane                                     |
| `statusbar:write`                       | service status readout                                 |
| `settings:read`, `settings:write`       | our own namespaced settings                            |
| `ui:toast`                              | progress and failures                                  |

`invoke:shell_run_command` was declared too, for an `sh()` in `core/proc.js`
kept "for the cases that genuinely need shell features". No such case ever
arrived - downloads, extractions, version probes, elevation helpers and
scheduled jobs all pass argv - so both are gone. It is one of the host's
HIGH-risk permissions (it runs an arbitrary command through the user's login
shell), and an unused capability is still a granted one.

No `secrets:*`: database root passwords for a LOCAL dev environment are written
into generated config the user can read anyway, so asking for keychain access
would buy a HIGH risk badge and no real protection.

## 5. Known limits, stated up front

1. **macOS and Linux have no official binaries for most of this.** PHP, Redis,
   Nginx and Apache all ship Windows builds or nothing. The provider model
   handles it by degrading to a detected system install or naming the exact
   package-manager command, but full download-and-manage parity is a Windows
   property, not a cross-platform one. Pretending otherwise would be the
   dishonest version of this extension.
2. **PHP extension management on downloaded macOS/Linux PHP is not possible.**
   static-php-cli binaries are static: extensions are compiled in. Enable/disable
   works on Windows (php.ini + DLL) and on a system PHP with a toolchain.
3. **Elevation cannot be avoided** for the hosts file and for binding 80/443.
   It is batched to one prompt per apply, never one per project.
4. Nothing here is runtime-verified on macOS or Linux from this machine. Every
   platform arm is written from documented behaviour and must be smoke-tested on
   real hardware before release. Two consequences of that have already been
   found and fixed - a config built from `/usr/sbin` because that is where a
   system binary sits, and a PHP layout that assumed a `bin/` the static build
   does not have - and both were invisible from Windows. `npm run test:live`
   now installs both web servers and hands each its own generated config to
   validate, which is the check that catches the next one; run it on the target
   platform, not only here.
5. **The terminal PATH is optional, and so is the whole shim mechanism.** A user
   who declines it keeps their own `php` in terminals and gets the managed one
   everywhere else. That is the honest trade: `pty_open` takes no env, so there
   is no way to scope the change to TEDI's terminals without also taking over
   what `php` means in them.

## 6. Build order

1. `core/` - paths, fs, proc, net, archive, elevation
2. `registry/` - provider metadata
3. `manager/install.js` + `versions.js` - the lifecycle
4. runtimes (PHP, Node) + `project/` + shims + terminal integration
5. services (MySQL, PostgreSQL, Redis)
6. `web/` - ports, certs, hosts, vhost, servers
7. `ui/` - dashboard
8. wire-up, `tedi ext validate`, review

## 7. The host constraint that was resolved

`ctx.settings` namespaces every key, so the extension could not add its shim
directory to the core `terminalEnvPath` preference through the sanctioned API.
Three ways out were identified, in preference order:

1. **Ask the user once.** A one-click card that copies the path and opens
   Settings. Honest, no gate bypass, costs one manual step at setup.
2. Write `tedi-settings.json` directly through a raw `@tauri-apps/api` import,
   which extensions can do because the gate only covers `ctx.invoke`. Works, but
   it is exactly the bypass the trust model warns about.
3. Propose a core change: let `pty_open` accept env, or expose a narrow
   `settings_add_path` command.

**Option 3 shipped in the host.** `ctx.terminal` behind the `terminal:path`
permission adds this extension's own folder, switches off entries that would
shadow it, and undoes exactly that; the Settings row names the extension that
did it and offers a switch back. `ui/setup.js` uses it, and keeps the file READ
of option 1 as a fallback for a host that predates the API - only ever a read.
Option 2 remains available and remains deliberately not taken.

Which leaves one open question rather than a constraint: registering the PATH is
now optional (see §5.5), so a user who declines it gets managed runtimes
everywhere except the terminal. There is no way to give a single TEDI terminal
the project's runtime without the shim directory, because `pty_open` still takes
no env.
