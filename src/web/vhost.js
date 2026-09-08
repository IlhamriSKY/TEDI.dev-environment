// Generating web-server configuration.
//
// Both servers are driven from generated files under our own `conf/` tree and
// started with an explicit prefix, so nothing here ever edits the config that
// shipped with the download. That matters for two reasons: an upgrade replaces
// the install directory wholesale, and a user who breaks something can delete
// `conf/` and get a working setup back without reinstalling anything.
//
// PHP is reached over FastCGI in both servers rather than as a loaded module.
// That is the only arrangement that works identically on all three platforms
// and, more importantly, the only one where several PHP VERSIONS can serve at
// once: a module is loaded into the server process and there can be exactly one
// of it, while a FastCGI pool per version is just another port.
//
// Configuration is written for EVERY installed web server, not only the active
// one. Both keep their own `conf/<server>/` tree and their own ports, so having
// Apache installed alongside Nginx costs a few kilobytes of generated text and
// buys the ability to start it without first stopping the other. Which one is
// the default remains a setting; which ones exist is a fact about the install.

import { paths, join } from "../core/paths.js";
import { writeText, mkdirp, remove, readDir } from "../core/fsx.js";
import { config } from "../runtime.js";
import { domainOf, docRootOf } from "../project/projects.js";
import { resolveProject } from "../project/resolve.js";
import { resolveVersion } from "../manager/versions.js";
import { activeVersion } from "../manager/config.js";
import { certificateFor } from "./certs.js";
import { serverPorts } from "./ports.js";
import { nginxConfDir, apachePaths, loadModuleLines } from "./serverroot.js";

/** @typedef {import("../runtime.js").Project} Project */

/**
 * The FastCGI port for a PHP version.
 *
 * Derived from the version so it is STABLE across restarts: a generated vhost
 * that points at 9001 must still point at the same pool after TEDI is
 * restarted, and an allocation counter would renumber them in whatever order
 * the versions happened to be scanned.
 *
 * @param {string} version @returns {number}
 */
export function fastcgiPort(version) {
  let hash = 0;
  for (const ch of version) hash = (hash * 31 + ch.charCodeAt(0)) % 4000;
  return 9000 + hash;
}

/**
 * Configuration for every enabled project, for one server.
 *
 * @param {Project[]} projects
 * @param {"nginx" | "apache"} [server]  Defaults to the active one.
 * @returns {Promise<{ domains: string[], written: number }>}
 */
export async function generate(projects, server = config.webServer) {
  const vhostDir = paths.vhosts(server);
  await mkdirp(vhostDir);

  // Clear stale vhosts: a renamed or removed project must stop being served,
  // and leaving its file behind would keep the old domain answering.
  for (const entry of await readDir(vhostDir, true)) {
    await remove(join(vhostDir, entry.name)).catch(() => {});
  }

  // The install this config will actually be handed to, resolved the same way
  // `services.js` resolves the binary it starts. Reading `installedOf(id)[0]`
  // instead meant the newest install described the config while an older,
  // selected one ran it.
  const row = resolveVersion(server, activeVersion(server));
  const ports = serverPorts(server);

  // Asked of the server itself. See `serverroot.js` for why guessing this from
  // the install directory could not work off Windows.
  const apache = server === "apache" && row ? await apachePaths(row) : null;
  const confDir = server === "nginx" && row ? await nginxConfDir(row) : null;

  // Ours, always, so the PHP path never depends on finding nginx's own copy.
  // These parameters are fixed by the FastCGI protocol rather than by a build,
  // and writing them removes the one probe failure that would have broken PHP
  // rather than merely degraded it.
  if (server === "nginx") {
    await writeText(join(paths.conf("nginx"), "fastcgi_params"), FASTCGI_PARAMS);
  }

  /** @type {string[]} */
  const domains = [];
  let written = 0;

  for (const project of projects) {
    if (project.enabled === false) continue;
    const domain = domainOf(project);
    const root = await docRootOf(project);
    const runtime = await resolveProject(project);
    const https = project.https ?? config.autoHttps;
    const cert = https ? await certificateFor([domain, `www.${domain}`]) : null;

    const body =
      server === "nginx"
        ? nginxVhost({ project, domain, root, runtime, cert, server, ports })
        : apacheVhost({
            project,
            domain,
            root,
            runtime,
            // Apache aborts on `SSLEngine` when mod_ssl is not loadable, so a
            // build without it serves plain HTTP rather than refusing to start.
            cert: apache?.modules.has("mod_ssl.so") ? cert : null,
            server,
            ports,
          });

    await writeText(join(vhostDir, `${domain}.conf`), body);
    domains.push(domain);
    written++;
  }

  if (server === "nginx") {
    await writeText(join(paths.conf("nginx"), "nginx.conf"), nginxMain(confDir, ports));
  } else if (apache) {
    await writeText(join(paths.conf("apache"), "httpd.conf"), apacheMain(apache, ports));
  }

  return { domains, written };
}

/**
 * @typedef {object} VhostInput
 * @property {Project} project
 * @property {string} domain
 * @property {string} root
 * @property {import("../project/resolve.js").ResolvedRuntime} runtime
 * @property {import("./certs.js").CertPair | null} cert
 * @property {"nginx" | "apache"} server
 * @property {{ http: number, https: number }} ports
 */

/** Forward slashes: both servers accept them on Windows and neither accepts an
 *  unescaped backslash inside a quoted path.
 *  @param {string} p @returns {string} */
function conf(p) {
  return String(p).replace(/\\/g, "/");
}

/** Log paths are per SERVER as well as per domain, because both can be running
 *  and two processes appending to one access log interleaves them.
 *  @param {string} domain @param {string} server @param {string} kind
 *  @returns {string} */
function logFile(domain, server, kind) {
  return conf(join(paths.logs(), `${domain}.${server}.${kind}.log`));
}

/** @param {VhostInput} input @returns {string} */
function nginxVhost({ project, domain, root, runtime, cert, server, ports }) {
  const php = runtime.php ? fastcgiPort(runtime.php) : null;
  const isProxy = project.kind === "proxy" && project.proxyPort;

  const location = isProxy
    ? [
        "    location / {",
        `        proxy_pass http://127.0.0.1:${project.proxyPort};`,
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Real-IP $remote_addr;",
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        "        proxy_set_header X-Forwarded-Proto $scheme;",
        // A dev server that hot-reloads needs its websocket to survive.
        "        proxy_http_version 1.1;",
        "        proxy_set_header Upgrade $http_upgrade;",
        '        proxy_set_header Connection "upgrade";',
        "    }",
      ]
    : [
        "    location / {",
        "        try_files $uri $uri/ /index.php?$query_string;",
        "    }",
        ...(php
          ? [
              "",
              "    location ~ \\.php$ {",
              "        try_files $uri =404;",
              `        fastcgi_pass 127.0.0.1:${php};`,
              "        fastcgi_index index.php;",
              `        include "${conf(join(paths.conf("nginx"), "fastcgi_params"))}";`,
              "        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
              "        fastcgi_param PATH_INFO $fastcgi_path_info;",
              "        fastcgi_read_timeout 300;",
              "    }",
            ]
          : []),
        "",
        // Deny the dotfiles a document root should never serve. Cheap, and the
        // one that matters is .env.
        "    location ~ /\\.(?!well-known) { deny all; }",
      ];

  const common = [
    `    server_name ${domain} www.${domain};`,
    `    root "${conf(root)}";`,
    "    index index.php index.html index.htm;",
    "    charset utf-8;",
    `    access_log "${logFile(domain, server, "access")}";`,
    `    error_log "${logFile(domain, server, "error")}";`,
    "",
    ...location,
  ];

  const blocks = [
    "server {",
    `    listen ${ports.http};`,
    ...(cert ? [`    listen [::]:${ports.http};`] : []),
    ...common,
    "}",
  ];

  if (cert) {
    blocks.push(
      "",
      "server {",
      `    listen ${ports.https} ssl;`,
      `    listen [::]:${ports.https} ssl;`,
      "    http2 on;",
      `    ssl_certificate "${conf(cert.cert)}";`,
      `    ssl_certificate_key "${conf(cert.key)}";`,
      ...common,
      "}",
    );
  }

  return header(domain) + blocks.join("\n") + "\n";
}

/** @param {VhostInput} input @returns {string} */
function apacheVhost({ project, domain, root, runtime, cert, server, ports }) {
  const php = runtime.php ? fastcgiPort(runtime.php) : null;
  const isProxy = project.kind === "proxy" && project.proxyPort;

  const body = [
    `    ServerName ${domain}`,
    `    ServerAlias www.${domain}`,
    `    DocumentRoot "${conf(root)}"`,
    `    ErrorLog "${logFile(domain, server, "error")}"`,
    `    CustomLog "${logFile(domain, server, "access")}" common`,
    "",
    `    <Directory "${conf(root)}">`,
    "        Options Indexes FollowSymLinks",
    "        AllowOverride All",
    "        Require all granted",
    "    </Directory>",
  ];

  if (isProxy) {
    body.push(
      "",
      "    ProxyPreserveHost On",
      `    ProxyPass / http://127.0.0.1:${project.proxyPort}/`,
      `    ProxyPassReverse / http://127.0.0.1:${project.proxyPort}/`,
    );
  } else if (php) {
    body.push(
      "",
      // proxy_fcgi is how Apache talks to a FastCGI pool without mod_php, which
      // is what lets two PHP versions serve at the same time.
      `    <FilesMatch "\\.php$">`,
      `        SetHandler "proxy:fcgi://127.0.0.1:${php}"`,
      "    </FilesMatch>",
    );
  }

  const blocks = [`<VirtualHost *:${ports.http}>`, ...body, "</VirtualHost>"];

  if (cert) {
    blocks.push(
      "",
      `<VirtualHost *:${ports.https}>`,
      ...body,
      "",
      "    SSLEngine on",
      `    SSLCertificateFile "${conf(cert.cert)}"`,
      `    SSLCertificateKeyFile "${conf(cert.key)}"`,
      "</VirtualHost>",
    );
  }

  return header(domain) + blocks.join("\n") + "\n";
}

/** @param {string} domain @returns {string} */
function header(domain) {
  return [
    `# ${domain}`,
    "# Generated by the TEDI Dev Environment extension.",
    "# Edits are lost on the next change; configure the project in TEDI instead.",
    "",
  ].join("\n");
}

/**
 * The FastCGI parameters, written by us rather than included from the server's
 * own copy. Fixed by the protocol, identical in every nginx distribution, and
 * the one file whose absence would break PHP outright rather than degrade it.
 */
const FASTCGI_PARAMS = [
  "# Generated by the TEDI Dev Environment extension.",
  "fastcgi_param  QUERY_STRING       $query_string;",
  "fastcgi_param  REQUEST_METHOD     $request_method;",
  "fastcgi_param  CONTENT_TYPE       $content_type;",
  "fastcgi_param  CONTENT_LENGTH     $content_length;",
  "fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;",
  "fastcgi_param  REQUEST_URI        $request_uri;",
  "fastcgi_param  DOCUMENT_URI       $document_uri;",
  "fastcgi_param  DOCUMENT_ROOT      $document_root;",
  "fastcgi_param  SERVER_PROTOCOL    $server_protocol;",
  "fastcgi_param  REQUEST_SCHEME     $scheme;",
  "fastcgi_param  HTTPS              $https if_not_empty;",
  "fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;",
  "fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;",
  "fastcgi_param  REMOTE_ADDR        $remote_addr;",
  "fastcgi_param  REMOTE_PORT        $remote_port;",
  "fastcgi_param  SERVER_ADDR        $server_addr;",
  "fastcgi_param  SERVER_PORT        $server_port;",
  "fastcgi_param  SERVER_NAME        $server_name;",
  "fastcgi_param  REDIRECT_STATUS    200;",
  "",
].join("\n");

/**
 * Enough MIME types for a development site, for the case where nginx's own
 * `mime.types` could not be found.
 *
 * Without it nginx labels every response `application/octet-stream`, so the
 * stylesheet and the scripts are downloaded rather than applied and the site
 * renders as unstyled text - which looks like a broken application, not like a
 * missing config file.
 */
const FALLBACK_TYPES = [
  "    types {",
  "        text/html                             html htm;",
  "        text/css                              css;",
  "        text/javascript                       js mjs;",
  "        application/json                      json;",
  "        image/svg+xml                         svg svgz;",
  "        image/png                             png;",
  "        image/jpeg                            jpeg jpg;",
  "        image/gif                             gif;",
  "        image/webp                            webp;",
  "        image/avif                            avif;",
  "        image/x-icon                          ico;",
  "        font/woff                             woff;",
  "        font/woff2                            woff2;",
  "        application/pdf                       pdf;",
  "        application/wasm                      wasm;",
  "        text/plain                            txt;",
  "    }",
];

/**
 * The main nginx config. Everything project-specific is an include.
 *
 * @param {string | null} confDir  nginx's own `conf/`, or null when not found.
 * @param {{ http: number, https: number }} ports
 * @returns {string}
 */
function nginxMain(confDir, ports) {
  return [
    "# Generated by the TEDI Dev Environment extension.",
    `# Serving on ${ports.http}, and ${ports.https} for https.`,
    "worker_processes  1;",
    `error_log  "${conf(join(paths.logs(), "nginx.error.log"))}";`,
    `pid  "${conf(join(paths.run(), "nginx.pid"))}";`,
    "",
    "events {",
    "    worker_connections  1024;",
    "}",
    "",
    "http {",
    // Absolute, because a relative `include` resolves against the directory the
    // CONFIG FILE is in, not against the `-p` prefix - the opposite of what the
    // flag suggests. With our config under `<root>/conf/nginx/`, a bare
    // `include mime.types` looked for a file beside it and nginx refused to
    // start: `[emerg] CreateFile() "<root>/conf/nginx/mime.types" failed (2)`.
    ...(confDir ? [`    include       "${conf(join(confDir, "mime.types"))}";`] : FALLBACK_TYPES),
    "    default_type  application/octet-stream;",
    "    sendfile      on;",
    "    keepalive_timeout  65;",
    // Generous, because uploading a database dump through a web client is a
    // normal thing to do locally and the default 1m turns it into a 413.
    "    client_max_body_size 256m;",
    `    access_log  "${conf(join(paths.logs(), "nginx.access.log"))}";`,
    "",
    `    include "${conf(paths.vhosts("nginx"))}/*.conf";`,
    "}",
    "",
  ].join("\n");
}

/**
 * The main Apache config.
 *
 * @param {import("./serverroot.js").ApachePaths} ap
 * @param {{ http: number, https: number }} ports
 * @returns {string}
 */
function apacheMain(ap, ports) {
  return [
    "# Generated by the TEDI Dev Environment extension.",
    // ServerRoot must be a real directory that Apache can resolve its own
    // relative paths against. Everything this file writes is absolute, so the
    // only requirement on it is that it exists.
    `ServerRoot "${conf(ap.serverRoot)}"`,
    // Ours, because the compiled default is a system path an unprivileged
    // process cannot write, and Apache exits rather than start without it.
    `DefaultRuntimeDir "${conf(paths.run())}"`,
    `PidFile "${conf(join(paths.run(), "httpd.pid"))}"`,
    `ErrorLog "${conf(join(paths.logs(), "apache.error.log"))}"`,
    `Listen ${ports.http}`,
    ...(config.autoHttps ? [`Listen ${ports.https}`] : []),
    "",
    "# Only the modules the generated vhosts use, and only the ones this build",
    "# actually ships. See serverroot.js: a LoadModule naming a file that is not",
    "# there aborts startup, and the Windows build has no MPM or unixd module at",
    "# all because both are compiled in.",
    ...loadModuleLines(ap.modules, ap.modulesDir),
    "",
    "ServerName localhost",
    ...(ap.mimeTypes ? [`TypesConfig "${conf(ap.mimeTypes)}"`] : []),
    'LogFormat "%h %l %u %t \\"%r\\" %>s %b" common',
    "",
    "<Directory />",
    "    AllowOverride none",
    "    Require all denied",
    "</Directory>",
    "",
    `IncludeOptional "${conf(paths.vhosts("apache"))}/*.conf"`,
    "",
  ].join("\n");
}
