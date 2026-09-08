# Changelog

## 0.1.2

- **Scheduled jobs.** A **Cron** section, and a scheduler that runs while the
  environment does. Real five-field expressions plus `@daily` and friends, and
  `php`, `node`, `npm` and `composer` in a job resolve to the version its folder
  asks for — so `php artisan schedule:run` in a project pinned to 8.3 runs 8.3,
  through the same shim a terminal opened there would use. Each row shows what
  the last run did, and **Run now** tests a schedule without waiting for it. A
  job is an argument list rather than a shell line, so a path with a space in it
  cannot split in two.

- **The root folder has ten entries, not fifteen.** The shims, the certificates,
  the generated server config, the metadata cache, the download staging area,
  the pidfiles, the single-file tools, nginx's scratch space and `global.env` now
  live under `internal/`. What is left at the top is what someone actually opens:
  `www/`, `data/`, `logs/`, the three install trees, and the three JSON files. An
  existing environment is moved into the new shape once, on the next launch,
  including the terminal PATH entry that pointed at the old shim directory —
  which is the one thing that would have failed silently and completely.

- **One fewer permission, and it was a high-risk one.**
  `invoke:shell_run_command` grants running an arbitrary command through your
  login shell. It was declared for a helper nothing ever called, so both the
  helper and the permission are gone. Everything here passes an argument vector,
  which is why the quoting bugs this class of code usually has do not exist.

- **A state is a glyph now, not a coloured square.** A 6px fill carries its whole
  meaning in its colour, which is a quiz at that size and is nothing at all to
  anyone who cannot separate the greens from the reds. Running is a tick,
  starting is a spinner breathing on the app's own `ai-breathe` pulse, failed is
  an alert, stopped is an outline. The colour still agrees with the shape; it is
  just no longer the only thing carrying it.

- **Faster to start, and quieter while open.** Scanning what is installed now
  asks the nine components at once instead of one after another - the same work,
  measured at roughly 2.0s down to 0.8s against a real environment. The Projects
  list was reading every project's `.nvmrc` and `composer.json` twice per
  repaint, issuing a certificate spawned a `mkcert` process per project per web
  server to fill in a field nothing read, and the setup checklist re-asked
  whether the local CA was trusted on every repaint. None of those happen now.

## 0.1.1

Apache never installed, downloaded PHP was invisible on two platforms out of
three, and the terminal PATH could not be declined. All three are fixed, and
each one now has a check that would have caught it.

- **Apache installs, and starts.** Three separate faults stood between the
  button and a running server, and none of them failed loudly. The download page
  spells its archive `Win64` and the pattern matched a lowercase `win64`, so the
  index came back EMPTY - which reads exactly like "this platform has no build",
  the honest answer on macOS and Linux, so Apache quietly reported itself
  unavailable. The archive puts its payload in `Apache24/` next to three loose
  files, and the unwrapper only lifted a directory that was alone, so the binary
  landed one level below where everything looked for it. And the generated
  config named `mod_mpm_event` and `mod_unixd`, neither of which the Windows
  build ships, so the server aborted on the first `LoadModule`. Now: the index
  is read case-insensitively, the wrapper is identified by which directory holds
  the executable, and every `LoadModule` line is written from the modules that
  are actually on disk.

- **Both web servers can run at once.** Nginx and Apache are both installed and
  both listed. The default keeps the ports you configured, because those are the
  numbers in your URLs; the other one takes a fixed offset, so 80 and 443 become
  8080 and 8443. Each writes its own virtual hosts, so starting the other one
  never serves a configuration from three project changes ago, and trying one
  does not mean stopping the other.

- **The servers work off Windows.** Both used to be handed a config built from
  the directory their BINARY sits in, which for a system install is `/usr/sbin` -
  so `include "/usr/sbin/conf/mime.types"` and `ServerRoot "/usr/sbin"`, neither
  of which exists, on the two platforms where a system install is the only
  option. The locations are now asked of the server itself (`nginx -V` states
  its conf path, `httpd -V` states `HTTPD_ROOT`) and confirmed by looking for the
  file, with a candidate list behind that. Debian's `apache2` binary is found by
  name rather than assumed to be `httpd`.

- **Downloaded PHP appears on macOS and Linux.** The static build is a single
  bare binary and `layout()` looked for it in a `bin/` subdirectory that no step
  ever created, so it installed and then never showed up as installed.

- **Progress is a bar, not a sentence.** Downloads draw a bar under the row doing
  the work, with the component and the position in the batch beside it. A step
  with no measurable length - unpacking, verifying - sweeps rather than sitting
  at a confident 0%. Repainting is throttled, so nine components at a hundred
  percentage points each is no longer nine hundred full redraws.

- **The terminal PATH step can be declined.** It never gated the panel usefully:
  if you already have a PHP on your PATH with something running against it,
  switching it off is not a step, it is a decision. **Not now** records that and
  stops asking; the row stays, so registering later is still one button. Only the
  root folder and the install gate the panel now.

- **Quitting TEDI stops the servers properly.** Teardown cleared its own "still
  active" latch before stopping anything, and that latch is what makes a running
  command abort - so the graceful `nginx -s stop` was killed before it could
  signal the master, and the workers kept holding port 80 into the next launch.
  Stopping also waits for the port to go quiet rather than sleeping a fixed
  300ms, which is what made Restart fail with a bind error on a slow machine.

- Smaller: a failed elevation on Linux no longer deletes the script whose path
  the error message tells you to run; `initdb` no longer leaves a plaintext
  password file that nothing read; `nginx`, `httpd`, `mysqld` and `postgres` are
  asked their version with the flag they actually accept, instead of every
  install of them warning "installed but did not answer".

## 0.1.0

First release. A complete local development environment managed from inside
TEDI, on Windows, macOS and Linux.

- **It brings its own runtimes.** PHP, Node.js, Composer, mkcert, Nginx, Apache,
  MySQL, PostgreSQL and Redis are downloaded and managed under one root folder
  you pick, so the root is the whole environment. Nothing is shared with a stack
  you already have installed unless you point it at
  one. "Install everything" takes each project's own newest stable release,
  never a version written into this extension, and it installs whatever the
  current platform actually has a build for - reporting the rest as
  "no build on this platform" rather than as a failure, because that is a fact
  about the upstream project and not something that went wrong.

- **Multi-version, resolved per project.** A `shims/` folder goes first on
  TEDI's terminal PATH, and each shim walks up from the working directory
  looking for a `.tedi-runtime` file. So `php` in one project is 8.4 and 8.5 in
  the next, with no switching, and `.nvmrc`, `.node-version` and a
  composer.json platform constraint are all read as the project's request.

- **A project is a working site.** Adding one writes its virtual host, issues
  its certificate and syncs the hosts file, so `https://<name>.test` answers as
  soon as the web server is up. No "apply" step to know about.

- **PHP configuration per version.** php.ini directives, the extension list with
  compatibility filtered to the exact branch, thread-safety and architecture
  that PHP would load, Xdebug with its mode picker, and the whole php.ini in the
  app's own editor with find and replace.

- **It sets itself up, and refuses to pretend otherwise.** The panel shows a
  three-step checklist and nothing else until a root folder exists, the
  components are installed and the shims are registered on the terminal PATH -
  each of them one click, none of them able to strand you.
