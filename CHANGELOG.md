# Changelog

## 0.1.10

- **Every setting is in the pane; the Settings card is gone.** It held seven
  fields, four of which the pane already decided beside the thing they change -
  the root folder is the first setup step, the web server is **Use this** on its
  own row, the two ports and the HTTPS tick are the fields next to it. That made
  it a second place to look for one decision, and the one that cannot tell you
  whether the port is currently bound. The remaining two, the domain suffix and
  whether the hosts file is written, are a short **Settings** section at the
  bottom of the pane. Every key and default is unchanged, so an environment
  configured through the old card keeps its values.

- **The Install spinner is a spinner.** It blinked, for two reasons that both
  had to go: the panel repaints on a four-second poll and each repaint built a
  new icon, so the rotation restarted from zero every time, and a version list
  that is already cached answers in a few tens of milliseconds, so on the second
  press the whole thing appeared and vanished inside a frame. The animation is
  anchored to the clock rather than to when the node was built, and the picker
  holds it for one full turn.

## 0.1.9

- **The databases turn up in SQL Explorer by themselves.** Install MySQL or
  PostgreSQL here and, with the SQL Explorer extension present, they appear in
  its Databases list with the right host, port and user already filled in.
  Change a port and the saved connection follows it; remove the database and
  the connection goes with it. Nothing to configure on either side, and nothing
  happens if that extension is not installed.

  The handoff is a file, `~/.tedi/dev-environment.json`, because the host
  deliberately gives two extensions no way to reach each other: settings, events
  and secrets are all namespaced under the id of whoever is calling, and
  `openExtensionTab` hard-wires the caller's own id. Reaching around that into
  the app's settings file would work today and break later. The file states a
  fact rather than issuing a command, carries no password because there is none
  to carry, and is deleted rather than emptied when the last database goes.

- **Nothing is removed without asking.** Remove on a version, a project or a
  scheduled job now says what actually goes before it goes - the installed files
  and another download to get them back, the virtual host and certificate but
  never the folder, the schedule. All three fired on the first click, and none
  of them can be undone.

- **Release dates read day-month-year**, and picking a version no longer draws a
  progress bar to fetch the list. A sweeping bar is the shape of a download;
  that is one metadata request, so the Install icon you just pressed spins
  instead.

## 0.1.8

- **Every service can install another version, from its own row.** Nginx,
  Apache, MySQL, PostgreSQL and Redis are versioned downloads exactly like PHP
  and Node, and the only reason they could not be installed from their own row
  was that the picker lived in the Runtimes view. It is its own module now, so
  there is one modal rather than two that drift. Only the scheduler has no
  version, because it is a timer in this extension rather than a program on
  disk.

- **The web server row carries the choice and both ports.** **Use this** points
  the project URLs at Nginx or Apache and hands over if the other one is
  running, rather than leaving the URLs describing a server that is not the one
  answering. Beside it are `http` and `https` as separate fields, and the tick
  next to `https` switches it off: no certificate is issued and no SSL block is
  written, which is the honest setting for the plenty of local work that never
  touches TLS.

## 0.1.7

- **One web server at a time.** Starting Nginx stops Apache, and the other way
  round, so both take the ports you configured and only one set of rules ever
  answers a project URL. They ran side by side on a `+8000` offset for two
  releases; that was a worse answer to a question nobody asked, because the
  second server is the one you did not configure and its offset then turned up
  in a URL nobody typed.

- **Every port is editable, on the row.** A stopped service shows its port as a
  field; a running one shows it as a label, because that number is then a fact
  about a bound socket rather than a request. A web server writes `httpPort`,
  the real setting, since that number is in every project URL and there has to
  be exactly one of it. A port you type is never moved out from under you: if
  something else has it the row says so, where before a database would quietly
  land on the next port along and break the connection string that was the
  reason for choosing it. Leave it blank to go back to the convention.

- **Composer and mkcert leave the Runtimes list.** They are still installed,
  still managed, still counted. But nobody switches them - Composer is one phar
  run by whichever PHP the project resolved, and mkcert is a single binary
  managing a machine-wide CA - so a version dropdown and a Remove button were
  two controls for questions nobody asks, sitting above the two rows that
  matter.

- **Scheduled jobs move into a dialog**, opened by **Jobs** on the Cron row, the
  way php.ini opens from the PHP row. A list you go and work on is not a state
  you watch, and four columns of schedule, command and last-run were pushing the
  two things the pane exists to show off the bottom of a short pane. The row
  still says how many jobs there are and whether one is running.

- **"Apply changes" is gone, and the run controls moved to Services.** Every
  path that changes what the vhosts and the hosts file describe already
  republishes: adding, removing, enabling or disabling a project, and now
  changing a port. "Start all" and "Stop all" sit beside the rows they act on
  rather than in the pane header, where their effect was something you had to
  remember instead of see.

- The terminal PATH step no longer describes itself as being about PHP. It is
  `php`, `node`, `npm` and `composer`.

## 0.1.6

- **Package managers opens on a skeleton, and opens faster.** It surveyed npm,
  pnpm, Yarn and Bun one after another - four `--version` subprocesses in a
  row, with Bun's PATH search in front of its own - and showed nothing at all
  until the last one answered. They run together now, and the wait that is left
  is drawn as the rows it is about to become rather than as an empty dialog. A
  skeleton over something that could just be fast is decoration hiding a defect,
  so the order matters: the survey got quicker first.

- **PHP configuration does the same, and its comment stops lying.** That dialog
  had a comment claiming it drew a placeholder first; it did not, so opening it
  showed a blank box for as long as reading php.ini and running `php -m` took.
  Both placeholders are the app's own `bg-muted` + `animate-pulse`, taken from
  the `--animate-pulse` token rather than reimplemented, and both appear on the
  FIRST open only - a redraw already has an answer on screen, and replacing it
  with grey blocks reads as the dialog throwing its contents away.

## 0.1.5

- **A freshly installed PHP now has a php.ini.** It had none. The Windows zip
  ships `php.ini-development` and `php.ini-production` and no `php.ini` at all,
  and the code that seeds one from the template was only ever reached by
  CHANGING something - applying a setting, enabling an extension, wiring
  Xdebug. So after installing PHP the Configure dialog opened on an empty
  settings grid and an empty editor, and the runtime itself ran with no
  `extension_dir`, no timezone and the compiled-in defaults. Installing PHP now
  seeds it, on install and on launch, and only for a PHP this extension
  downloaded: a system PHP's ini belongs to whatever put it there. A file you
  have since edited is never rewritten.

- **The download bar is on the row doing the work, and only there.** With the
  setup checklist still on screen - which it is until you register the terminal
  PATH, or decline it - installing another PHP drew a bar on "Install
  everything" as well as on the PHP row. The same download in two places, one of
  them a step that had already finished. The checklist carries the bar only
  while it is the whole panel; once Runtimes and Services are up, each row
  carries its own. Which also gave the service rows the bar they never had, so
  an nginx or MySQL download is no longer invisible.

## 0.1.4

- **The download bar is a hairline, not a second row.** It was 12px, which is
  what `components/ui/progress.tsx` is and is right for a progress bar somebody
  is looking AT. This one runs under a compact row somebody is looking THROUGH,
  and at that height it read as another row appearing in the list. Three pixels
  is enough to see from across the pane and little enough that nothing jumps
  when a download starts.

## 0.1.3

- **The install picker can be searched, and says what each version is.** It
  listed the newest sixty and nothing else, so a version an older project pins
  could be named by its own index and still be impossible to pick. The search
  filters the whole list and the cap applies after it - Node alone publishes
  several hundred. Every row now carries what it is, as a glyph AND a word:
  **Installed** if it is already on disk, **Recommended** for what the project
  itself calls current, **LTS**, and **Stable** or **Prerelease**. That last one
  is the distinction the list could not make at all: a release candidate sorted
  below its own release and then sat there looking identical to it. Colour is
  used only where it means something - green for what you already have, amber
  for the one choice with a consequence - and the date each project states is
  beside it, because two versions a year apart is the thing a bare number cannot
  tell you.

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
