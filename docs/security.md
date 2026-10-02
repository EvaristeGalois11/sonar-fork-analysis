# Security

A pull request from a fork runs code you haven't reviewed. GitHub runs its build
without your secrets, which is why this action splits the work: the build, where
the pull request's code runs, has no Sonar token; the Sonar workflow has the
token but never runs that code. Everything the Sonar workflow takes from the
pull request is treated as hostile: the upload, which the pull request's build
produced, and the checkout, which holds the pull request's files.

## What the Sonar workflow does

It runs no build and no wrapper. It checks out the pull request, unpacks the
upload, and lets the Sonar scanner read the result. Along the way it:

- checks out the pull request's head itself, with the GitHub token only in Git's
  environment, never on disk, and with `origin` pointing at your repository;
- removes links in the checkout that lead out of it: the scanner follows links
  into directories, so a link to `/proc/self` would have it index and upload the
  scanner's own environment, token included;
- removes `sonar-project.properties` files, which the scanner would read
  unchecked;
- refuses an upload holding links or special files, and reads its settings
  through the same [allowlist](#what-the-fork-path-carries) the build applied;
- requires every path in the settings to resolve inside the checkout, or for
  build output inside the action's own directory, after following links;
- refuses settings the scanner would read differently from how they were
  checked: `${…}` placeholders, which the scanner expands
  (`${env.SONAR_TOKEN}`), path patterns, quotes, control characters, surrounding
  spaces, half of a Unicode character pair, and commas in settings that hold a
  single path;
- works out the module structure exactly as the scanner's engine does, and
  requires every module to come with a base directory inside the checkout;
- unpacks build output without overwriting sources or writing through links;
- sets the settings that decide where results go and what runs, overriding the
  upload: project key, analysed revision, working directory, and
  [what stays off](#what-stays-off-on-the-fork-path);
- runs the scanner in an empty directory of its own, with the Sonar token only
  in its environment, and without the action's inputs, the runner's internal
  tokens or the files through which a step talks to the runner.

## What the fork path carries

The build hands the Sonar workflow only the settings an analysis needs, by name:

- the project's structure: modules, sources, tests, binaries, libraries, base
  directories;
- reports: any setting named like a report path (`…reportPath`, `…reportPaths`,
  `…reportsPath`), so coverage, test results and external issues from any tool;
- per-language settings: file suffixes and patterns, activation, exclusions,
  language versions;
- inclusions, exclusions, issue exclusions and the project's name, description,
  version and links.

Never carried: the server, token, organization, region, project and module keys,
the working directory, scanner settings (`sonar.scanner.*`), branch and pull
request settings, SCM settings, anything that starts a program (JDBC drivers,
Node.js, C and C++ build wrappers, dependency analysis) and machine tuning such
as threads, memory and timeouts.

Report settings are carried by name, so a report of a tool Sonar adds later
needs no new release. Those named like a list (`…Paths`) are checked entry by
entry, which assumes the scanner reads them as lists, as all documented ones
are.

When the build leaves out a setting, it warns: _The analysis of pull requests
leaves out these settings_. If the analysis needs one, pass it with
`build-arguments` in the Sonar workflow, which is your own configuration and
trusted. When the Sonar workflow drops a setting from the upload, it warns:
_Dropped settings a build never ships_. An honest build never ships one, so the
upload was altered, or the two workflows run different versions of the action.

## What stays off on the fork path

Two Sonar features run the project's own build tools, which on the fork path are
the pull request's code, next to the token. The Sonar workflow always turns them
off:

- **Dependency analysis** (SCA, part of Sonar's Advanced Security) lists
  dependencies by running `mvnw`, `gradlew` or `npm`. Fork pull requests get no
  dependency analysis; pushes and pull requests from your repository, analysed
  directly, keep it. For pull request time dependency checks on forks, GitHub's
  [dependency review action](https://github.com/actions/dependency-review-action)
  runs on `pull_request`, without secrets.
- **Build-system autoconfiguration** (SonarQube Cloud's engine) can configure a
  project by running its `mvnw`.

Never turn them back on with `build-arguments` in the Sonar workflow, e.g.
`-Dsonar.sca.enabled=true`: that runs the pull request's build tools with your
token.

## What a fork can still influence

A fork controls its own pull request's code and build, so it controls that pull
request's analysis: it can fake coverage and test results, exclude files and
ignore issues, and nothing shows it. It can also suppress its own analysis. None
of it reaches other pull requests or your branches. Treat a fork's Sonar result
as information about the pull request, not as a review of it.

## Hardening your setup

- Trigger the build on `pull_request`, never on `pull_request_target`.
- Don't build fork pull requests on self-hosted runners that also run the Sonar
  workflow. A fork's build can tamper with what it leaves on the runner,
  including the scanner the action caches there and reuses; GitHub advises
  against self-hosted runners for public repositories in its
  [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
- Pin the action to a commit SHA.
- Give the Sonar job only the permissions in the [setup](../README.md#setup),
  and no secrets or steps the analysis doesn't need.
- Don't add caching to the Sonar job, and never give it write access to the
  cache with `cache-mode`: GitHub keeps `workflow_run` jobs to reading the
  default branch's cache, so nothing they handle can poison later builds.
- Use a dedicated Sonar token, see the [setup](../README.md#setup).
- For defence in depth, require approval to run workflows for all outside
  contributors (Settings → Actions → General). It isn't needed for the analysis
  to be safe.

With `checkout: false`, CodeQL may flag your own checkout step in the Sonar
workflow with `actions/untrusted-checkout`: checking out pull request code in a
privileged job. Nothing in that job runs the checked-out code, so the alert can
be dismissed with that reason; make sure no step you add changes that.

## Keeping up with the scanner

Sonar's scanner changes on Sonar's schedule, and its changes can matter here:
dependency analysis, build-system autoconfiguration and the engine's analytics,
which run `dotnet` in its working directory, all arrived that way. This project
checks on every pull request and weekly against the CLI it pins and the engines
SonarQube Cloud and the latest SonarQube Community Build serve:

- settings files and lists are read back exactly as the action checked them;
- the engine builds the same module structure and gives every setting to the
  same module;
- the engine classes that can start a process match a reviewed list.

Its own analysis of the test fixtures also sets traps: build tools on the
`PATH`, and the fixtures' wrappers and Gradle settings, fail the run if the
analysis ever starts them.

Older SonarQube Server versions and its commercial editions aren't checked.

## v1

v1 runs Maven or Gradle on the pull request's checkout in the job that holds the
Sonar token, so a fork can run code with the token. It gets no fixes: move to
v2.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
