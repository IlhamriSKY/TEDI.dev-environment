# Dev Environment for TEDI

A complete local development environment, managed from inside TEDI, on Windows,
macOS and Linux.

It downloads and manages its own PHP, Node.js, MySQL, PostgreSQL, Redis, Nginx,
Apache, Composer and mkcert. Nothing is shared with a stack you already have
installed unless you ask it to use one.

```
tedi ext install IlhamriSKY/tedi.dev-environment
```

Then open the pane with **Ctrl/Cmd + Alt + E**.

## What it does

- **Several PHP and Node versions at once.** Install as many as you like, pick a
  global default, and let any project override it.
- **Per-project runtimes that follow you into the terminal.** Open a terminal in
  a project and `php`, `composer`, `node` and `npm` resolve to that project's
  versions. No `nvm use`, no restart.
- **Virtual hosts with HTTPS.** Every project gets `name.test` (or whatever
  suffix you choose), a generated vhost, a certificate from a local CA, and a
  hosts entry written for you.
- **New project makes the folder.** Type a name and you get `www/<name>`, its
  virtual host, its certificate and its hosts entry, live before you have opened
  an editor. Already have the folder? Drop it in `www` and press **Refresh** -
  every folder in there is a site, empty ones included, because an empty
  checkout is exactly when having the domain already issued is worth something.
- **A terminal in any project, from its row.** TEDI's own terminal, opened in
  that folder, so `php`, `node`, `npm` and `composer` in it are that project's
  versions. Needs TEDI 0.4.47 or newer; on an older one the button is simply
  not there.
- **Nginx and Apache, one at a time.** Both get installed, and the tick on the
  row picks which one your project URLs point at. Starting either stops the
  other, so there is only ever one server on the ports you configured and one
  set of rules answering. Each keeps its own virtual hosts, so switching is a
  click.
- **Every service can install another version**, from its own row: the same
  dropdown-and-Install pair the runtimes have. Nginx, Apache, MySQL, PostgreSQL
  and Redis are versioned downloads like PHP and Node.
- **Every port is editable, and HTTPS can be switched off**, behind the gear on
  the service's own row. The row keeps the port as a fact, because the number is
  worth a glance even when you are not changing it. A web server has two, and
  the HTTPS switch turns the second off entirely - no certificates issued, no
  SSL block in the vhosts - for the plenty of local work that never touches it.
  A port you type is never moved out from under you: if something else has it,
  the row says so rather than quietly landing on the next one along.
- **Start all starts what you tick.** Two databases run side by side happily,
  and most people want one, so each service row carries a tick that decides
  whether **Start all** includes it. Its own Start button always works either
  way. Cron is the one that starts off: it fires jobs, and a scheduler that
  comes up because you pressed Start all is the one that surprises you.
- **Databases as services.** MySQL, PostgreSQL and Redis start, stop and
  initialise their data directories from the dashboard.
- **A port conflict names the culprit.** "Port 80 is already in use" tells you
  nothing you can act on, so the row says which process holds it and offers to
  stop it - behind a confirmation naming exactly what is about to end. Stopping
  it frees the port and does nothing else; starting the service is still yours
  to press.
- **The status-bar icon is lit while anything is running**, and its tooltip
  names what.
- **Services survive a crash of the app.** Anything still running is taken back
  over at launch instead of being reported as stopped, so you do not start it
  twice. Only on proof: the process holding the port has to be running the exact
  binary this environment would have launched.
- **The databases show up in SQL Explorer by themselves.** Install MySQL or
  PostgreSQL here and, if you have the
  [SQL Explorer](https://github.com/IlhamriSKY/tedi.sql-explorer) extension,
  they appear in its Databases list with the right host, port and user already
  filled in. Change a port and the saved connection follows it; remove the
  database and the connection goes with it. Nothing to configure on either side,
  and nothing happens if you do not have that extension.
- **PHP extensions and Xdebug** on Windows, with compatibility filtering: only
  builds matching your PHP's branch, thread-safety and architecture are offered.
- **Nothing is removed without asking.** Every Remove here - a version, a
  project, a scheduled job - says what actually goes before it goes.
- **Everything is set in the pane.** There is no card in TEDI's Settings to go
  and find: the root folder is the first setup step, the web server is **Use
  this** on its own row, the ports are the fields beside it, and the domain
  suffix and the hosts-file switch are behind **Settings** in the top right.
  Each decision sits next to the thing it changes, which is also the only place
  that can tell you whether the port is currently bound.

## Setting it up

The pane shows a three-step checklist and **nothing else** until all three are
done. Each is one click, and none of them can strand you.

1. **Root folder.** Pick one folder — `D:\tedi`, say — and the runtimes, your
   projects (`www/`), the databases, certificates and logs all live under it, so
   the root is the whole environment and there is one path to back up or move. A
   native folder picker, not a typed path.
2. **Install everything.** Downloads the current stable release of every
   component this platform has a build for, and trusts the local certificate
   authority so `https://` loads without a warning. Anything with no build here
   is reported as such rather than retried.
3. **Terminal PATH.** _Optional._ Registers the shims folder first on TEDI's
   terminal PATH, which is what makes `php`, `node`, `npm` and `composer`
   resolve to the project's versions instead of whatever else your system finds
   first. Any folder holding a competing one is switched **off**, not deleted —
   you can turn it back on in _Settings → Terminal → Additional PATH_, where the
   row says which extension added or disabled it.

   Press **Not now** if something on this machine is already running against
   your own PHP or Node. Everything else here works either way; only terminals are
   affected. The row stays on the checklist, so you can register it whenever you
   want.

Only the first two steps gate the panel.

Everything after that is automatic. Adding a project writes its virtual host,
issues its certificate and syncs the hosts file — under a single administrator
prompt, into a delimited block that never touches anything outside it — so
`https://<name>.test` answers as soon as the web server is up. There is no
"apply" step to know about.

## How a project picks its runtime

Highest wins:

1. What you set on the project in TEDI
2. `.nvmrc` or `.node-version` (Node)
3. `composer.json` → `config.platform.php`, else the `require.php` floor (PHP)
4. The global default

The decision is written to `.tedi-runtime` in the project folder, which is what
the shims read. Add it to your `.gitignore`.

## Scheduled jobs

A cron of your own, behind **Jobs** on the Cron row in Services. It runs while
the environment does,
which is the point: a development scheduler that fires when you are not working
is a scheduler that surprises you.

```
* * * * *     php artisan schedule:run      in D:\DEV ENV\www\my-app
*/5 * * * *   php artisan queue:work --stop-when-empty
0 3 * * *     npm run backup
```

Real five-field cron expressions, plus `@daily`, `@hourly`, `@weekly` and
`@monthly`. `php`, `node`, `npm` and `composer` in a job resolve to the version
its **folder** asks for, exactly as a terminal opened there would, so a job in a
project pinned to PHP 8.3 runs 8.3.

Each row shows what the last run did — exit code, when, and the tail of the
output when it failed — and **Run now** runs it immediately so you can test a
schedule without waiting for it.

The command is an argument list, not a shell line: a path with a space in it
cannot split in two, and a pipe or a redirect belongs in a script the job calls.

## Where things live

Under the root folder you picked in step 1, and nowhere else:

```
<root>/www/         your projects           <root>/data/      the databases
<root>/runtimes/    php, node, composer     <root>/logs/      what each service wrote
<root>/servers/     nginx, apache           <root>/internal/  everything generated
<root>/services/    mysql, postgres, redis
```

`internal/` holds the shims, the certificates, the generated server config, the
metadata cache and the download staging area. Nothing in it is yours to edit and
all of it is rebuilt, which is why it is one folder instead of eight at the top
level. An environment created before this release is moved into the new shape
once, on the next launch, and the terminal PATH entry moves with it.

One file is written outside it: `~/.tedi/dev-environment.json`, which is how
SQL Explorer finds the databases above. It holds a host, a port and a user, no
password, and is deleted when the last database is.

Nothing is installed into the system, so moving or deleting that one folder is
the whole uninstall. The two exceptions are stated where they happen and both
ask for permission: the hosts-file block, and the local CA in your machine's
trust store.

## Platform reality

Windows has official binary builds for nearly all of this, and the other two
platforms mostly do not. Where a project publishes no build, the extension says
so and offers your system install or the exact package-manager command instead
of downloading something that cannot work.

| Component  | Windows         | macOS            | Linux            |
| ---------- | --------------- | ---------------- | ---------------- |
| PHP        | official        | static-php-cli   | static-php-cli   |
| Node.js    | official        | official         | official         |
| Composer   | official        | official         | official         |
| Nginx      | official        | system / package | system / package |
| Apache     | Apache Lounge   | system / package | system / package |
| MySQL      | official        | system / package | official (x64)   |
| PostgreSQL | EDB binaries    | EDB binaries     | system / package |
| Redis      | community build | system / package | system / package |
| mkcert     | official        | official         | official         |

PHP extension management needs a runtime that can load one at run time, so it
works on Windows and on a detected system PHP. A downloaded static build on
macOS or Linux has its extensions compiled in; php.ini settings still apply.

## Development

```
npm install
npm run watch      # src/ -> extension.js
npm test           # self-checks, including running the generated shims
npm run test:live  # installs Composer and Node for real; needs network
npm run typecheck
tedi ext validate  # pre-publish check
```

Design decisions and the host constraints behind them are in
[ARCHITECTURE.md](ARCHITECTURE.md).
