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
- **Nginx and Apache, side by side.** Both get installed. The one you pick in
  Settings keeps the ports you configured, because those are the numbers in your
  URLs; the other takes a fixed offset — 80 and 443 become 8080 and 8443 — so
  both can run and trying one never means stopping the other. Each writes its
  own virtual hosts.
- **Databases as services.** MySQL, PostgreSQL and Redis start, stop and
  initialise their data directories from the dashboard.
- **PHP extensions and Xdebug** on Windows, with compatibility filtering: only
  builds matching your PHP's branch, thread-safety and architecture are offered.

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
   terminal PATH, which is what makes `php` resolve to the project's version
   instead of whatever else your system finds first. Any folder holding a
   competing `php`, `node` or `composer` is switched **off**, not deleted — you
   can turn it back on in _Settings → Terminal → Additional PATH_, where the row
   says which extension added or disabled it.

   Press **Not now** if you have your own PHP on the PATH with something running
   against it. Everything else here works either way; only terminals are
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

A cron of your own, in the **Cron** section. It runs while the environment does,
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
