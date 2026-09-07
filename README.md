# Dev Environment for TEDI

A complete local development environment, managed from inside TEDI. The Laragon
replacement, on Windows, macOS and Linux.

It downloads and manages its own PHP, Node.js, MySQL, PostgreSQL, Redis, Nginx,
Apache, Composer and mkcert. Nothing is shared with an existing Laragon, XAMPP
or Homebrew install unless you ask it to use one.

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
- **Databases as services.** MySQL, PostgreSQL and Redis start, stop and
  initialise their data directories from the dashboard.
- **PHP extensions and Xdebug** on Windows, with compatibility filtering: only
  builds matching your PHP's branch, thread-safety and architecture are offered.

## Setting it up

The pane shows a three-step checklist and **nothing else** until all three are
done. Each is one click, and none of them can strand you.

1. **Root folder.** Pick one folder — `D:\tedi`, say — and the runtimes, your
   projects (`www/`), the databases, certificates and logs all live under it, the
   way Laragon keeps everything in one place. A native folder picker, not a typed
   path.
2. **Install everything.** Downloads the current stable release of every
   component this platform has a build for, and trusts the local certificate
   authority so `https://` loads without a warning. Anything with no build here
   is reported as such rather than retried.
3. **Terminal PATH.** Registers the shims folder first on TEDI's terminal PATH,
   which is what makes `php` resolve to the project's version instead of whatever
   else your system finds first. Any folder holding a competing `php`, `node` or
   `composer` is switched **off**, not deleted — you can turn it back on in
   _Settings → Terminal → Additional PATH_, where the row says which extension
   added or disabled it.

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

## Where things live

Under the root folder you picked in step 1, and nowhere else:

```
<root>/runtimes/   php, node, composer          <root>/www/      your projects
<root>/servers/    nginx, apache                <root>/certs/    the local CA + per-site certs
<root>/services/   mysql, postgres, redis       <root>/conf/     generated vhosts and server config
<root>/shims/      what the terminal PATH sees  <root>/logs/     what each service wrote
```

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
