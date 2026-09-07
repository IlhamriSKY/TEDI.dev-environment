# Changelog

## 0.1.0

First release. A complete local development environment managed from inside
TEDI, on Windows, macOS and Linux.

- **It brings its own runtimes.** PHP, Node.js, Composer, mkcert, Nginx, Apache,
  MySQL, PostgreSQL and Redis are downloaded and managed under one root folder
  you pick, the way Laragon keeps everything in one place. Nothing is shared
  with an existing Laragon, XAMPP or Homebrew install unless you point it at
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
