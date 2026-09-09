# Changelog

## 0.1.31

- **Every MySQL account action failed with a SQL syntax error.** Creating an
  account, changing its password and dropping one all reported
  `ERROR 1064 (42000) at line 1 ... near 'source D:/DEV ENV/internal/run/
accounts-<n>.sql'`. The SQL was written to a file and the file was run with
  `--execute "source <path>"`, and `source` is a command of the mysql CLIENT,
  not SQL: the client honours it only while reading a terminal or a pipe, and
  under `--execute` it forwards the whole line to the server, which of course
  cannot parse it. Checked against the shipped client rather than guessed: its
  short form is refused outright, `--named-commands` changes nothing, and a
  Windows path additionally trips the client's own backslash scanner. The SQL
  is passed straight to the client now, which is also what removes the
  temporary file, the cleanup around it, and the window where a file with a
  password in it existed on disk. The file was there to keep that password out
  of the process list, and it was worth nothing on a server initialised
  `--initialize-insecure`: `root` has no password at all, so anyone who can
  read the process list can simply connect as root.

- **A site with HTTPS on was also served, unredirected, over plain http.** So
  the address bar said "Not secure" on a site whose certificate was present,
  valid, correctly named and trusted, and re-trusting the local certificate
  authority could never fix it: the page being complained about was the http
  copy, not the https one. Port 80 now redirects to https for any site that has
  a certificate, keeping the hostname the visitor typed and the path and query
  they asked for, so an address entered without a scheme, an old bookmark and a
  plain link all end up on the secure copy. It is a temporary redirect on
  purpose: a permanent one is cached until the visitor clears it by hand, and
  turning HTTPS back off would then leave every browser that had visited
  bouncing to a port that no longer answers. With HTTPS off nothing changes and
  port 80 serves the site as before.

- **The panel fits the space it is given.** Every row was laid out as three
  columns that could not give: a fixed identity column, the version controls,
  and a button group that kept its full width whatever happened. In a full-width
  tab that is exactly right, and it was the only place it was ever seen. Put the
  same panel in a canvas window, a split, or a narrow side pane and the row ran
  off the edge - a project row wants around 850px and got 420, so the buttons
  that Enable and Remove it sat past the right edge behind a horizontal
  scrollbar. Rows now wrap: the identity stays on the first line, the version
  controls and the buttons drop underneath as the space runs out, and the pane
  reads the same at 260px as it does at 1200. Nothing moves at the width it was
  designed for.

- **A setup step no longer leaves its state behind.** The status glyph, the icon
  and the words were three separate items on the row, so the moment the row
  wrapped the two 13px glyphs fitted on a line the sentence beside them did not,
  and the tick that says whether the step is done ended up stranded above the
  title it describes. They are one block now, the way every other row in the
  panel is built.

## 0.1.30

- **"Stop all" left one service running and said it had not.** It picked the
  services to stop by asking which ones it holds a process handle for, and a
  service adopted after a crash or a restart has a pid and no handle. So the
  one thing still holding port 80 was exactly the one it skipped, the button
  reported success, and the next "Start all" failed with "Port 80 is already in
  use" - a conflict with a service the button beside it had just promised to
  stop. It now stops everything that is up, however it got there, and says
  plainly what survived being asked.

- **It asks first.** Stopping everything takes every site down at once, and it
  was a single unguarded click among the buttons you press all day. There is now
  the same confirmation the other destructive actions use, naming the services
  it is about to stop, and the button shows it is working until they are.

- **The loading spinner is a circle whatever the surrounding CSS believes.**
  The animation sits on the fixed-size icon slot, and the glyph inside it kept
  whatever size it was rendered at. It is a flex item, so a stylesheet setting
  a height the slot does not share leaves it stretched: a 13px slot under a rule
  forcing 16px-tall icons draws a 13x16 ellipse, and a rotating ellipse swells
  and shrinks instead of turning. The glyph now fills its slot exactly, and one
  helper starts every spin in this pane, so a new one cannot be added without
  the origin that keeps it steady.

## 0.1.29

- **The database drivers are on out of the box.** PHP ships `mysqli`,
  `pdo_mysql`, `pgsql` and `pdo_pgsql` compiled but commented out, so a brand
  new environment could not reach the MySQL it had just installed - and what a
  project reports for a missing driver ("could not find driver") names nothing
  you can act on. A fresh php.ini turns them on, and this release turns them on
  once for the PHPs you already had. Once: after that, switching one off is your
  decision and nothing here argues with it.

- **The extension list has a search box.** A working PHP lists sixty-odd
  extensions in a grid, and "is pdo_pgsql on?" was a question you answered by
  reading all of them. It filters what is already loaded, so typing costs
  nothing, and the count above follows the filter.

- **A failed service tints its status-bar icon instead of adding a red dot.**
  Needs the next TEDI release; the change is in core, not here.

## 0.1.28

- **PHP has never worked under Apache on Windows, and does now.** Three separate
  faults, each hiding the next. The generated config used
  `SetHandler proxy:fcgi://host:port`, which makes Apache append the
  filesystem path to that URL - and on Windows a path starts with a drive
  letter, so `...:9000` + `D:/...` parsed as the host `127.0.0.1:9000d` and
  every request died with a DNS lookup failure. Naming the document root in a
  `ProxyPassMatch` fixes that, but then `SCRIPT_FILENAME` reaches php-cgi as
  the whole proxy URL and it answers "No input file specified", so it is
  rebuilt from the document root and the script name - the same value nginx
  sends. And there was no `DirectoryIndex`, so a directory never resolved to
  `index.php` at all.

- **Starting a web server starts the PHP it needs.** The pools were started by
  **Start all** and by nothing else, so a server started from its own row had
  nothing listening on the FastCGI port and failed every `.php` while looking
  perfectly healthy.

- **Everything that writes vhosts asks the same question.** `publish` served the
  projects plus the tools this extension installs; a web server's own start
  served only the projects - and starting a server REGENERATES its vhosts, so
  every start silently deleted the vhost the publish before it had just
  written. That is why phpMyAdmin resolved to another site: its config was
  removed by the restart that was meant to load it.

- **A partial generate can no longer truncate a server's config.** The vhost
  directory was cleared before anything was rendered, so a failure left fewer
  sites than before - and every caller swallowed the error. Bodies are rendered
  first, and a failed publish now says so instead of returning quietly.

## 0.1.27

- **A new site resolved to an old one.** `phpmyadmin.test` served the first
  project instead of phpMyAdmin, because every vhost was regenerated and then
  the **configured** web server was reloaded - which was not the one answering
  on port 80. Those two are not always the same: recovery adopts whichever
  server it finds still running whatever the setting says, and either can be
  started from its own row. A server that is never reloaded keeps serving the
  config it started with, so a domain it has never heard of falls through to
  whichever vhost happens to be first. Publishing reloads whatever is up.

- **Recovery runs before the startup republish.** The republish added in 0.1.26
  ran first, which meant it regenerated every config and then found nothing
  running to reload - the exact failure above, on every launch. Recovery puts
  the running server on the books, and the republish then reaches it.

## 0.1.26

- **The hosts file could be emptied, and was.** Nothing resolved - not
  `phpmyadmin.test`, not any project - because the file had been written to zero
  bytes. Three things lined up: `applyHosts` read it TWICE and checked "could I
  read it" only on the first, so a failed second read rendered a file containing
  nothing but this extension's own block and the machine's own entries went with
  it; then, with nothing left around the block and no domains to put in it, the
  render was a single newline; and a PowerShell here-string turns a single
  newline into the empty string, which `Set-Content -NoNewline` writes as no
  bytes at all.

  One read now, checked once, and a guard that refuses any write which would
  leave the file blank or drop the lines around our block. That guard is the
  part that matters: the elevated writer replaces the file wholesale, so
  anything wrong upstream of it arrives as deletion.

- **The environment repairs itself at launch.** A vhost that was never written,
  a certificate that was never issued, a hosts file missing its block: all of it
  is republished when the pane starts. Nothing is missing on an ordinary launch,
  so nothing is asked and no prompt appears - the administrator prompt shows up
  only when there is genuinely something to put back.

## 0.1.25

- **Checking for versions stays on the button that asked.** Pressing Install
  replaced the row's state - "running" became "Checking available versions" -
  greyed out the Stop button beside it, and breathed the setup checklist, all
  for a metadata request that takes a second. Stop stays Stop, the row keeps
  saying what the service is doing, and only the Install icon spins. Same in
  Runtimes, so **Install everything** no longer reports a version lookup as
  progress on a component.

- **A failed Apache Lounge lookup is no longer cached.** An empty `Map` is
  truthy, so one unreachable moment left the version list empty for the rest of
  the session and only a restart brought it back. It is asked again on the next
  press, and the message says the site may be unreachable rather than implying
  there is nothing to install.

  Worth stating: Apache Lounge publishes only the CURRENT build on that page, so
  one or two versions is the honest answer for Apache even when everything
  works - unlike PHP, Node or nginx, which list their whole history.

## 0.1.24

- **The settings rows lay out properly.** Text is the only thing in a row that
  can wrap, so under a flex default it was the only thing that gave: the
  phpMyAdmin row squeezed its description down to one word per line while the
  buttons beside it kept their full width. The label takes the space and the
  controls take none.

- **Open phpMyAdmin sits beside Open in SQL Explorer**, on the MySQL row, where
  the other "show me this database" button already is. It was in the settings
  dialog, which is where you go to change something rather than to use it - and
  it was the fifth control on a row that had four too many.

## 0.1.23

- **Creating a MySQL account failed with `Unknown command '\D'`.** The SQL is
  handed to the client as a file, and the path was a Windows one: a backslash
  path reaches the client's own backslash-command parser, which
  reads `\D` as a command it does not know and refuses the whole statement. The
  path is written with forward slashes, which every platform's client accepts,
  and the space in it still survives.

- **phpMyAdmin is no longer one of your projects.** It was installed into `www/`
  and registered like your own work, where Disable and Remove offered to do
  things to it that mean nothing, and a **Refresh** would adopt it all over
  again. It lives under `tools/` now and is served without being a project at
  all: `publish` appends a row for it that exists for the length of one publish,
  so it still gets its own domain, certificate and hosts entry. A copy left in
  `www/` by 0.1.22 is cleared away on the next launch - but only when its
  `config.inc.php` carries the line the installer wrote, so a folder you put
  there yourself is left exactly where it is.

- **The version is yours to pick**, from the list phpmyadmin.net publishes -
  they support more than one branch at a time, and the newest is often the one
  that will not run on the PHP this environment installs. The row shows which
  version is installed, opens it in your browser, and can remove it.

- **A Browser button on every project row.** The URL was already a link, and
  inside the app a link is a small target to aim at; this is the same
  destination as a button, beside the one that opens the folder.

## 0.1.22

- **MySQL accounts.** Behind the gear on the MySQL row: who may connect and from
  where, a password you can change, and new accounts with or without every
  privilege. This environment starts with `root` and no password, which is right
  for loopback and wrong for anything you hand to someone else. The SQL is
  written to a file rather than passed on a command line, because
  `IDENTIFIED BY '<password>'` in an argument list is readable by every other
  user on the machine for as long as it runs.

- **phpMyAdmin**, installed from the same gear and served as one of your
  projects - so it gets a domain, a certificate and a hosts entry from the
  machinery that was already there, and **Open** puts it in your browser. Its
  config is pointed at the managed MySQL and rewritten whenever that port moves.
  If the release does not support the PHP you are on, the row says so before the
  download rather than after.

- **Open in SQL Explorer**, on the MySQL and PostgreSQL rows, when that
  extension is installed. The connection details already reached it - they are
  published to `~/.tedi/dev-environment.json` - and this is the last step that
  was missing. It reads that file when its panel opens now, so a database you
  installed a minute ago is there without a restart. Needs TEDI 0.4.48; on an
  older host, or without that extension, the button is simply absent.

- **Dead code out.** Nine exports nothing imported, three of them functions
  nothing called at all: an architecture helper superseded by the registry's
  own, an error logger superseded by `warn`, and a port survey superseded by the
  port on each row. One project URL instead of two copies of the same
  scheme-and-port rule, one labelled-setting row instead of three, and the
  phpMyAdmin unpack uses the archive helper every other download already used.

## 0.1.21

- **A name beside its status glyph sits level with it.** The project name read
  low against its tick, and so did a scheduled job's. Two causes, both worth
  fixing where they were rather than nudging a margin: an icon's slot is a fixed
  box and the glyph the host renders into it was never centred inside it, so
  every row that puts text next to an icon inherited the offset; and a bold name
  carried `line-height: 1.35`, which is a 16px box around 12px of text - centring
  that against a 13px glyph centres two boxes of different heights, and the text
  is what looks wrong. A long name now truncates with an ellipsis instead of
  pushing the row, too.

## 0.1.20

- **The status icon's breathing state is one you can actually see.** It was on
  "starting", which lasts a few hundred milliseconds and so was never on screen.
  It is on downloading now, which is minutes. Four states, in the order you
  would want them at a glance: something in flight breathes, something broken
  shows a red dot, something merely running is lit, nothing is dim - and the
  tooltip says which, including the download's own progress.

  One funnel writes that progress, rather than the nine call sites that wrote it
  before: the bar sits outside every view, so it cannot learn a download started
  from a repaint, and a call site that forgot would silently stop the pulse.

## 0.1.19

- **The status-bar icon reports three states, not two.** Breathing while a
  service is coming up, lit once something is running, dim when nothing is - and
  the tooltip names what. Dim is an answer rather than an absence, because the
  icon is always there.

  The two little LEDs on the server glyph cannot be lit separately, however much
  they look like they were drawn for it: the host paints an extension's status
  icon as a single-colour mask, so nothing inside the shape can carry its own
  colour or its own animation. Three states is what the mechanism actually
  offers, so that is what it says.

## 0.1.18

- **Stopping the process on a port does exactly that, and nothing else.** It
  used to free the port and then start the service, which looked helpful and was
  not: one button doing two things means that when the second one fails there is
  no way to tell which half went wrong, and a service that starts and then stops
  on its own reads as "the Stop button broke it". Press Start and see what Start
  says.

- **"It stopped by itself" now says why.** A service that exits without being
  asked to went quietly back to "stopped", which is the least useful thing it
  could say: the reason was sitting in a buffer nobody read. The process's own
  last words go on the row instead, the same way a failed start already reports
  them.

- **The status-bar icon lights up while anything is running**, in the app's own
  active tint, and its tooltip names what. It follows the same state change the
  pane does rather than the poll, because the poll only runs while a pane is
  open - which is exactly when the bar is not the thing you are looking at.

## 0.1.17

- **Stopping the process that holds a port now actually stops it.** nginx is a
  master plus workers, and the listening socket belongs to a **worker** - so
  killing the pid the OS reports left the master to spawn a replacement, which
  inherited the socket. The port was never released and the button looked
  broken. The lookup walks up the parent chain while the parent is running the
  same executable, and stops at the master. Apache, MySQL and PHP-FPM all have
  the same shape.

  Found by driving a real nginx rather than by reading: which process the OS
  names for a socket is not something the code can tell you.

- **The walk stops where it should.** A protected system process reports no
  executable path to an unelevated query, and comparing two empty paths said
  "same binary" for every parent - so a walk from `svchost.exe` climbed through
  `services.exe` to `wininit.exe`, and the button would have offered to end
  that. It compares the full path when there is one and the image name when
  there is not, and refuses to walk when it has neither.

## 0.1.16

- **"Port 80 is already in use" now says by what, and offers to stop it.** That
  sentence was true and useless: it named the problem and nothing you could act
  on. The pane asks the operating system which process is listening - `netstat`
  and `tasklist` on Windows, `lsof` or `ss` elsewhere - and puts the name and
  pid in the message. Beside it is a button that stops that process and starts
  the service, behind a confirmation naming exactly what is about to be ended.
  The button only exists when the OS actually named the process, because "stop
  whatever has port 80" is not something anyone should press blind. Stopping is
  attempted as you first, and only escalates to administrator rights if that is
  refused.

- **Recovery after a crash.** TEDI closing normally stops these services; TEDI
  being killed does not, on the platforms where a child outlives its parent.
  The symptom was a dashboard reading "stopped" over a MySQL that was very much
  running, and a Start that then failed on its own port. Anything still up is
  taken back over at launch, and can be stopped from the pane as usual even
  though the handle that owned it died with the app.

  Adoption is only ever on proof, never on a guess: something is listening on
  the port the service would use, **and** the process holding it is running the
  exact binary the service would have launched. A name match would not do -
  plenty of people have their own nginx - because the cost of being wrong is a
  Stop button that kills a server this extension never started.

- **The port field in the settings dialog is wider.**

## 0.1.15

- **One tick per row, meaning the same thing everywhere.** It says what **Start
  all** brings up. On a web server it is also exclusive - the ticked one is the
  one your project URLs point at - so **Use this** and the `default` pill are
  gone, because two controls saying the same thing are two controls to keep in
  agreement. Unticking the serving web server does nothing: nginx and Apache
  cannot both hold port 80, so there is no state where neither is chosen.

- **The scheduler stays off until you ask for it.** It fires jobs - a queue
  worker, a backup, a deploy - so a scheduler that comes up because you pressed
  **Start all** is exactly the one that surprises you at 3am. Every other
  service defaults to on, because a server sitting on a port waiting to be asked
  something is harmless to have running. Tick Cron and it joins the rest.

## 0.1.14

- **Start all starts what you tick.** MySQL and PostgreSQL run side by side
  perfectly happily, which is exactly why this was wrong: **Start all** brought
  up every database that was installed, so anyone who had tried both ended up
  with a second one running and holding its port on every press. Each service
  row has a tick now. Unticked means **Start all** skips it; its own Start
  button still works. Absent means included, so an environment that never
  touches this starts exactly what it always did. The web servers have no tick,
  because which of those comes up is already **Use this** and two controls that
  could disagree would make **Start all** answerable two ways.

- **Ports and HTTPS are behind a gear, not on the row.** A web server carried
  three inputs and a switch inline, which is a form, and a form does not belong
  wedged between a version dropdown and a Start button on every one of six
  rows. The gear opens the settings for that one service; the row keeps the
  port as a fact, because the number is worth a glance even when you are not
  changing it. A running service shows its ports as bound rather than offering
  them for editing, which is what it always did.

## 0.1.13

- **No console window flashes over the app.** Everything this extension spawns
  goes through the host, which sets `CREATE_NO_WINDOW`, with exactly one
  exception: the elevated step that writes the hosts file. It is started with
  the `RunAs` verb, which goes out through ShellExecute into a brand new
  process that inherits none of that, so adding a project flashed a full
  PowerShell window while it wrote three lines. It is hidden now. The
  administrator prompt still appears, and should: that is the part you are
  meant to see and agree to.

- **Switching web server, or changing a port, no longer asks for administrator
  rights.** The hosts file holds one thing: project domains pointed at
  127.0.0.1. Which server serves them, on which port, over HTTP or HTTPS, is
  not in it. Every publish from the Services section skipped straight past that
  and asked for a hosts sync anyway, so pressing **Use this** could raise a UAC
  prompt that the thing you pressed cannot explain. Adding, removing, renaming
  or disabling a project still syncs, because those are the changes the file
  actually records.

## 0.1.12

- **One loading glyph, everywhere.** The pane had three ideas of "working" at
  once: a breathing ring on a service row, a spinning Play triangle on the
  button beside it, and a plain idle circle on the setup step that was actually
  running the download. A rotating triangle is not a thing loading, it is a
  thing gone wrong. A button now **swaps** its icon for the loading one rather
  than spinning whatever it already has, it is the same `LoaderCircle` the row
  next to it draws, and the Runtimes row - the one row type without a status
  glyph at all - has one.

- **A service says "starting" the moment it starts.** The state was only
  reaching the screen on the next four-second poll, so a start sat there
  claiming "stopped" for its whole duration while the button beside it already
  showed a spinner. It repaints on a real state change now, and the Start button
  holds its spinner across that repaint instead of snapping back to Play.

- **A live check can skip.** Apache Lounge being unreachable is not this
  extension being broken, and a check that cannot tell the difference gets
  ignored the third time it goes red for a reason nobody here can fix. An empty
  build list now asks whether the site answered at all before deciding which of
  those it is saying.

## 0.1.11

- **A terminal in any project, from its row.** TEDI's own terminal, opened in
  that project's folder, so `php`, `node`, `npm` and `composer` in it are the
  versions that project asks for - which only works in the app's shell, because
  the shims this extension puts on the terminal PATH are what does the
  resolving. Needs TEDI 0.4.47, which added `ctx.tabs.openTerminal`; on an older
  host the button is simply not there rather than the extension refusing to
  install.

- **New project makes the folder.** It was a folder picker, and a picker is the
  wrong dialog for what people actually do: they are not finding an existing
  project, they are starting one. Type a name, get `www/<name>` with its virtual
  host, certificate and hosts entry, live before an editor is open. **Refresh**
  replaces **Scan** beside it and looks only in `www` - the picker asked WHERE
  every time and the answer was always the same folder.

- **Every folder in `www` is a project, marker file or not.** The scan looked
  for a `composer.json`, a `package.json`, an `artisan`, which was right while
  it scanned any folder you pointed it at and wrong once it only ever scans this
  environment's own `www`. A folder in there is a project because of where it
  is. The case that made it obvious: the empty one you just created and are
  about to clone into, which the scan reported as "nothing new" thirty seconds
  after you made it. `node_modules`, `vendor` and dotfolders are still skipped.

- **Start, Stop, Restart, Enable and Disable are coloured and carry an icon**, in
  the pane's own status triad rather than a second vocabulary: green goes, red
  stops, amber is the state in between. So Start reads as Start before the word
  does, and Stop and Disable are the two you cannot press by accident while
  looking somewhere else.

- **A button says it is working.** Every handler in this pane is async and most
  reach the network or the disk, and the button already knows exactly when that
  starts and ends - so its icon spins for as long as it runs. "Install Xdebug"
  downloads a DLL and rewrites php.ini, and looked frozen for every second of
  it.

- **Settings is a dialog off the header**, not a section at the bottom. A pane
  you scroll past the runtimes, the services and every project to reach is a
  pane whose last screenful is furniture, and these two are changed about twice
  a year.

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
