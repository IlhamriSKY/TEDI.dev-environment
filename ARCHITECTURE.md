# tedi.devenv - Architecture and Technical Plan

A complete local development environment manager for TEDI: the Laragon
replacement, native to TEDI, cross-platform, and fully data-driven.

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

### 2.5 Local domains: hosts file, batched elevation

Real local DNS needs port 53 plus a system resolver change, which on Windows
means editing adapter DNS and on Linux differs per distro. The hosts file
behaves identically everywhere and is what Laragon does. The user never edits it:
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
  config.json          global config (suffix, ports, defaults, web server)
  projects.json        project registry
  global.env           shim fallback
  cache/               provider metadata, TTL'd
  downloads/           in-flight archives
  runtimes/php/<ver>/  runtimes/node/<ver>/
  servers/nginx/<ver>/ servers/apache/<ver>/
  services/mysql/<ver>/ services/postgres/<ver>/ services/redis/<ver>/
  data/mysql/<ver>/    data/postgres/<ver>/ data/redis/
  tools/               composer.phar, mkcert
  shims/               generated
  certs/               rootCA + issued leaf certs
  conf/                generated nginx/apache/php configs
  logs/  run/          service logs and pidfiles
```

One level deep under each component so the core `path_probe` subdirectory
expansion also resolves it.

## 3. Module map

Every file stays under ~300 lines, fleet convention.

```
src/
  index.js            activate/deactivate, wiring only
  runtime.js          ctx + state singletons and setters (the ONE owner)
  core/               paths.js fsx.js proc.js net.js archive.js elevate.js log.js
  registry/           index.js php.js node.js composer.js db.js redis.js
                      servers.js pecl.js mkcert.js
  manager/            install.js versions.js runtimes.js services.js
                      phpini.js phpext.js xdebug.js
  project/            projects.js resolve.js shims.js envfile.js
  web/                vhost.js hosts.js certs.js ports.js
  ui/                 dashboard.js runtimes-view.js services-view.js
                      projects-view.js el.js
```

Dependency direction is strictly downward: `ui -> manager/project/web -> registry
-> core -> runtime`. Nothing in `core` imports upward, which is what keeps the
whole thing testable without a webview.

## 4. Permissions requested, and why each is unavoidable

| Permission                              | Why                                              |
| --------------------------------------- | ------------------------------------------------ |
| `invoke:shell_run_command`              | curl, tar, version probes, elevation helpers     |
| `invoke:shell_bg_spawn_direct`          | long-running services (nginx, mysql, php-cgi)    |
| `invoke:shell_bg_logs/kill/list/remove` | service supervision                              |
| `invoke:fs_*`                           | layout, config generation, reading archives back |
| `invoke:port_is_open`                   | port conflict detection (core already has it)    |
| `panels:register`, `tabs:open`          | the dashboard pane                               |
| `statusbar:write`                       | service status readout                           |
| `settings:read`, `settings:write`       | our own namespaced settings                      |
| `ui:toast`                              | progress and failures                            |

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
   real hardware before release.

## 6. Build order

1. `core/` - paths, fs, proc, net, archive, elevation
2. `registry/` - provider metadata
3. `manager/install.js` + `versions.js` - the lifecycle
4. runtimes (PHP, Node) + `project/` + shims + terminal integration
5. services (MySQL, PostgreSQL, Redis)
6. `web/` - ports, certs, hosts, vhost, servers
7. `ui/` - dashboard
8. wire-up, `tedi ext validate`, review

## 7. The one unresolved host constraint

`ctx.settings` namespaces every key, so the extension cannot add its shim
directory to the core `terminalEnvPath` preference through the sanctioned API.
Three ways out, in preference order:

1. **Ask the user once.** The dashboard shows a one-click "Add shims to terminal
   PATH" card that copies the path and opens Settings. Honest, no gate bypass,
   costs one manual step at setup.
2. Write `tedi-settings.json` directly through a raw `@tauri-apps/api` import,
   which extensions can do because the gate only covers `ctx.invoke`. Works, but
   it is exactly the bypass the trust model warns about.
3. Propose a core change: let `pty_open` accept env, or expose a narrow
   `settings_add_path` command.

**Shipping with 1, documenting 3.** Option 2 is available and deliberately not
taken.
