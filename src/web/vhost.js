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

import { paths, join } from "../core/paths.js";
import { writeText, mkdirp, remove, readDir } from "../core/fsx.js";
import { config } from "../runtime.js";
import { domainOf, docRootOf } from "../project/projects.js";
import { resolveProject } from "../project/resolve.js";
import { installedOf } from "../manager/versions.js";
import { certificateFor } from "./certs.js";

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
 * Configuration for every enabled project, for the active server.
 *
 * @param {Project[]} projects
 * @returns {Promise<{ domains: string[], written: number }>}
 */
export async function generate(projects) {
  const server = config.webServer;
  const vhostDir = paths.vhosts(server);
  await mkdirp(vhostDir);

  // Clear stale vhosts: a renamed or removed project must stop being served,
  // and leaving its file behind would keep the old domain answering.
  for (const entry of await readDir(vhostDir, true)) {
    await remove(join(vhostDir, entry.name)).catch(() => {});
  }

  /** @type {string[]} */
  const domains = [];
  let written = 0;

  // nginx's OWN install directory. A relative `include` in an nginx config is
  // resolved against the directory the CONFIG FILE is in, not against the `-p`
  // prefix - the opposite of what the flag suggests and of what a comment here
  // used to claim. With our config living in `<root>/conf/nginx/`, both
  // `include mime.types` and `include fastcgi_params` looked for files beside
  // it and nginx refused to start:
  //   nginx: [emerg] CreateFile() "<root>/conf/nginx/mime.types" failed (2)
  // Naming nginx's own `conf/` absolutely is the fix.
  const nginxHome = installedOf("nginx")[0]?.dir ?? "";

  for (const project of projects) {
    if (project.enabled === false) continue;
    const domain = domainOf(project);
    const root = await docRootOf(project);
    const runtime = await resolveProject(project);
    const https = project.https ?? config.autoHttps;
    const cert = https ? await certificateFor([domain, `www.${domain}`]) : null;

    const body =
      server === "nginx"
        ? nginxVhost({ project, domain, root, runtime, cert, serverRoot: nginxHome })
        : apacheVhost({ project, domain, root, runtime, cert });

    await writeText(join(vhostDir, `${domain}.conf`), body);
    domains.push(domain);
    written++;
  }

  if (server === "nginx") {
    await writeText(join(paths.conf("nginx"), "nginx.conf"), nginxMain(nginxHome));
  } else {
    // ServerRoot must be the Apache INSTALL directory, not ours: that is where
    // `modules/*.so` and `conf/mime.types` live, and every LoadModule line below
    // is resolved relative to it. Pointing it at our conf tree produces
    // "Cannot load modules/mod_dir.so" and a server that never starts.
    const apacheHome = installedOf("apache")[0]?.dir ?? "";
    await writeText(join(paths.conf("apache"), "httpd.conf"), apacheMain(apacheHome));
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
 * @property {string} [serverRoot] The web server's own install directory, for
 *                                 the absolute includes its config needs.
 */

/** Forward slashes: both servers accept them on Windows and neither accepts an
 *  unescaped backslash inside a quoted path.
 *  @param {string} p @returns {string} */
function conf(p) {
  return String(p).replace(/\\/g, "/");
}

/** @param {VhostInput} input @returns {string} */
function nginxVhost({ project, domain, root, runtime, cert, serverRoot = "" }) {
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
              `        include "${conf(join(serverRoot, "conf", "fastcgi_params"))}";`,
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
    `    access_log "${conf(join(paths.logs(), `${domain}.access.log`))}";`,
    `    error_log "${conf(join(paths.logs(), `${domain}.error.log`))}";`,
    "",
    ...location,
  ];

  const blocks = [
    "server {",
    `    listen ${config.httpPort};`,
    ...(cert ? [`    listen [::]:${config.httpPort};`] : []),
    ...common,
    "}",
  ];

  if (cert) {
    blocks.push(
      "",
      "server {",
      `    listen ${config.httpsPort} ssl;`,
      `    listen [::]:${config.httpsPort} ssl;`,
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
function apacheVhost({ project, domain, root, runtime, cert }) {
  const php = runtime.php ? fastcgiPort(runtime.php) : null;
  const isProxy = project.kind === "proxy" && project.proxyPort;

  const body = [
    `    ServerName ${domain}`,
    `    ServerAlias www.${domain}`,
    `    DocumentRoot "${conf(root)}"`,
    `    ErrorLog "${conf(join(paths.logs(), `${domain}.error.log`))}"`,
    `    CustomLog "${conf(join(paths.logs(), `${domain}.access.log`))}" common`,
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

  const blocks = [`<VirtualHost *:${config.httpPort}>`, ...body, "</VirtualHost>"];

  if (cert) {
    blocks.push(
      "",
      `<VirtualHost *:${config.httpsPort}>`,
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

/** The main nginx config. Everything project-specific is an include.
 *  @returns {string} */
/** The main nginx config.
 *  @param {string} serverRoot nginx's own install directory.
 *  @returns {string} */
function nginxMain(serverRoot) {
  return [
    "# Generated by the TEDI Dev Environment extension.",
    "worker_processes  1;",
    `error_log  "${conf(join(paths.logs(), "nginx.error.log"))}";`,
    `pid  "${conf(join(paths.run(), "nginx.pid"))}";`,
    "",
    "events {",
    "    worker_connections  1024;",
    "}",
    "",
    "http {",
    `    include       "${conf(join(serverRoot, "conf", "mime.types"))}";`,
    "    default_type  application/octet-stream;",
    "    sendfile      on;",
    "    keepalive_timeout  65;",
    // Generous, because uploading a database dump through phpMyAdmin is a
    // normal thing to do locally and the default 1m turns it into a 413.
    "    client_max_body_size 256m;",
    `    access_log  "${conf(join(paths.logs(), "nginx.access.log"))}";`,
    "",
    `    include "${conf(paths.vhosts("nginx"))}/*.conf";`,
    "}",
    "",
  ].join("\n");
}

/** The main Apache config.
 *  @param {string} serverRoot Apache's own install directory.
 *  @returns {string} */
function apacheMain(serverRoot) {
  return [
    "# Generated by the TEDI Dev Environment extension.",
    `ServerRoot "${conf(serverRoot)}"`,
    `PidFile "${conf(join(paths.run(), "httpd.pid"))}"`,
    `Listen ${config.httpPort}`,
    ...(config.autoHttps ? [`Listen ${config.httpsPort}`] : []),
    "",
    "# Only the modules the generated vhosts actually use.",
    ...[
      "mpm_event_module modules/mod_mpm_event.so",
      "authz_core_module modules/mod_authz_core.so",
      "dir_module modules/mod_dir.so",
      "mime_module modules/mod_mime.so",
      "log_config_module modules/mod_log_config.so",
      "unixd_module modules/mod_unixd.so",
      "proxy_module modules/mod_proxy.so",
      "proxy_fcgi_module modules/mod_proxy_fcgi.so",
      "proxy_http_module modules/mod_proxy_http.so",
      "rewrite_module modules/mod_rewrite.so",
      "ssl_module modules/mod_ssl.so",
      "socache_shmcb_module modules/mod_socache_shmcb.so",
      "headers_module modules/mod_headers.so",
      "setenvif_module modules/mod_setenvif.so",
      "alias_module modules/mod_alias.so",
    ].map((m) => `LoadModule ${m}`),
    "",
    "ServerName localhost",
    "TypesConfig conf/mime.types",
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
